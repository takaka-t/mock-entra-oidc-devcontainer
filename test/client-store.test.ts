import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import {
  ClientConflictError,
  ClientNotFoundError,
  ClientValidationError,
  defaultClients,
  OidcClientStore,
} from "../src/clients/store.js";
import type { OidcClientConfig } from "../src/clients/types.js";

const publicClient = {
  clientId: "app",
  clientType: "PUBLIC" as const,
  tokenEndpointAuthMethod: "none" as const,
  redirectUris: ["http://localhost/callback", "http://localhost/callback"],
  postLogoutRedirectUris: [],
  accessTokenAudience: "urn:app",
};

async function temporaryFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((entry) => entry.endsWith(".tmp"));
}

function providerCallbacks() {
  const clients = new Map<string, OidcClientConfig>();
  let failApply: ((client: OidcClientConfig) => boolean) | undefined;
  let failRemove: ((clientId: string) => boolean) | undefined;
  const apply = vi.fn(async (client: OidcClientConfig) => {
    clients.set(client.clientId, structuredClone(client));
    if (failApply?.(client)) throw new Error("provider apply failed");
  });
  const remove = vi.fn(async (clientId: string) => {
    clients.delete(clientId);
    if (failRemove?.(clientId)) throw new Error("provider remove failed");
  });
  return {
    clients,
    apply,
    remove,
    failApplyOnce(predicate: (client: OidcClientConfig) => boolean) {
      failApply = (client) => {
        if (!predicate(client)) return false;
        failApply = undefined;
        return true;
      };
    },
    failRemoveOnce(predicate: (clientId: string) => boolean) {
      failRemove = (clientId) => {
        if (!predicate(clientId)) return false;
        failRemove = undefined;
        return true;
      };
    },
  };
}

