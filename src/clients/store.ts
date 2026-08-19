import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

export class OidcClientStore {
  #clients = new Map<string, OidcClientConfig>();
  #queue: Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly applyClient: ApplyClient,
    private readonly removeClient: RemoveClient,
  ) {}

  async initialize(): Promise<void> {
    let clients: OidcClientConfig[];
    let migrated = false;
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
      await this.persist(clients);
    }
    const ids = new Set<string>();
    for (const client of clients) {
      if (ids.has(client.clientId))
        throw new Error(
          `duplicate client_id in ${this.filePath}: ${client.clientId}`,
        );
      ids.add(client.clientId);
      await this.applyClient(client);
    }
    if (migrated) await this.persist(clients);
    this.#clients = new Map(clients.map((client) => [client.clientId, client]));
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
      await this.persist([...next.values()]);
      await this.applyClient(client);
      this.#clients = next;
      return structuredClone(client);
    });
  }

  async update(
    clientId: string,
    input: UpdateOidcClientInput,
  ): Promise<OidcClientConfig> {
    const update = parseUpdateClient(input);
    return this.mutate(async () => {
      if (!this.#clients.has(clientId))
        throw new ClientNotFoundError(`client not found: ${clientId}`);
      const client = { clientId, ...update };
      const next = new Map(this.#clients).set(clientId, client);
      await this.persist([...next.values()]);
      await this.applyClient(client);
      this.#clients = next;
      return structuredClone(client);
    });
  }

  async delete(clientId: string): Promise<void> {
    return this.mutate(async () => {
      if (!this.#clients.has(clientId))
        throw new ClientNotFoundError(`client not found: ${clientId}`);
      const next = new Map(this.#clients);
      next.delete(clientId);
      await this.persist([...next.values()]);
      await this.removeClient(clientId);
      this.#clients = next;
    });
  }

  async reset(): Promise<OidcClientConfig[]> {
    return this.mutate(async () => {
      const clients = defaultClients();
      await this.persist(clients);
      for (const clientId of this.#clients.keys())
        await this.removeClient(clientId);
      for (const client of clients) await this.applyClient(client);
      this.#clients = new Map(
        clients.map((client) => [client.clientId, client]),
      );
      return this.list();
    });
  }

  private async persist(clients: OidcClientConfig[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(clients, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, this.filePath);
    await chmod(this.filePath, 0o600);
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
