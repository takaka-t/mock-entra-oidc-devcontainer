import { mkdtemp, rm, readFile, rename, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type AppContext } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { ApiResourceStore, defaultResources } from "../src/resources/store.js";
import { defaultResourceAppId, defaultResourceUri } from "../src/resources/types.js";
import { publicClientId } from "../src/clients/types.js";
import { authorize, tokenRequest } from "./entra-flow.js";
import { decodeJwt } from "jose";
import { testConfig } from "./test-config.js";
const newResource = {
  ...defaultResources()[0]!,
  resourceAppId: "66666666-6666-4666-8666-666666666666",
  identifierUri: "api://second-api",
  scopes: ["read", "write"],
};
describe("API registration and references", () => {
  let context: AppContext, config: AppConfig, directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "entra-resources-"));
    config = testConfig({
      issuer: "http://localhost/tenant/v2.0",
      keyDirectory: join(directory, "keys"),
      clientConfigFile: join(directory, "clients.json"),
      userConfigFile: join(directory, "users.json"),
    });
    context = await buildApp(config, { https: false });
  });
  afterEach(async () => {
    await context.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const request = (method: "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
    context.app.inject({
      method,
      url,
      headers: payload === undefined ? {} : { "content-type": "application/json" },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  it("creates, edits, reloads, deletes and resets resources with private atomic persistence", async () => {
    expect((await stat(config.resourceConfigFile)).mode & 0o777).toBe(0o600);
    const response = await request("POST", "/__mock/api/resources", newResource);
    expect(response.statusCode).toBe(201);
    const { resourceAppId, ...update } = newResource;
    expect(
      (await request("PUT", `/__mock/api/resources/${resourceAppId}`, { ...update, requestedAccessTokenVersion: null }))
        .statusCode,
    ).toBe(200);
    const reload = new ApiResourceStore(config.resourceConfigFile);
    await reload.initialize();
    expect(reload.find(resourceAppId)?.requestedAccessTokenVersion).toBeNull();
    expect((await request("DELETE", `/__mock/api/resources/${resourceAppId}`)).statusCode).toBe(204);
    expect((await request("POST", "/__mock/api/resources/reset", {})).json()).toEqual(defaultResources());
    expect((await readdir(directory)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });
  it("rejects duplicate IDs and URIs without changing memory or disk", async () => {
    const before = await readFile(config.resourceConfigFile, "utf8");
    for (const resource of [defaultResources()[0]!, { ...newResource, identifierUri: defaultResourceUri }])
      expect((await request("POST", "/__mock/api/resources", resource)).statusCode).toBe(409);
    expect(await readFile(config.resourceConfigFile, "utf8")).toBe(before);
    expect(context.resourceStore.list()).toEqual(defaultResources());
  });
  it("enables both API attributes on initial creation and explicit reset", async () => {
    expect(context.resourceStore.find(defaultResourceAppId)).toMatchObject({
      emailOptionalClaim: true,
      groupMembershipClaims: "SecurityGroup",
    });
    const { resourceAppId, ...input } = context.resourceStore.find(defaultResourceAppId)!;
    await context.resourceStore.update(resourceAppId, {
      ...input,
      emailOptionalClaim: false,
      groupMembershipClaims: "None",
    });
    const reset = await request("POST", "/__mock/api/resources/reset", {});
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual([
      expect.objectContaining({ emailOptionalClaim: true, groupMembershipClaims: "SecurityGroup" }),
    ]);
    const reload = new ApiResourceStore(config.resourceConfigFile);
    await reload.initialize();
    expect(reload.find(resourceAppId)).toMatchObject({
      emailOptionalClaim: true,
      groupMembershipClaims: "SecurityGroup",
    });
  });
  it.each([
    { email: false, groups: "None" },
    { email: true, groups: "None" },
    { email: false, groups: "SecurityGroup" },
    { email: true, groups: "SecurityGroup" },
  ])("preserves saved API attributes without rewriting the file: $email / $groups", async ({ email, groups }) => {
    const { resourceAppId, ...input } = context.resourceStore.find(defaultResourceAppId)!;
    const saved = await request("PUT", `/__mock/api/resources/${resourceAppId}`, {
      ...input,
      emailOptionalClaim: email,
      groupMembershipClaims: groups,
    });
    expect(saved.statusCode).toBe(200);
    const before = await readFile(config.resourceConfigFile, "utf8");
    const reload = new ApiResourceStore(config.resourceConfigFile);
    await reload.initialize();
    expect(reload.find(resourceAppId)).toMatchObject({ emailOptionalClaim: email, groupMembershipClaims: groups });
    expect(await readFile(config.resourceConfigFile, "utf8")).toBe(before);
  });
  it.each([
    { resourceAppId: "not-a-guid" },
    { scopes: ["invalid scope"] },
    { scopes: [".default"] },
    { identifierUri: "http://evil.test" },
    { identifierUri: "api:opaque-identifier" },
    { identifierUri: "api:/missing-authority" },
    { identifierUri: "api:///missing-host" },
    { identifierUri: "api://test#fragment" },
    { requestedAccessTokenVersion: "2" },
    { accessTokenVersion: "2.0" },
  ])("rejects invalid resource registration %#", async (change) => {
    expect((await request("POST", "/__mock/api/resources", { ...newResource, ...change })).statusCode).toBe(400);
  });
  it("protects referenced resources and scopes from deletion and reset", async () => {
    expect((await request("DELETE", `/__mock/api/resources/${defaultResourceAppId}`)).statusCode).toBe(409);
    const { resourceAppId, ...resource } = context.resourceStore.list()[0]!;
    expect(
      (await request("PUT", `/__mock/api/resources/${resourceAppId}`, { ...resource, scopes: ["api.read"] }))
        .statusCode,
    ).toBe(409);
    await context.resourceStore.create(newResource);
    const { clientId, ...client } = context.clientStore.list()[0]!;
    await context.clientStore.update(clientId, {
      ...client,
      requiredResourceAccess: [{ resourceAppId: newResource.resourceAppId, scopes: ["read"] }],
    });
    expect((await request("POST", "/__mock/api/resources/reset", {})).statusCode).toBe(409);
  });
  it("rejects client references to missing resources or scopes", async () => {
    const { clientId, ...client } = context.clientStore.list()[0]!;
    for (const permission of [
      { resourceAppId: newResource.resourceAppId, scopes: ["read"] },
      { resourceAppId: defaultResourceAppId, scopes: ["unknown"] },
    ]) {
      const response = await request("PUT", `/__mock/api/clients/${clientId}`, {
        ...client,
        requiredResourceAccess: [permission],
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain(clientId);
      expect(response.json().message).toContain("API 権限は登録済み API と公開スコープを参照してください");
    }
  });
  it("returns a validation error when client reset refers to an absent default API and can recover", async () => {
    for (const { clientId, ...client } of context.clientStore.list())
      await context.clientStore.update(clientId, { ...client, requiredResourceAccess: [] });
    await context.resourceStore.delete(defaultResourceAppId);
    const before = await readFile(config.clientConfigFile, "utf8");
    const clients = context.clientStore.list();
    const rejected = await request("POST", "/__mock/api/clients/reset", {});
    expect(rejected.statusCode, rejected.body).toBe(400);
    expect(rejected.json().error).toBe("invalid_client");
    expect(rejected.json().message).toContain("API 権限は登録済み API と公開スコープを参照してください");
    expect(context.clientStore.list()).toEqual(clients);
    expect(await readFile(config.clientConfigFile, "utf8")).toBe(before);
    expect((await request("POST", "/__mock/api/resources/reset", {})).statusCode).toBe(200);
    expect((await request("POST", "/__mock/api/clients/reset", {})).statusCode).toBe(200);
    expect(context.clientStore.list()[0]!.requiredResourceAccess[0]!.resourceAppId).toBe(defaultResourceAppId);
  });
  it("rejects confidential SPA registrations before persisting an unusable configuration", async () => {
    const { clientId, ...client } = context.clientStore.list()[1]!;
    const before = await readFile(config.clientConfigFile, "utf8");
    const response = await request("PUT", `/__mock/api/clients/${clientId}`, {
      ...client,
      redirectUris: [{ type: "spa", uri: "https://spa.example.test/callback" }],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("SPA");
    expect(await readFile(config.clientConfigFile, "utf8")).toBe(before);
  });
  it("serializes client creation against resource deletion", async () => {
    await context.resourceStore.create(newResource);
    const client = {
      ...context.clientStore.list()[0]!,
      clientId: "77777777-7777-4777-8777-777777777777",
      requiredResourceAccess: [{ resourceAppId: newResource.resourceAppId, scopes: ["read"] }],
    };
    const responses = await Promise.all([
      request("POST", "/__mock/api/clients", client),
      request("DELETE", `/__mock/api/resources/${newResource.resourceAppId}`),
    ]);
    expect([
      [201, 409],
      [400, 204],
    ]).toContainEqual(responses.map((response) => response.statusCode));
    const created = context.clientStore.list().some((item) => item.clientId === client.clientId);
    expect(!!context.resourceStore.find(newResource.resourceAppId)).toBe(created);
  });
  it("leaves memory and the previous file intact after a failed commit and permits retry", async () => {
    const file = config.resourceConfigFile,
      backup = file + ".backup",
      before = await readFile(file, "utf8");
    await rename(file, backup);
    await mkdir(file);
    await expect(context.resourceStore.create(newResource)).rejects.toMatchObject({ code: "EISDIR" });
    expect(context.resourceStore.list()).toEqual(defaultResources());
    expect(await readFile(backup, "utf8")).toBe(before);
    expect((await readdir(directory)).some((name) => name.endsWith(".tmp"))).toBe(false);
    await rm(file, { recursive: true });
    await rename(backup, file);
    await context.resourceStore.create(newResource);
    expect(context.resourceStore.find(newResource.resourceAppId)).toEqual(newResource);
  });
  it("fails on legacy configuration without rewriting it", async () => {
    const file = join(directory, "legacy.json"),
      raw = JSON.stringify([{ ...newResource, accessTokenVersion: "2.0" }]);
    await writeFile(file, raw);
    await expect(new ApiResourceStore(file).initialize()).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(raw);
  });
  it("consents to multiple APIs but issues only the selected API's scopes", async () => {
    await context.resourceStore.create(newResource);
    const { clientId, ...client } = context.clientStore.list()[0]!;
    await context.clientStore.update(clientId, {
      ...client,
      requiredResourceAccess: [
        ...client.requiredResourceAccess,
        { resourceAppId: newResource.resourceAppId, scopes: ["read", "write"] },
      ],
    });
    const flow = await authorize(context, config, {
      scope: `openid offline_access ${defaultResourceUri}/api.read ${newResource.identifierUri}/read`,
    });
    const invalidExchange = await tokenRequest(context, config, {
      grant_type: "authorization_code",
      client_id: publicClientId,
      redirect_uri: "http://localhost:3000/callback",
      code: flow.code,
      code_verifier: flow.verifier,
      scope: `${defaultResourceUri}/api.read ${newResource.identifierUri}/read`,
    });
    expect(invalidExchange.statusCode, invalidExchange.body).toBe(400);
    expect(invalidExchange.json().error).toBe("invalid_scope");
    const response = await tokenRequest(context, config, {
      grant_type: "authorization_code",
      client_id: publicClientId,
      redirect_uri: "http://localhost:3000/callback",
      code: flow.code,
      code_verifier: flow.verifier,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(decodeJwt(response.json().access_token)).toMatchObject({ aud: defaultResourceAppId, scp: "api.read" });
    const refreshed = await tokenRequest(context, config, {
      grant_type: "refresh_token",
      client_id: publicClientId,
      refresh_token: response.json().refresh_token,
      scope: `${newResource.identifierUri}/read`,
    });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect(decodeJwt(refreshed.json().access_token)).toMatchObject({ aud: newResource.resourceAppId, scp: "read" });
  });
  it.each([false, true])(
    "keeps the selected API usable when unrelated consent is removed (explicit scope: %s)",
    async (explicitScope) => {
      await context.resourceStore.create(newResource);
      const { clientId, ...client } = context.clientStore.list()[0]!;
      await context.clientStore.update(clientId, {
        ...client,
        requiredResourceAccess: [
          ...client.requiredResourceAccess,
          { resourceAppId: newResource.resourceAppId, scopes: ["read"] },
        ],
      });
      const flow = await authorize(context, config, {
        scope: `openid offline_access ${defaultResourceUri}/api.read ${newResource.identifierUri}/read`,
      });
      await context.clientStore.update(clientId, client);
      await context.resourceStore.delete(newResource.resourceAppId);
      const exchanged = await tokenRequest(context, config, {
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: "http://localhost:3000/callback",
        code: flow.code,
        code_verifier: flow.verifier,
        ...(explicitScope ? { scope: `openid ${defaultResourceUri}/api.read` } : {}),
      });
      expect(exchanged.statusCode, exchanged.body).toBe(200);
      expect(decodeJwt(exchanged.json().access_token)).toMatchObject({ aud: defaultResourceAppId, scp: "api.read" });
      const refreshed = await tokenRequest(context, config, {
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: exchanged.json().refresh_token,
      });
      expect(refreshed.statusCode, refreshed.body).toBe(200);
      expect(decodeJwt(refreshed.json().access_token)).toMatchObject({ aud: defaultResourceAppId, scp: "api.read" });
      const revoked = await tokenRequest(context, config, {
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: exchanged.json().refresh_token,
        scope: `${newResource.identifierUri}/read`,
      });
      expect(revoked.statusCode).toBe(400);
      expect(revoked.json().error).toBe("invalid_scope");
    },
  );
  it("exposes resource forms and typed URI and permission controls in the admin UI", async () => {
    const response = await context.app.inject("/__mock");
    for (const id of [
      "resourceEditor",
      "resourceScopes",
      "resourceVersion",
      "permissions",
      "clientGroups",
      "tokenResource",
      "tokenScopes",
    ])
      expect(response.body).toContain(`id="${id}"`);
    expect(response.body).not.toContain('id="accessTokenVersion"');
    expect(response.body).not.toContain('id="audience"');
  });
  it.each(["authorization_code", "refresh_token"] as const)(
    "binds %s consent to the API ID when a URI is reassigned",
    async (grantType) => {
      await context.resourceStore.create(newResource);
      const { clientId, ...client } = context.clientStore.list()[0]!;
      const permission = { resourceAppId: newResource.resourceAppId, scopes: ["read"] };
      await context.clientStore.update(clientId, {
        ...client,
        requiredResourceAccess: [...client.requiredResourceAccess, permission],
      });
      const flow = await authorize(context, config, {
        scope: `openid offline_access ${newResource.identifierUri}/read`,
      });
      const codeParams = {
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: "http://localhost:3000/callback",
        code: flow.code,
        code_verifier: flow.verifier,
      };
      const tokens =
        grantType === "refresh_token" ? (await tokenRequest(context, config, codeParams)).json() : undefined;
      await context.clientStore.update(clientId, client);
      await context.resourceStore.delete(newResource.resourceAppId);
      const replacement = { ...newResource, resourceAppId: "77777777-7777-4777-8777-777777777777" };
      await context.resourceStore.create(replacement);
      await context.clientStore.update(clientId, {
        ...client,
        requiredResourceAccess: [
          ...client.requiredResourceAccess,
          { resourceAppId: replacement.resourceAppId, scopes: ["read"] },
        ],
      });
      const response = await tokenRequest(
        context,
        config,
        grantType === "authorization_code"
          ? codeParams
          : {
              grant_type: "refresh_token",
              client_id: clientId,
              refresh_token: tokens.refresh_token,
              scope: `${replacement.identifierUri}/read`,
            },
      );
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error).toBe("invalid_scope");
    },
  );
  it.each([1, 2] as const)("retains consent for the same API ID when its URI changes (v%s)", async (version) => {
    await context.resourceStore.create({ ...newResource, requestedAccessTokenVersion: version });
    const { clientId, ...client } = context.clientStore.list()[0]!;
    await context.clientStore.update(clientId, {
      ...client,
      requiredResourceAccess: [
        ...client.requiredResourceAccess,
        { resourceAppId: newResource.resourceAppId, scopes: ["read"] },
      ],
    });
    const flow = await authorize(context, config, { scope: `openid offline_access ${newResource.identifierUri}/read` });
    const exchanged = await tokenRequest(context, config, {
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: "http://localhost:3000/callback",
      code: flow.code,
      code_verifier: flow.verifier,
    });
    expect(exchanged.statusCode, exchanged.body).toBe(200);
    const { resourceAppId, ...resource } = newResource;
    const identifierUri = "api://renamed-api";
    await context.resourceStore.update(resourceAppId, {
      ...resource,
      identifierUri,
      requestedAccessTokenVersion: version,
    });
    const response = await tokenRequest(context, config, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: exchanged.json().refresh_token,
      scope: `${identifierUri}/read`,
    });
    expect(response.statusCode, response.body).toBe(200);
    const audience = version === 2 ? resourceAppId : identifierUri;
    expect(decodeJwt(response.json().access_token)).toMatchObject({ aud: audience, scp: "read" });
    const inherited = await tokenRequest(context, config, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: response.json().refresh_token,
    });
    expect(inherited.statusCode, inherited.body).toBe(200);
    expect(decodeJwt(inherited.json().access_token)).toMatchObject({ aud: audience, scp: "read" });
  });
  it.each(["POST", "PUT", "DELETE"] as const)("applies origin protections to resource %s", async (method) => {
    const response = await context.app.inject({
      method,
      url: "/__mock/api/resources" + (method === "POST" ? "" : "/" + defaultResourceAppId),
      headers: { origin: "https://evil.test", "content-type": "application/json" },
      payload: JSON.stringify(newResource),
    });
    expect(response.statusCode).toBe(403);
  });
});
