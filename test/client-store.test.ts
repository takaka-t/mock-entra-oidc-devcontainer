import { mkdir, rename, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import {
  ClientConflictError,
  ClientNotFoundError,
  ClientValidationError,
  defaultClients,
  OidcClientStore,
} from "../src/clients/store.js";
import type { OidcClientConfig } from "../src/clients/types.js";
import { parseCreateClient } from "../src/clients/validation.js";
const publicClient = {
  clientId: "a172cedc-ae47-474b-815c-54d510a5d84a",
  clientType: "PUBLIC" as const,
  tokenEndpointAuthMethod: "none" as const,
  redirectUris: [{ uri: "http://localhost/callback", type: "native" as const }],
  requiredResourceAccess: [{ resourceAppId: "55555555-5555-4555-8555-555555555555", scopes: ["access_as_user"] }],
  emailOptionalClaim: false,
  groupMembershipClaims: "SecurityGroup" as const,
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
  it.each(["!", "$", "'", "(", ")", ",", ";"])("rejects unsupported redirect URI character %s", (character) => {
    expect(() =>
      parseCreateClient({
        ...publicClient,
        redirectUris: [{ type: "native", uri: `https://app.example/callback${character}` }],
      }),
    ).toThrow(ZodError);
  });
  it.each(["https://例え.test/callback", "https://xn--r8jz45g.test/callback"])(
    "rejects internationalized redirect domains %s",
    (uri) => {
      expect(() => parseCreateClient({ ...publicClient, redirectUris: [{ type: "native", uri }] })).toThrow(ZodError);
    },
  );
  it("enforces the 256-URI limit for a single-tenant registration", () => {
    const redirectUris = Array.from({ length: 256 }, (_, index) => ({
      type: "native",
      uri: `https://app.example/callback/${index}`,
    }));
    expect(parseCreateClient({ ...publicClient, redirectUris }).redirectUris).toHaveLength(256);
    expect(() =>
      parseCreateClient({
        ...publicClient,
        redirectUris: [...redirectUris, { type: "native", uri: "https://app.example/extra" }],
      }),
    ).toThrow(ZodError);
  });
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "mock-clients-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  it("seeds, persists with 0600, reloads, and resets defaults", async () => {
    const file = join(directory, "clients.json");
    const apply = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    const store = new OidcClientStore(file, apply, remove);
    await store.initialize();
    expect(store.list()).toEqual(defaultClients());
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await store.create(publicClient);
    expect(store.list().at(-1)?.redirectUris).toEqual([{ uri: "http://localhost/callback", type: "native" }]);
    const reloaded = new OidcClientStore(file, apply, remove);
    await reloaded.initialize();
    expect(reloaded.list().some((client) => client.clientId === "a172cedc-ae47-474b-815c-54d510a5d84a")).toBe(true);
    await reloaded.reset();
    expect(reloaded.list()).toEqual(defaultClients());
  });
  it("reports conflicts and missing clients", async () => {
    const store = new OidcClientStore(
      join(directory, "clients.json"),
      async () => {},
      async () => {},
    );
    await store.initialize();
    await store.create(publicClient);
    await expect(store.create(publicClient)).rejects.toBeInstanceOf(ClientConflictError);
    const { clientId, ...update } = publicClient;
    await expect(store.update(`${clientId}-missing`, update)).rejects.toBeInstanceOf(ClientNotFoundError);
    await expect(store.delete("missing")).rejects.toBeInstanceOf(ClientNotFoundError);
  });
  it("fails startup for malformed persisted data", async () => {
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
  it.each([".", "..", "c".repeat(101)])(
    "rejects an unmanageable persisted client ID %s without rewriting it",
    async (clientId) => {
      const file = join(directory, "clients.json");
      const original = JSON.stringify([{ ...publicClient, clientId }]);
      await writeFile(file, original);
      const provider = providerCallbacks();
      const store = new OidcClientStore(file, provider.apply, provider.remove);
      await expect(store.initialize()).rejects.toBeInstanceOf(ZodError);
      expect(await readFile(file, "utf8")).toBe(original);
      expect(provider.apply).not.toHaveBeenCalled();
    },
  );
  it("rolls back the provider on a failed file commit and allows retry", async () => {
    const file = join(directory, "clients.json");
    const provider = providerCallbacks();
    const store = new OidcClientStore(file, provider.apply, provider.remove);
    await store.initialize();
    const before = await readFile(file, "utf8");
    const backup = file + ".backup";
    await rename(file, backup);
    await mkdir(file);
    await expect(store.create(publicClient)).rejects.toMatchObject({
      code: "EISDIR",
    });
    expect(store.list()).toEqual(defaultClients());
    expect([...provider.clients.values()]).toEqual(defaultClients());
    expect(await readFile(backup, "utf8")).toBe(before);
    expect(await temporaryFiles(directory)).toEqual([]);
    await rm(file, { recursive: true });
    await rename(backup, file);
    await store.create(publicClient);
    expect(provider.clients.has(publicClient.clientId)).toBe(true);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(store.list());
  });
  it.each([
    {
      name: "redirect URI with an empty fragment",
      client: {
        ...publicClient,
        clientId: "702c82f1-35ad-4ec4-82f4-d58147b16a09",
        redirectUris: ["http://localhost/callback#"],
      },
    },
    {
      name: "post-logout redirect URI with a fragment",
      client: {
        ...publicClient,
        clientId: "07b0c31b-633e-4f68-8ab8-02a8821ccf77",
        postLogoutRedirectUris: ["http://localhost/logout#signed-out"],
      },
    },
    {
      name: "legacy audience field",
      client: {
        ...publicClient,
        accessTokenAudience: "urn:app#",
        clientId: "e73cf4d9-2471-4182-8bb9-90bb4b4447cd",
        groupMembershipClaims: "SecurityGroup" as const,
      },
    },
    {
      name: "access token scope containing whitespace",
      client: {
        ...publicClient,
        clientId: "ad1be6be-8cad-4f34-897c-d8071505f5e2",
        requiredResourceAccess: [
          { resourceAppId: "55555555-5555-4555-8555-555555555555", scopes: ["access_as_user extra_scope"] },
        ],
        groupMembershipClaims: "SecurityGroup" as const,
      },
    },
  ])("rejects a $name without changing state", async ({ client }) => {
    const file = join(directory, "clients.json");
    const apply = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    const store = new OidcClientStore(file, apply, remove);
    await store.initialize();
    const beforeFile = await readFile(file, "utf8");
    const beforeClients = store.list();
    apply.mockClear();
    remove.mockClear();
    await expect(store.create(client as never)).rejects.toBeInstanceOf(ZodError);
    expect(store.list()).toEqual(beforeClients);
    expect(await readFile(file, "utf8")).toBe(beforeFile);
    expect(await temporaryFiles(directory)).toEqual([]);
    expect(apply).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
  it("rejects fragments when updating an existing client", async () => {
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
        redirectUris: [{ uri: "http://localhost/callback#fragment", type: "native" as const }],
        groupMembershipClaims: "SecurityGroup" as const,
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
    const store = new OidcClientStore(
      join(directory, "clients.json"),
      async () => undefined,
      async () => undefined,
    );
    await store.initialize();
    await expect(store.create({ ...publicClient, clientId: value })).rejects.toBeInstanceOf(ZodError);
  });
  it.each(["bad\tsecret", "bad\u007fsecret", "秘密"])(
    "rejects a non-printable ASCII client secret %#",
    async (clientSecret) => {
      const store = new OidcClientStore(
        join(directory, "clients.json"),
        async () => undefined,
        async () => undefined,
      );
      await store.initialize();
      await expect(
        store.create({
          ...publicClient,
          clientId: "31510842-86f5-4511-8e11-d4fd234b6485",
          clientType: "CONFIDENTIAL",
          clientSecret,
          tokenEndpointAuthMethod: "client_secret_basic",
        }),
      ).rejects.toBeInstanceOf(ZodError);
    },
  );
  it("preflights defaults before writing or applying them", async () => {
    const file = join(directory, "clients.json");
    const apply = vi.fn(async () => undefined);
    const validate = vi.fn((client: OidcClientConfig) => {
      if (client.clientType === "CONFIDENTIAL") throw new Error("provider metadata rejected");
    });
    const store = new OidcClientStore(file, apply, async () => undefined, validate);
    await expect(store.initialize()).rejects.toMatchObject({
      name: "ClientValidationError",
      clientId: "00000000-0000-4000-8000-000000000002",
      message: "provider metadata rejected",
    });
    expect(apply).not.toHaveBeenCalled();
    expect(store.list()).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
  });
  it("wraps provider preflight failures and leaves canonical state unchanged", async () => {
    const file = join(directory, "clients.json");
    const apply = vi.fn(async () => undefined);
    const rejectClientId = publicClient.clientId;
    const validate = vi.fn((client: OidcClientConfig) => {
      if (client.clientId === rejectClientId) throw new Error("provider metadata rejected");
    });
    const store = new OidcClientStore(file, apply, async () => undefined, validate);
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
    const file = join(directory, "clients.json");
    const provider = providerCallbacks();
    const store = new OidcClientStore(file, provider.apply, provider.remove);
    await store.initialize();
    const beforeFile = await readFile(file, "utf8");
    const beforeClients = store.list();
    provider.failApplyOnce((client) => client.clientId === publicClient.clientId);
    await expect(store.create(publicClient)).rejects.toThrow("provider apply failed");
    expect(store.list()).toEqual(beforeClients);
    expect(await readFile(file, "utf8")).toBe(beforeFile);
    expect(await temporaryFiles(directory)).toEqual([]);
    expect(provider.clients.has(publicClient.clientId)).toBe(false);
  });
  it("restores the previous provider client when an update fails", async () => {
    const file = join(directory, "clients.json");
    const provider = providerCallbacks();
    const store = new OidcClientStore(file, provider.apply, provider.remove);
    await store.initialize();
    await store.create(publicClient);
    const beforeFile = await readFile(file, "utf8");
    const beforeClients = store.list();
    const { clientId, ...update } = publicClient;
    provider.failApplyOnce((client) => client.emailOptionalClaim === true);
    await expect(
      store.update(clientId, {
        ...update,
        emailOptionalClaim: true,
        groupMembershipClaims: "SecurityGroup" as const,
      }),
    ).rejects.toThrow("provider apply failed");
    expect(store.list()).toEqual(beforeClients);
    expect(await readFile(file, "utf8")).toBe(beforeFile);
    expect(await temporaryFiles(directory)).toEqual([]);
    expect(provider.clients.get(clientId)).toEqual(beforeClients.at(-1));
    expect((await store.update(clientId, update)).emailOptionalClaim).toBe(false);
  });
  it("restores a provider client when removal fails", async () => {
    const file = join(directory, "clients.json");
    const provider = providerCallbacks();
    const store = new OidcClientStore(file, provider.apply, provider.remove);
    await store.initialize();
    await store.create(publicClient);
    const beforeFile = await readFile(file, "utf8");
    const beforeClients = store.list();
    provider.failRemoveOnce((clientId) => clientId === publicClient.clientId);
    await expect(store.delete(publicClient.clientId)).rejects.toThrow("provider remove failed");
    expect(store.list()).toEqual(beforeClients);
    expect(await readFile(file, "utf8")).toBe(beforeFile);
    expect(await temporaryFiles(directory)).toEqual([]);
    expect(provider.clients.get(publicClient.clientId)).toEqual(beforeClients.at(-1));
  });
  it("restores the full provider snapshot when reset fails partway", async () => {
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