describe("OIDC client store", () => {
  it("seeds, persists with 0600, reloads, and resets defaults", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mock-clients-"));
    const file = join(directory, "clients.json");
    const apply = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    const store = new OidcClientStore(file, apply, remove);
    await store.initialize();
    expect(store.list()).toEqual(defaultClients());
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await store.create(publicClient);
    expect(store.list().at(-1)?.redirectUris).toEqual([
      "http://localhost/callback",
    ]);

    const reloaded = new OidcClientStore(file, apply, remove);
    await reloaded.initialize();
    expect(reloaded.list().some((client) => client.clientId === "app")).toBe(
      true,
    );
    await reloaded.reset();
    expect(reloaded.list()).toEqual(defaultClients());
  });

  it("reports conflicts and missing clients", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mock-clients-"));
    const store = new OidcClientStore(
      join(directory, "clients.json"),
      async () => {},
      async () => {},
    );
    await store.initialize();
    await store.create(publicClient);
    await expect(store.create(publicClient)).rejects.toBeInstanceOf(
      ClientConflictError,
    );
    const { clientId, ...update } = publicClient;
    await expect(
      store.update(`${clientId}-missing`, update),
    ).rejects.toBeInstanceOf(ClientNotFoundError);
    await expect(store.delete("missing")).rejects.toBeInstanceOf(
      ClientNotFoundError,
    );
  });

  it("fails startup for malformed persisted data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mock-clients-"));
    const file = join(directory, "clients.json");
    await writeFile(file, "not-json");
    const store = new OidcClientStore(
      file,
      async () => {},
      async () => {},
    );
    await expect(store.initialize()).rejects.toBeInstanceOf(SyntaxError);
    expect(await readFile(file, "utf8")).toBe("not-json");
  });

  it("migrates legacy scopes out of persisted clients", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mock-clients-"));
    const file = join(directory, "clients.json");
    await writeFile(
      file,
      JSON.stringify([{ ...publicClient, scopes: ["openid", "email"] }]),
    );
    const store = new OidcClientStore(
      file,
      async () => {},
      async () => {},
    );
    await store.initialize();
    const migrated = {
      ...publicClient,
      redirectUris: ["http://localhost/callback"],
    };
    expect(store.list()).toEqual([migrated]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([migrated]);
  });

  it("rejects unknown persisted client fields during legacy migration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mock-clients-"));
    const file = join(directory, "clients.json");
    await writeFile(
      file,
      JSON.stringify([
        { ...publicClient, scopes: ["openid"], unexpected: true },
      ]),
    );
    const store = new OidcClientStore(
      file,
      async () => {},
      async () => {},
    );
    await expect(store.initialize()).rejects.toBeDefined();
  });

  it.each([
    {
      name: "redirect URI with an empty fragment",
      client: {
        ...publicClient,
        clientId: "redirect-fragment",
        redirectUris: ["http://localhost/callback#"],
      },
    },
    {
      name: "post-logout redirect URI with a fragment",
      client: {
        ...publicClient,
        clientId: "logout-fragment",
        postLogoutRedirectUris: ["http://localhost/logout#signed-out"],
      },
    },
    {
      name: "audience with an empty fragment",
      client: {
        ...publicClient,
        clientId: "audience-fragment",
        accessTokenAudience: "urn:app#",
      },
    },
  ])("rejects a $name without changing state", async ({ client }) => {
    const directory = await mkdtemp(join(tmpdir(), "mock-clients-"));
    const file = join(directory, "clients.json");
    const apply = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    const store = new OidcClientStore(file, apply, remove);
    await store.initialize();
    const beforeFile = await readFile(file, "utf8");
    const beforeClients = store.list();
    apply.mockClear();
    remove.mockClear();

    await expect(store.create(client)).rejects.toBeInstanceOf(ZodError);

    expect(store.list()).toEqual(beforeClients);
    expect(await readFile(file, "utf8")).toBe(beforeFile);
    expect(await temporaryFiles(directory)).toEqual([]);
    expect(apply).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("rejects fragments when updating an existing client", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mock-clients-"));
    const file = join(directory, "clients.json");
    const apply = vi.fn(async () => undefined);
    const store = new OidcClientStore(file, apply, async () => undefined);
    await store.initialize();
    await store.create(publicClient);
    const beforeFile = await readFile(file, "utf8");
    const beforeClients = store.list();
    const { clientId, ...update } = publicClient;
    apply.mockClear();

    await expect(
      store.update(clientId, {
        ...update,
        accessTokenAudience: "urn:changed#fragment",
      }),
    ).rejects.toBeInstanceOf(ZodError);

    expect(store.list()).toEqual(beforeClients);
    expect(await readFile(file, "utf8")).toBe(beforeFile);
    expect(await temporaryFiles(directory)).toEqual([]);
    expect(apply).not.toHaveBeenCalled();
  });

  it.each([
    { field: "clientId", value: "bad\nclient" },
    { field: "clientId", value: "bad\u007fclient" },
    { field: "clientId", value: "クライアント" },
  ])("rejects a non-printable ASCII $field", async ({ value }) => {
    const directory = await mkdtemp(join(tmpdir(), "mock-clients-"));
    const store = new OidcClientStore(
      join(directory, "clients.json"),
      async () => undefined,
      async () => undefined,
    );
    await store.initialize();
    await expect(
      store.create({ ...publicClient, clientId: value }),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it.each(["bad\tsecret", "bad\u007fsecret", "秘密"])(
    "rejects a non-printable ASCII client secret %#",
    async (clientSecret) => {
      const directory = await mkdtemp(join(tmpdir(), "mock-clients-"));
      const store = new OidcClientStore(
        join(directory, "clients.json"),
        async () => undefined,
        async () => undefined,
      );
      await store.initialize();
      await expect(
        store.create({
          ...publicClient,
          clientId: "confidential",
          clientType: "CONFIDENTIAL",
          clientSecret,
          tokenEndpointAuthMethod: "client_secret_basic",
        }),
      ).rejects.toBeInstanceOf(ZodError);
    },
  );

  it("preserves client ID trimming while rejecting a blank ID", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mock-clients-"));
    const store = new OidcClientStore(
      join(directory, "clients.json"),
      async () => undefined,
      async () => undefined,
    );
    await store.initialize();

    await expect(
      store.create({ ...publicClient, clientId: "   " }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      store.create({ ...publicClient, clientId: "  spaced-id  " }),
    ).resolves.toMatchObject({ clientId: "spaced-id" });
  });

  it("preflights defaults before writing or applying them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mock-clients-"));
    const file = join(directory, "clients.json");
    const apply = vi.fn(async () => undefined);
    const validate = vi.fn((client: OidcClientConfig) => {
      if (client.clientType === "CONFIDENTIAL")
        throw new Error("provider metadata rejected");
    });
    const store = new OidcClientStore(
      file,
      apply,
      async () => undefined,
      validate,
    );

    await expect(store.initialize()).rejects.toMatchObject({
      name: "ClientValidationError",
      clientId: "mock-confidential-client",
      message: "provider metadata rejected",
    });
    expect(apply).not.toHaveBeenCalled();
    expect(store.list()).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
  });

  it("wraps provider preflight failures and leaves canonical state unchanged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mock-clients-"));
    const file = join(directory, "clients.json");
    const apply = vi.fn(async () => undefined);
    const rejectClientId = publicClient.clientId;
    const validate = vi.fn((client: OidcClientConfig) => {
      if (client.clientId === rejectClientId)
        throw new Error("provider metadata rejected");
    });
    const store = new OidcClientStore(
      file,
      apply,
      async () => undefined,
      validate,
    );
    await store.initialize();
    const beforeFile = await readFile(file, "utf8");
    const beforeClients = store.list();
    apply.mockClear();
    const failure = store.create(publicClient);
    await expect(failure).rejects.toBeInstanceOf(ClientValidationError);
    await expect(failure).rejects.toMatchObject({
      clientId: publicClient.clientId,
      message: "provider metadata rejected",
    });
    expect(apply).not.toHaveBeenCalled();
    expect(store.list()).toEqual(beforeClients);
    expect(await readFile(file, "utf8")).toBe(beforeFile);
    expect(await temporaryFiles(directory)).toEqual([]);
  });

  it("rolls back a partially applied create and removes its staged file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mock-clients-"));
    const file = join(directory, "clients.json");
    const provider = providerCallbacks();
    const store = new OidcClientStore(file, provider.apply, provider.remove);
    await store.initialize();
    const beforeFile = await readFile(file, "utf8");
    const beforeClients = store.list();
    provider.failApplyOnce(
      (client) => client.clientId === publicClient.clientId,
    );

    await expect(store.create(publicClient)).rejects.toThrow(
      "provider apply failed",
    );

    expect(store.list()).toEqual(beforeClients);
    expect(await readFile(file, "utf8")).toBe(beforeFile);
    expect(await temporaryFiles(directory)).toEqual([]);
    expect(provider.clients.has(publicClient.clientId)).toBe(false);
  });

  it("restores the previous provider client when an update fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mock-clients-"));
    const file = join(directory, "clients.json");
    const provider = providerCallbacks();
    const store = new OidcClientStore(file, provider.apply, provider.remove);
    await store.initialize();
    await store.create(publicClient);
    const beforeFile = await readFile(file, "utf8");
    const beforeClients = store.list();
    const { clientId, ...update } = publicClient;
    provider.failApplyOnce(
      (client) => client.accessTokenAudience === "urn:changed",
    );

    await expect(
      store.update(clientId, {
        ...update,
        accessTokenAudience: "urn:changed",
      }),
    ).rejects.toThrow("provider apply failed");

    expect(store.list()).toEqual(beforeClients);
    expect(await readFile(file, "utf8")).toBe(beforeFile);
    expect(await temporaryFiles(directory)).toEqual([]);
    expect(provider.clients.get(clientId)).toEqual(beforeClients.at(-1));
  });

  it("restores a provider client when removal fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mock-clients-"));
    const file = join(directory, "clients.json");
    const provider = providerCallbacks();
    const store = new OidcClientStore(file, provider.apply, provider.remove);
    await store.initialize();
    await store.create(publicClient);
    const beforeFile = await readFile(file, "utf8");
    const beforeClients = store.list();
    provider.failRemoveOnce((clientId) => clientId === publicClient.clientId);

    await expect(store.delete(publicClient.clientId)).rejects.toThrow(
      "provider remove failed",
    );

    expect(store.list()).toEqual(beforeClients);
    expect(await readFile(file, "utf8")).toBe(beforeFile);
    expect(await temporaryFiles(directory)).toEqual([]);
    expect(provider.clients.get(publicClient.clientId)).toEqual(
      beforeClients.at(-1),
    );
  });

  it("restores the full provider snapshot when reset fails partway", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mock-clients-"));
    const file = join(directory, "clients.json");
    const provider = providerCallbacks();
    const store = new OidcClientStore(file, provider.apply, provider.remove);
    await store.initialize();
    await store.create(publicClient);
    const beforeFile = await readFile(file, "utf8");
    const beforeClients = store.list();
    provider.failRemoveOnce((clientId) => clientId === publicClient.clientId);

    await expect(store.reset()).rejects.toThrow("provider remove failed");

    expect(store.list()).toEqual(beforeClients);
    expect(await readFile(file, "utf8")).toBe(beforeFile);
    expect(await temporaryFiles(directory)).toEqual([]);
    expect([...provider.clients.values()]).toEqual(beforeClients);
  });
});
