import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type {
  CreateOidcClientInput,
  OidcClientConfig,
  UpdateOidcClientInput,
} from "./types.js";
import {
  parseCreateClient,
  parseUpdateClient,
  persistedClientSchema,
} from "./validation.js";

export class ClientConflictError extends Error {}
export class ClientNotFoundError extends Error {}
export class ClientValidationError extends Error {
  constructor(
    readonly clientId: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ClientValidationError";
  }
}

export const defaultClients = (): OidcClientConfig[] => [
  {
    clientId: "mock-public-client",
    clientType: "PUBLIC",
    tokenEndpointAuthMethod: "none",
    redirectUris: ["http://localhost:3000/callback"],
    postLogoutRedirectUris: [],
    accessTokenAudience: "urn:mock-api",
  },
  {
    clientId: "mock-confidential-client",
    clientType: "CONFIDENTIAL",
    clientSecret: "mock-client-secret-change-me",
    tokenEndpointAuthMethod: "client_secret_basic",
    redirectUris: ["http://localhost:3000/callback"],
    postLogoutRedirectUris: [],
    accessTokenAudience: "urn:mock-api",
  },
];

type ApplyClient = (client: OidcClientConfig) => Promise<void>;
type RemoveClient = (clientId: string) => Promise<void>;
export type ValidateClient = (client: OidcClientConfig) => void | Promise<void>;

