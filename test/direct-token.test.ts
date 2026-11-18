import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type AppContext } from "../src/app.js";
import { mockTokenTtlSeconds, type AppConfig } from "../src/config.js";
import { wrongTenantId } from "../src/faults/token-generator.js";
import { v1TokenValidationPaths } from "../src/oidc/access-token-version.js";
import type { DirectTokenResponse } from "../src/oidc/direct-token.js";
import { scenarioNames, type FaultScenarioName } from "../src/scenario/types.js";
import { testConfig } from "./test-config.js";
import { parseScenarioInput } from "../src/scenario/validation.js";
const path = "/__mock/api/tokens";
const input = {
  clientId: "00000000-0000-4000-8000-000000000001",
  userId: "user-admin",
  resourceAppId: "55555555-5555-4555-8555-555555555555",
  scopes: ["access_as_user"],
};
const supported = [
  "NO_GROUPS",
  "WRONG_AUDIENCE",
  "WRONG_ISSUER",
  "EXPIRED_TOKEN",
  "FUTURE_NBF",
  "INVALID_SIGNATURE",
  "UNKNOWN_KID",
  "SIGNING_KEY_ROLLOVER",
  "ALG_NONE",
  "WRONG_TENANT",
  "MISSING_CLAIM",
] as const satisfies readonly FaultScenarioName[];
describe("direct development access tokens", () => {
  let context: AppContext;
  let config: AppConfig;
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "mock-direct-token-"));
    config = testConfig({
      issuer: "http://localhost/tenant/v2.0",
      keyDirectory: join(directory, "keys"),
      clientConfigFile: join(directory, "clients.json"),
      userConfigFile: join(directory, "users.json"),
    });
    context = await buildApp(config, { https: false });
  });
  beforeEach(async () => {
    context.store.reset();
    await context.clientStore.reset();
    await context.resourceStore.reset();
    await context.userStore.reset();
    context.accessLog.clear();
  });
  afterAll(async () => {
    try {
      await context.app.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const issue = (payload: unknown = input) =>
    context.app.inject({
      method: "POST",
      url: path,
      payload: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
    });
  const jwks = async () => createLocalJWKSet((await context.app.inject(config.jwksPath)).json());
  it.each(["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"])(
    "issues a verifiable token for %s without session or persisted tokens",
    async (clientId) => {
      const files = [config.clientConfigFile, config.userConfigFile];
      const before = await Promise.all(files.map((file) => readFile(file, "utf8")));
      const response = await issue({ ...input, clientId });
      expect(response.statusCode).toBe(200);
      const result = response.json<DirectTokenResponse>();
      expect(result).toMatchObject({
        token_type: "Bearer",
        expires_in: mockTokenTtlSeconds,
        scope: "api://55555555-5555-4555-8555-555555555555/access_as_user",
        fault: null,
      });
      const { payload, protectedHeader } = await jwtVerify(result.access_token, await jwks(), {
        issuer: config.issuer,
        audience: "55555555-5555-4555-8555-555555555555",
      });
      expect(protectedHeader).toMatchObject({ typ: "JWT", alg: "RS256", kid: "mock-normal-key" });
      expect(payload).toMatchObject({
        sub: expect.any(String),
        oid: "11111111-1111-1111-1111-111111111111",
        tid: config.tenantId,
        name: "Admin User",
        preferred_username: "admin@example.com",
        email: "admin@example.com",
        groups: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2"],
        ver: "2.0",
        azp: clientId,
        azpacr: clientId === "00000000-0000-4000-8000-000000000001" ? "0" : "1",
        scp: "access_as_user",
      });
      expect(payload.nbf).toBe(payload.iat);
      expect(payload.exp! - payload.iat!).toBe(mockTokenTtlSeconds);
      expect(payload.jti).toEqual(expect.any(String));
      for (const claim of ["scope", "mail", "sid", "roles", "appid", "unique_name"])
        expect(payload).not.toHaveProperty(claim);
      expect(result).not.toHaveProperty("id_token");
      expect(result).not.toHaveProperty("refresh_token");
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(context.accessLog.list().some((entry) => entry.path === path)).toBe(false);
      expect(await Promise.all(files.map((file) => readFile(file, "utf8")))).toEqual(before);
      expect(decodeJwt((await issue()).json<DirectTokenResponse>().access_token).jti).not.toBe(payload.jti);
    },
  );
  it("reflects current client settings, user changes and v1 metadata", async () => {
    const clientId = context.clientStore.list()[0]!.clientId;
    const { resourceAppId, ...resource } = context.resourceStore.list()[0]!;
    await context.resourceStore.update(resourceAppId, {
      ...resource,
      requestedAccessTokenVersion: 1,
      emailOptionalClaim: true,
    });
    const user = context.userStore.find("user-normal")!;
    const { sub, ...update } = user;
    await context.userStore.update(sub, {
      ...update,
      name: "Changed",
      groups: ["a0000000-0000-4000-8000-000000000004"],
    });
    const result = (await issue({ ...input, clientId, userId: sub })).json<DirectTokenResponse>();
    const v1 = v1TokenValidationPaths(config.issuerPath);
    const issuer = `${config.issuerOrigin}${v1.issuerPath}`;
    const metadata = (await context.app.inject(v1.discoveryPath)).json();
    expect(metadata.issuer).toBe(issuer);
    const { payload } = await jwtVerify(result.access_token, await jwks(), {
      issuer,
      audience: "api://55555555-5555-4555-8555-555555555555",
    });
    expect(payload).toMatchObject({
      ver: "1.0",
      appid: clientId,
      appidacr: "0",
      unique_name: user.preferred_username,
      email: user.mail,
      name: "Changed",
      groups: ["a0000000-0000-4000-8000-000000000004"],
      scp: "access_as_user",
    });
    for (const claim of ["azp", "azpacr", "preferred_username", "sid"]) expect(payload).not.toHaveProperty(claim);
    expect(result.scope).toBe("api://55555555-5555-4555-8555-555555555555/access_as_user");
  });
  it.each([false, true])("applies API attribute settings independently of client settings: %s", async (enabled) => {
    const { clientId, ...client } = context.clientStore.list().find((item) => item.clientId === input.clientId)!;
    await context.clientStore.update(clientId, {
      ...client,
      emailOptionalClaim: !enabled,
      groupMembershipClaims: enabled ? "None" : "SecurityGroup",
    });
    const { resourceAppId, ...resource } = context.resourceStore.find(input.resourceAppId)!;
    await context.resourceStore.update(resourceAppId, {
      ...resource,
      emailOptionalClaim: enabled,
      groupMembershipClaims: enabled ? "SecurityGroup" : "None",
    });
    const response = await issue();
    expect(response.statusCode).toBe(200);
    const payload = decodeJwt(response.json<DirectTokenResponse>().access_token);
    const user = context.userStore.find(input.userId)!;
    expect(payload.email).toEqual(enabled ? user.mail : undefined);
    expect(payload.groups).toEqual(enabled ? user.groups : undefined);
  });
  it.each(["user-normal", "user-unauthorized"])("preserves the groups of %s", async (userId) => {
    const result = (await issue({ ...input, userId })).json<DirectTokenResponse>();
    expect(decodeJwt(result.access_token).groups ?? []).toEqual(context.userStore.find(userId)!.groups);
  });
  it.each([
    null,
    {},
    { clientId: input.clientId },
    { userId: input.userId },
    { ...input, extra: true },
    { ...input, userId: " " },
    { ...input, clientId: 12 },
    { ...input, clientId: "a\nb" },
  ])("rejects invalid body %# without consuming faults", async (body) => {
    context.store.set({ scenario: "EXPIRED_TOKEN", mode: "LIMITED", failureCount: 1 });
    const response = await issue(body);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_token_request", message: expect.any(String) });
    expect(context.store.get().remainingFailures).toBe(1);
  });
  it.each([
    { body: { ...input, clientId: "ffa63583-dfa6-406b-87d2-84b86b0d693a" }, error: "client_not_found" },
    { body: { ...input, userId: "ffa63583-dfa6-406b-87d2-84b86b0d693a" }, error: "user_not_found" },
  ])("rejects unregistered identifiers: $error", async ({ body, error }) => {
    context.store.set({ scenario: "NO_GROUPS", mode: "LIMITED", failureCount: 1 });
    const response = await issue(body);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error, message: expect.any(String) });
    expect(context.store.get().remainingFailures).toBe(1);
  });
  it.each([
    { headers: { host: "elsewhere.test", "content-type": "application/json" }, status: 400 },
    { headers: { origin: "http://elsewhere.test", "content-type": "application/json" }, status: 403 },
    { headers: { "content-type": "text/plain" }, status: 415 },
  ])("applies existing administration request protections %#", async ({ headers, status }) => {
    context.store.set({ scenario: "NO_GROUPS", mode: "LIMITED", failureCount: 1 });
    const response = await context.app.inject({ method: "POST", url: path, headers, payload: JSON.stringify(input) });
    expect(response.statusCode).toBe(status);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(context.store.get().remainingFailures).toBe(1);
  });
  it.each(supported)("applies %s once and completes LIMITED", async (scenario) => {
    const normalKey = await jwks();
    context.store.set(
      parseScenarioInput({
        scenario,
        mode: "LIMITED",
        failureCount: 1,
        ...(scenario === "MISSING_CLAIM" ? { parameters: { claim: "oid" as const } } : {}),
        ...(scenario === "EXPIRED_TOKEN" ? { parameters: { expiredAgoSeconds: 30 } } : {}),
        ...(scenario === "FUTURE_NBF" ? { parameters: { nbfAheadSeconds: 30 } } : {}),
      }),
    );
    const response = await issue();
    expect(response.statusCode).toBe(200);
    const result = response.json<DirectTokenResponse>();
    expect(result.fault).toMatchObject({ scenario, remainingBefore: 1, remainingAfter: 0 });
    expect(context.store.get()).toMatchObject({ scenario: "NORMAL", lastCompleted: { scenario, triggeredCount: 1 } });
    const payload = decodeJwt(result.access_token),
      header = decodeProtectedHeader(result.access_token);
    const now = Math.floor(Date.now() / 1000);
    switch (scenario) {
      case "NO_GROUPS":
        expect(payload).not.toHaveProperty("groups");
        break;
      case "WRONG_AUDIENCE":
        expect(payload.aud).toBe("unexpected-audience");
        break;
      case "WRONG_ISSUER":
        expect(payload.iss).toBe("https://wrong-issuer.invalid");
        break;
      case "EXPIRED_TOKEN":
        expect(payload.exp).toBeLessThanOrEqual(now - 30);
        break;
      case "FUTURE_NBF":
        expect(payload.nbf).toBeGreaterThanOrEqual(now + 28);
        break;
      case "INVALID_SIGNATURE":
        await expect(jwtVerify(result.access_token, normalKey)).rejects.toThrow();
        break;
      case "UNKNOWN_KID":
        expect(header.kid).toBe("unknown-kid");
        await expect(jwtVerify(result.access_token, normalKey)).rejects.toThrow();
        break;
      case "SIGNING_KEY_ROLLOVER":
        expect(header.kid).toBe("mock-rollover-key");
        await jwtVerify(result.access_token, await jwks());
        break;
      case "ALG_NONE":
        expect(header.alg).toBe("none");
        expect(result.access_token.split(".")[2]).toBe("");
        break;
      case "WRONG_TENANT":
        expect(payload.tid).toBe(wrongTenantId);
        break;
      case "MISSING_CLAIM":
        expect(payload).not.toHaveProperty("oid");
        break;
    }
    if (!["INVALID_SIGNATURE", "UNKNOWN_KID", "ALG_NONE", "SIGNING_KEY_ROLLOVER"].includes(scenario))
      await jwtVerify(result.access_token, normalKey, { currentDate: new Date((payload.nbf as number) * 1000) });
    const next = (await issue()).json<DirectTokenResponse>();
    expect(next.fault).toBeNull();
    expect(decodeJwt(next.access_token).groups).toEqual(context.userStore.find(input.userId)!.groups);
  });
  it.each(
    scenarioNames.filter(
      (scenario): scenario is FaultScenarioName =>
        scenario !== "NORMAL" && !supported.some((item) => item === scenario),
    ),
  )("does not consume unsupported scenario %s", async (scenario) => {
    context.store.set(parseScenarioInput({ scenario, mode: "LIMITED", failureCount: 1 }));
    const response = await issue();
    expect(response.statusCode).toBe(200);
    expect(response.json<DirectTokenResponse>().fault).toBeNull();
    expect(context.store.get()).toMatchObject({ scenario, remainingFailures: 1, triggeredCount: 0 });
  });
  it("keeps CONTINUOUS active", async () => {
    context.store.set({ scenario: "NO_GROUPS", mode: "CONTINUOUS" });
    for (let i = 0; i < 2; i++) expect((await issue()).json<DirectTokenResponse>().fault?.scenario).toBe("NO_GROUPS");
    expect(context.store.get()).toMatchObject({ scenario: "NO_GROUPS", triggeredCount: 2 });
  });
  it("allows one winner among concurrent requests when LIMITED has one remaining", async () => {
    context.store.set({ scenario: "EXPIRED_TOKEN", mode: "LIMITED", failureCount: 1 });
    const results = await Promise.all(Array.from({ length: 12 }, () => issue()));
    expect(results.every((result) => result.statusCode === 200)).toBe(true);
    expect(results.filter((result) => result.json<DirectTokenResponse>().fault !== null)).toHaveLength(1);
    expect(context.store.get()).toMatchObject({ scenario: "NORMAL", lastCompleted: { triggeredCount: 1 } });
  });
});
