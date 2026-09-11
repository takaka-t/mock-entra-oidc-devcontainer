import { z } from "zod";
import {
  commitStagedFile,
  discardStagedFile,
  readJsonFile,
  SerialQueue,
  stageJsonFile,
} from "../persistence/json-file.js";
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
    accessTokenScope: "access_as_user",
    emailOptionalClaim: false,
  },
  {
    clientId: "mock-confidential-client",
    clientType: "CONFIDENTIAL",
    clientSecret: "mock-client-secret-change-me",
    tokenEndpointAuthMethod: "client_secret_basic",
    redirectUris: ["http://localhost:3000/callback"],
    postLogoutRedirectUris: [],
    accessTokenAudience: "urn:mock-api",
    accessTokenScope: "access_as_user",
    emailOptionalClaim: false,
  },
];

type ApplyClient = (client: OidcClientConfig) => Promise<void>;
type RemoveClient = (clientId: string) => Promise<void>;
export type ValidateClient = (client: OidcClientConfig) => void | Promise<void>;

export class OidcClientStore {
  #clients = new Map<string, OidcClientConfig>();
  readonly #queue = new SerialQueue();

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
    const contents = await readJsonFile(this.filePath);
    if (contents.exists) {
      const raw = contents.value;
      migrated =
        Array.isArray(raw) &&
        raw.some(
          (client) =>
            typeof client === "object" && client !== null && "scopes" in client,
        );
      clients = z.array(persistedClientSchema).parse(raw) as OidcClientConfig[];
    } else {
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
      missing || migrated
        ? await stageJsonFile(this.filePath, clients)
        : undefined;
    try {
      await this.applyInitialClients(clients);
      if (temporary)
        try {
          await commitStagedFile(temporary, this.filePath);
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
      if (temporary) await discardStagedFile(temporary);
    }
  }

  list(): OidcClientConfig[] {
    return [...this.#clients.values()].map((client) => structuredClone(client));
  }

  async create(input: CreateOidcClientInput): Promise<OidcClientConfig> {
    const client = parseCreateClient(input);
    return this.#queue.run(async () => {
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
    return this.#queue.run(async () => {
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
    return this.#queue.run(async () => {
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
    return this.#queue.run(async () => {
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
    const temporary = await stageJsonFile(this.filePath, clients);
    try {
      try {
        await updateProvider();
      } catch (error) {
        await this.rollbackAndThrow(error, rollbackProvider);
      }
      try {
        await commitStagedFile(temporary, this.filePath);
      } catch (error) {
        await this.rollbackAndThrow(error, rollbackProvider);
      }
      this.#clients = next;
    } finally {
      await discardStagedFile(temporary);
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
}