export class OidcClientStore {
  #clients = new Map<string, OidcClientConfig>();
  #queue: Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly applyClient: ApplyClient,
    private readonly removeClient: RemoveClient,
    private readonly validateClient: ValidateClient = () => undefined,
  ) {}

  async initialize(): Promise<void> {
    let clients: OidcClientConfig[];
    let migrated = false;
    let missing = false;
    try {
      const raw: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      migrated =
        Array.isArray(raw) &&
        raw.some(
          (client) =>
            typeof client === "object" && client !== null && "scopes" in client,
        );
      clients = z.array(persistedClientSchema).parse(raw) as OidcClientConfig[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      clients = defaultClients();
      missing = true;
    }
    const ids = new Set<string>();
    for (const client of clients) {
      if (ids.has(client.clientId))
        throw new Error(
          `duplicate client_id in ${this.filePath}: ${client.clientId}`,
        );
      ids.add(client.clientId);
    }
    await this.validateClients(clients);

    const temporary =
      missing || migrated ? await this.stage(clients) : undefined;
    try {
      await this.applyInitialClients(clients);
      if (temporary)
        try {
          await rename(temporary, this.filePath);
        } catch (error) {
          await this.rollbackAndThrow(error, () =>
            this.removeProviderClients(
              clients.map((client) => client.clientId),
              "failed to roll back initial provider clients",
            ),
          );
        }
      this.#clients = new Map(
        clients.map((client) => [client.clientId, client]),
      );
    } finally {
      if (temporary) await this.discard(temporary);
    }
  }

  list(): OidcClientConfig[] {
    return [...this.#clients.values()].map((client) => structuredClone(client));
  }

  async create(input: CreateOidcClientInput): Promise<OidcClientConfig> {
    const client = parseCreateClient(input);
    return this.mutate(async () => {
      if (this.#clients.has(client.clientId))
        throw new ClientConflictError(
          `client already exists: ${client.clientId}`,
        );
      const next = new Map(this.#clients).set(client.clientId, client);
      await this.commit(
        next,
        () => this.applyClient(structuredClone(client)),
        () => this.removeClient(client.clientId),
      );
      return structuredClone(client);
    });
  }

  async update(
    clientId: string,
    input: UpdateOidcClientInput,
  ): Promise<OidcClientConfig> {
    const update = parseUpdateClient(input);
    return this.mutate(async () => {
      const previous = this.#clients.get(clientId);
      if (!previous)
        throw new ClientNotFoundError(`client not found: ${clientId}`);
      const client = { clientId, ...update };
      const next = new Map(this.#clients).set(clientId, client);
      await this.commit(
        next,
        () => this.applyClient(structuredClone(client)),
        () => this.applyClient(structuredClone(previous)),
      );
      return structuredClone(client);
    });
  }

  async delete(clientId: string): Promise<void> {
    return this.mutate(async () => {
      const previous = this.#clients.get(clientId);
      if (!previous)
        throw new ClientNotFoundError(`client not found: ${clientId}`);
      const next = new Map(this.#clients);
      next.delete(clientId);
      await this.commit(
        next,
        () => this.removeClient(clientId),
        () => this.applyClient(structuredClone(previous)),
      );
    });
  }

  async reset(): Promise<OidcClientConfig[]> {
    return this.mutate(async () => {
      const clients = defaultClients();
      const previous = [...this.#clients.values()];
      const next = new Map(clients.map((client) => [client.clientId, client]));
      await this.commit(
        next,
        async () => {
          for (const clientId of this.#clients.keys())
            await this.removeClient(clientId);
          for (const client of clients)
            await this.applyClient(structuredClone(client));
        },
        () => this.restoreProvider(previous, clients),
      );
      return this.list();
    });
  }

  private async applyInitialClients(
    clients: OidcClientConfig[],
  ): Promise<void> {
    const attemptedIds: string[] = [];
    try {
      for (const client of clients) {
        attemptedIds.push(client.clientId);
        await this.applyClient(structuredClone(client));
      }
    } catch (error) {
      await this.rollbackAndThrow(error, () =>
        this.removeProviderClients(
          attemptedIds,
          "failed to roll back initial provider clients",
        ),
      );
    }
  }

  private async removeProviderClients(
    clientIds: Iterable<string>,
    failureMessage: string,
  ): Promise<void> {
    const failures: unknown[] = [];
    for (const clientId of clientIds)
      try {
        await this.removeClient(clientId);
      } catch (error) {
        failures.push(error);
      }
    if (failures.length) throw new AggregateError(failures, failureMessage);
  }

  private async commit(
    next: Map<string, OidcClientConfig>,
    updateProvider: () => Promise<void>,
    rollbackProvider: () => Promise<void>,
  ): Promise<void> {
    const clients = [...next.values()];
    await this.validateClients(clients);
    const temporary = await this.stage(clients);
    try {
      try {
        await updateProvider();
      } catch (error) {
        await this.rollbackAndThrow(error, rollbackProvider);
      }
      try {
        await rename(temporary, this.filePath);
      } catch (error) {
        await this.rollbackAndThrow(error, rollbackProvider);
      }
      this.#clients = next;
    } finally {
      await this.discard(temporary);
    }
  }

  private async validateClients(clients: OidcClientConfig[]): Promise<void> {
    for (const client of clients)
      try {
        await this.validateClient(structuredClone(client));
      } catch (error) {
        throw new ClientValidationError(client.clientId, error);
      }
  }

  private async restoreProvider(
    previous: OidcClientConfig[],
    candidate: OidcClientConfig[],
  ): Promise<void> {
    const failures: unknown[] = [];
    const ids = new Set([
      ...previous.map((client) => client.clientId),
      ...candidate.map((client) => client.clientId),
    ]);
    for (const clientId of ids)
      try {
        await this.removeClient(clientId);
      } catch (error) {
        failures.push(error);
      }
    for (const client of previous)
      try {
        await this.applyClient(structuredClone(client));
      } catch (error) {
        failures.push(error);
      }
    if (failures.length)
      throw new AggregateError(failures, "failed to restore provider clients");
  }

  private async rollbackAndThrow(
    error: unknown,
    rollback: () => Promise<void>,
  ): Promise<never> {
    const operationError =
      error instanceof Error ? error : new Error(String(error));
    try {
      await rollback();
    } catch (rollbackError) {
      throw new AggregateError(
        [operationError, rollbackError],
        operationError.message,
        { cause: operationError },
      );
    }
    throw operationError;
  }

  private async stage(clients: OidcClientConfig[]): Promise<string> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(clients, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      await chmod(temporary, 0o600);
      return temporary;
    } catch (error) {
      try {
        await this.discard(temporary);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "failed to stage clients",
          {
            cause: error,
          },
        );
      }
      throw error;
    }
  }

  private async discard(temporary: string): Promise<void> {
    try {
      await unlink(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#queue;
    let release!: () => void;
    this.#queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
