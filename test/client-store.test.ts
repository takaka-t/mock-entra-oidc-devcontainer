import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ClientConflictError,
  ClientNotFoundError,
  defaultClients,
  OidcClientStore,
} from "../src/clients/store.js";

const publicClient = {
  clientId: "app",
  clientType: "PUBLIC" as const,
  tokenEndpointAuthMethod: "none" as const,
  redirectUris: ["http://localhost/callback", "http://localhost/callback"],
  postLogoutRedirectUris: [],
  scopes: ["openid"],
  accessTokenAudience: "urn:app",
};

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
});
