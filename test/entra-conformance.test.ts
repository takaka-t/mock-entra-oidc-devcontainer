import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { buildApp, type AppContext } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { publicClientId, confidentialClientId, spaClientId } from "../src/clients/types.js";
import { defaultResourceUri } from "../src/resources/types.js";
import { pairwiseSubject } from "../src/oidc/claims.js";
import { testConfig } from "./test-config.js";
import { authorize, tokenRequest, cookieJar } from "./entra-flow.js";

interface Tokens {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  scope: string;
}
describe("Entra protocol conformance", () => {
  let context: AppContext, config: AppConfig, directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "entra-conformance-"));
    config = testConfig({
      issuer: "http://localhost/tenant/v2.0",
      keyDirectory: join(directory, "keys"),
      clientConfigFile: join(directory, "clients.json"),
      userConfigFile: join(directory, "users.json"),
    });
    context = await buildApp(config, { https: false });
  });
  beforeEach(async () => {
    vi.useRealTimers();
    context.store.reset();
    await context.clientStore.reset();
    await context.resourceStore.reset();
    await context.userStore.reset();
  });
  afterAll(async () => {
    vi.useRealTimers();
    await context.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const headers = (clientId: string) => (clientId === spaClientId ? { origin: "http://localhost:3000" } : {});
  const credentials = (clientId: string) =>
    clientId === confidentialClientId ? { client_secret: "mock-client-secret-change-me" } : {};
  async function login(
    clientId = publicClientId,
    scope?: string,
    pkce: "S256" | "plain" | "omitted" | "none" = "S256",
  ) {
    const flow = await authorize(context, config, {
      clientId,
      ...(scope ? { scope, ...(!scope.split(" ").includes("openid") ? { nonce: null } : {}) } : {}),
      pkce,
    });
    const response = await tokenRequest(
      context,
      config,
      {
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: "http://localhost:3000/callback",
        code: flow.code,
        ...(pkce === "none" ? {} : { code_verifier: flow.verifier }),
        ...credentials(clientId),
      },
      headers(clientId),
    );
    expect(response.statusCode, response.body).toBe(200);
    return { ...flow, tokens: response.json<Tokens>() };
  }
  const refresh = (token: string, clientId = publicClientId, scope?: string) =>
    tokenRequest(
      context,
      config,
      {
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: token,
        ...credentials(clientId),
        ...(scope ? { scope } : {}),
      },
      headers(clientId),
    );
  it.each(
    [publicClientId, confidentialClientId, spaClientId].flatMap((clientId) =>
      [1, 2, null].map((version) => ({ clientId, version })),
    ),
  )("issues and refreshes API version $version for $clientId", async ({ clientId, version }) => {
    const { resourceAppId, ...resource } = context.resourceStore.list()[0]!;
    await context.resourceStore.update(resourceAppId, { ...resource, requestedAccessTokenVersion: version });
    const { tokens } = await login(clientId);
    const keys = createLocalJWKSet((await context.app.inject(config.jwksPath)).json());
    for (const result of [tokens, (await refresh(tokens.refresh_token!, clientId)).json<Tokens>()]) {
      const id = await jwtVerify(result.id_token!, keys, { issuer: config.issuer, audience: clientId });
      const at = await jwtVerify(result.access_token, keys, {
        issuer: version === 2 ? config.issuer : config.issuerOrigin + "/tenant/",
        audience: version === 2 ? resourceAppId : resource.identifierUri,
      });
      expect(id.protectedHeader.typ).toBe("JWT");
      expect(id.payload).not.toHaveProperty("at_hash");
      expect(id.payload).not.toHaveProperty("c_hash");
      expect(id.payload.ver).toBe("2.0");
      expect(at.payload.ver).toBe(version === 2 ? "2.0" : "1.0");
      expect(at.payload.scp).toBe("api.read");
      expect(at.payload[version === 2 ? "azp" : "appid"]).toBe(clientId);
      expect(at.payload[version === 2 ? "azpacr" : "appidacr"]).toBe(clientId === confidentialClientId ? "1" : "0");
      expect(id.payload.sid).toMatch(/^[0-9a-f-]{36}$/);
      expect(at.payload.sid).toBe(id.payload.sid);
      expect(result.scope).toBe(`${defaultResourceUri}/api.read`);
    }
  });
  it.each(["S256", "plain", "omitted"] as const)("accepts %s PKCE", async (pkce) => {
    await login(publicClientId, undefined, pkce);
  });
  it.each([1, 2] as const)("preserves the requested resource identifier for v%s audiences", async (version) => {
    const { resourceAppId, ...resource } = context.resourceStore.list()[0]!;
    await context.resourceStore.update(resourceAppId, { ...resource, requestedAccessTokenVersion: version });
    const { tokens } = await login(publicClientId, `openid offline_access ${resourceAppId}/api.read`);
    expect(decodeJwt(tokens.access_token).aud).toBe(resourceAppId);
    const inherited = await refresh(tokens.refresh_token!);
    expect(inherited.statusCode, inherited.body).toBe(200);
    expect(decodeJwt(inherited.json<Tokens>().access_token).aud).toBe(resourceAppId);
    const explicitUri = await refresh(tokens.refresh_token!, publicClientId, `${resource.identifierUri}/api.read`);
    expect(explicitUri.statusCode, explicitUri.body).toBe(200);
    expect(decodeJwt(explicitUri.json<Tokens>().access_token).aud).toBe(
      version === 2 ? resourceAppId : resource.identifierUri,
    );
  });
  it.each([publicClientId, confidentialClientId])("allows non-SPA PKCE omission for %s", async (clientId) => {
    await login(clientId, undefined, "none");
  });
  it("requires SPA PKCE", async () => {
    await expect(authorize(context, config, { clientId: spaClientId, pkce: "none" })).rejects.toThrow(
      "invalid_request",
    );
  });
  it("binds SPA code exchange to Origin without consuming the code on rejection", async () => {
    const flow = await authorize(context, config, { clientId: spaClientId });
    const params = {
      grant_type: "authorization_code",
      client_id: spaClientId,
      redirect_uri: "http://localhost:3000/callback",
      code: flow.code,
      code_verifier: flow.verifier,
    };
    for (const origin of [undefined, "https://evil.test"]) {
      const response = await tokenRequest(context, config, params, origin ? { origin } : {});
      expect(response.statusCode).toBe(400);
    }
    expect((await tokenRequest(context, config, params, { origin: "http://localhost:3000" })).statusCode).toBe(200);
  });
  it("rejects browser use of confidential credentials and non-SPA codes", async () => {
    for (const clientId of [publicClientId, confidentialClientId]) {
      const flow = await authorize(context, config, { clientId });
      const response = await tokenRequest(
        context,
        config,
        {
          grant_type: "authorization_code",
          client_id: clientId,
          redirect_uri: "http://localhost:3000/callback",
          code: flow.code,
          code_verifier: flow.verifier,
          ...credentials(clientId),
        },
        { origin: "http://localhost:3000" },
      );
      expect(response.statusCode).toBe(400);
    }
  });
  it("uses recipient-specific stable sub values", async () => {
    const one = await login(),
      two = await login(confidentialClientId),
      again = await login();
    expect(decodeJwt(one.tokens.id_token!).sub).not.toBe(decodeJwt(two.tokens.id_token!).sub);
    expect(decodeJwt(one.tokens.id_token!).sub).toBe(decodeJwt(again.tokens.id_token!).sub);
    expect(decodeJwt(one.tokens.access_token).sub).toBe(decodeJwt(two.tokens.access_token).sub);
    expect(decodeJwt(one.tokens.access_token).sub).not.toBe(decodeJwt(one.tokens.id_token!).sub);
    const before = pairwiseSubject(config.tenantId, context.userStore.find("user-admin")!, publicClientId);
    context.store.set({ scenario: "SIGNING_KEY_ROLLOVER", mode: "CONTINUOUS" });
    const rollover = await login();
    expect(decodeJwt(rollover.tokens.id_token!).sub).toBe(before);
  });
  it("accepts an ID token hint for the current pairwise subject during silent SSO", async () => {
    const { tokens, jar } = await login();
    const flow = await authorize(context, config, { jar, prompt: "none", idTokenHint: tokens.id_token! });
    expect(flow.code).toBeTypeOf("string");
  });
  it("does not silently authenticate using a different user's ID token hint", async () => {
    const original = await login();
    const different = await authorize(context, config, { userId: "user-normal" });
    const response = await tokenRequest(context, config, {
      grant_type: "authorization_code",
      client_id: publicClientId,
      redirect_uri: "http://localhost:3000/callback",
      code: different.code,
      code_verifier: different.verifier,
    });
    expect(response.statusCode, response.body).toBe(200);
    await expect(
      authorize(context, config, { jar: original.jar, prompt: "none", idTokenHint: response.json<Tokens>().id_token! }),
    ).rejects.toThrow("login_required");
  });
  it.each(["signature", "audience"] as const)(
    "validates an ID token hint's %s before matching its subject",
    async (invalid) => {
      const { tokens, jar } = await login();
      const parts = tokens.id_token!.split(".");
      if (invalid === "signature") parts[2] = (parts[2]!.startsWith("A") ? "B" : "A") + parts[2]!.slice(1);
      await expect(
        authorize(context, config, {
          jar,
          prompt: "none",
          idTokenHint: parts.join("."),
          ...(invalid === "audience" ? { clientId: confidentialClientId } : {}),
        }),
      ).rejects.toThrow("invalid_request");
    },
  );
  it("does not invent API permissions for OIDC-only requests and gates profile claims", async () => {
    const minimal = (await login(publicClientId, "openid")).tokens;
    expect(minimal.access_token.split(".")).toHaveLength(1);
    const id = decodeJwt(minimal.id_token!);
    for (const key of ["oid", "name", "preferred_username", "email"]) expect(id).not.toHaveProperty(key);
    expect(decodeJwt((await login(publicClientId, "openid profile email")).tokens.id_token!)).toMatchObject({
      name: "Admin User",
      email: "admin@example.com",
    });
    expect(minimal).not.toHaveProperty("refresh_token");
  });
  it("separates API and client optional email policies and handles absent mail", async () => {
    const client = context.clientStore.list()[0]!,
      { clientId, ...input } = client;
    await context.clientStore.update(clientId, { ...input, emailOptionalClaim: true });
    let tokens = (await login()).tokens;
    expect(decodeJwt(tokens.id_token!)).toHaveProperty("email");
    expect(decodeJwt(tokens.access_token)).not.toHaveProperty("email");
    const { resourceAppId, ...resource } = context.resourceStore.list()[0]!;
    await context.resourceStore.update(resourceAppId, { ...resource, emailOptionalClaim: true });
    tokens = (await login()).tokens;
    expect(decodeJwt(tokens.access_token)).toHaveProperty("email");
    const { sub, ...user } = context.userStore.find("user-admin")!;
    await context.userStore.update(sub, { ...user, mail: "" });
    tokens = (await login()).tokens;
    expect(decodeJwt(tokens.id_token!)).not.toHaveProperty("email");
    expect(decodeJwt(tokens.access_token)).not.toHaveProperty("email");
  });
  it.each([200, 201])("emits groups/overage for %s group memberships", async (count) => {
    const { sub, ...user } = context.userStore.find("user-admin")!;
    await context.userStore.update(sub, {
      ...user,
      groups: Array.from({ length: count }, (_, i) => `99999999-9999-4999-8999-${String(i).padStart(12, "0")}`),
    });
    const tokens = (await login()).tokens;
    for (const token of [tokens.id_token!, tokens.access_token]) {
      const payload = decodeJwt(token);
      if (count === 200) expect(payload.groups).toHaveLength(200);
      else {
        expect(payload).not.toHaveProperty("groups");
        expect(payload._claim_names).toEqual({ groups: "src1" });
      }
    }
  });
  it("expands .default and rejects mixing it with dynamic scopes", async () => {
    const tokens = (await login(publicClientId, `openid ${defaultResourceUri}/.default`)).tokens;
    expect(new Set(String(decodeJwt(tokens.access_token).scp).split(" "))).toEqual(
      new Set(["api.read", "api.write", "access_as_user"]),
    );
    await expect(
      authorize(context, config, { scope: `openid ${defaultResourceUri}/.default ${defaultResourceUri}/api.read` }),
    ).rejects.toThrow("invalid_scope");
  });
  it("keeps the expanded .default grant when client permissions later increase", async () => {
    const { clientId, ...client } = context.clientStore.list()[0]!;
    const resourceAppId = context.resourceStore.list()[0]!.resourceAppId;
    await context.clientStore.update(clientId, {
      ...client,
      requiredResourceAccess: [{ resourceAppId, scopes: ["api.read"] }],
    });
    const { tokens } = await login(clientId, `openid offline_access ${resourceAppId}/.default`);
    await context.clientStore.update(clientId, client);
    const response = await refresh(tokens.refresh_token!);
    expect(response.statusCode, response.body).toBe(200);
    expect(decodeJwt(response.json<Tokens>().access_token).scp).toBe("api.read");
    const expanded = await refresh(tokens.refresh_token!, clientId, `${resourceAppId}/.default`);
    expect(expanded.statusCode).toBe(400);
    expect(expanded.json().error).toBe("invalid_scope");
  });
  it("does not expand .default again when client permissions increase before code redemption", async () => {
    const { clientId, ...client } = context.clientStore.list()[0]!;
    const resourceAppId = context.resourceStore.list()[0]!.resourceAppId;
    await context.clientStore.update(clientId, {
      ...client,
      requiredResourceAccess: [{ resourceAppId, scopes: ["api.read"] }],
    });
    const flow = await authorize(context, config, { scope: `openid offline_access ${defaultResourceUri}/.default` });
    await context.clientStore.update(clientId, client);
    const params = {
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: "http://localhost:3000/callback",
      code: flow.code,
      code_verifier: flow.verifier,
    };
    const escalation = await tokenRequest(context, config, { ...params, scope: `${defaultResourceUri}/api.write` });
    expect(escalation.statusCode, escalation.body).toBe(400);
    expect(escalation.json().error).toBe("invalid_scope");
    const exchanged = await tokenRequest(context, config, params);
    expect(exchanged.statusCode, exchanged.body).toBe(200);
    expect(decodeJwt(exchanged.json<Tokens>().access_token).scp).toBe("api.read");
    const refreshed = await refresh(exchanged.json<Tokens>().refresh_token!);
    expect(decodeJwt(refreshed.json<Tokens>().access_token).scp).toBe("api.read");
  });
  it("does not exchange a code for a different account that reuses the internal user ID", async () => {
    const flow = await authorize(context, config);
    const { sub, ...user } = context.userStore.find("user-admin")!;
    await context.userStore.update(sub, { ...user, oid: "99999999-9999-4999-8999-999999999999" });
    const response = await tokenRequest(context, config, {
      grant_type: "authorization_code",
      client_id: publicClientId,
      redirect_uri: "http://localhost:3000/callback",
      code: flow.code,
      code_verifier: flow.verifier,
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().error).toBe("invalid_grant");
  });
  it("rejects unknown permissions and refuses refresh scope escalation", async () => {
    await expect(authorize(context, config, { scope: `openid ${defaultResourceUri}/unknown` })).rejects.toThrow(
      "invalid_scope",
    );
    const { tokens } = await login();
    const denied = await refresh(tokens.refresh_token!, publicClientId, `${defaultResourceUri}/api.write`);
    expect(denied.statusCode).toBe(400);
    expect(denied.json().error).toBe("invalid_scope");
    const valid = await refresh(tokens.refresh_token!, publicClientId, `${defaultResourceUri}/api.read`);
    expect(valid.statusCode).toBe(200);
    expect(decodeJwt(valid.json<Tokens>().access_token).scp).toBe("api.read");
  });
  it("issues a new refresh token without revoking the old one", async () => {
    const { tokens } = await login();
    const first = (await refresh(tokens.refresh_token!)).json<Tokens>();
    const second = await refresh(tokens.refresh_token!);
    expect(second.statusCode).toBe(200);
    expect(first.refresh_token).not.toBe(tokens.refresh_token);
    expect((await refresh(first.refresh_token!)).statusCode).toBe(200);
  });
  it("respects explicit OIDC scope narrowing without reducing the refresh grant", async () => {
    const { tokens } = await login(
      publicClientId,
      `openid profile email offline_access ${defaultResourceUri}/api.read`,
    );
    const narrowed = await refresh(tokens.refresh_token!, publicClientId, `openid ${defaultResourceUri}/api.read`);
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    for (const token of [narrowed.json<Tokens>().id_token!, narrowed.json<Tokens>().access_token]) {
      const claims = decodeJwt(token);
      for (const claim of ["name", "oid", "preferred_username", "email"]) expect(claims).not.toHaveProperty(claim);
    }
    const apiOnly = await refresh(tokens.refresh_token!, publicClientId, `${defaultResourceUri}/api.read`);
    expect(apiOnly.json()).not.toHaveProperty("id_token");
    const restored = await refresh(narrowed.json<Tokens>().refresh_token!);
    expect(decodeJwt(restored.json<Tokens>().id_token!)).toHaveProperty("email");
  });
  it.each(["GET", "POST"] as const)(
    "applies plain PKCE and offline consent to %s authorize with a trailing slash",
    async (method) => {
      const flow = await authorize(context, config, { method, trailingSlash: true, pkce: "plain" });
      const exchanged = await tokenRequest(context, config, {
        grant_type: "authorization_code",
        client_id: publicClientId,
        redirect_uri: "http://localhost:3000/callback",
        code: flow.code,
        code_verifier: flow.verifier,
      });
      expect(exchanged.statusCode, exchanged.body).toBe(200);
      expect(exchanged.json<Tokens>().refresh_token).toBeTypeOf("string");
    },
  );
  it("applies diagnostics, metadata, JWT faults and rollover JWKS with a trailing slash", async () => {
    const metadata = (await context.app.inject(`${config.issuerPath}/.well-known/openid-configuration/`)).json();
    expect(metadata.token_endpoint).toBe(config.issuerOrigin + config.tokenPath);
    expect(metadata.code_challenge_methods_supported).toEqual(["S256", "plain"]);
    const flow = await authorize(context, config);
    context.store.set({ scenario: "SIGNING_KEY_ROLLOVER", mode: "LIMITED", failureCount: 1 });
    const response = await context.app.inject({
      method: "POST",
      url: config.tokenPath + "/",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: publicClientId,
        redirect_uri: "http://localhost:3000/callback",
        code: flow.code,
        code_verifier: flow.verifier,
      }).toString(),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(context.store.get().lastCompleted?.triggeredCount).toBe(1);
    await jwtVerify(
      response.json<Tokens>().id_token!,
      createLocalJWKSet((await context.app.inject(config.jwksPath + "/")).json()),
    );
    const error = await context.app.inject({
      method: "POST",
      url: config.tokenPath + "/",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "grant_type=unknown",
    });
    expect(error.json()).toHaveProperty("trace_id");
  });
  it.each(["https:", "HTTPS:"].flatMap((scheme) => ["localhost", "127.0.0.1"].map((host) => ({ scheme, host }))))(
    "accepts native schemes alongside $scheme//$host redirects",
    async ({ scheme, host }) => {
      const { clientId, ...client } = context.clientStore.list()[0]!;
      const redirectUri = `${scheme}//${host}:3000/callback`;
      await context.clientStore.update(clientId, {
        ...client,
        redirectUris: [
          { type: "native", uri: "com.example.app:/callback" },
          { type: "native", uri: redirectUri },
        ],
      });
      const flow = await authorize(context, config, { redirectUri });
      const response = await tokenRequest(context, config, {
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: redirectUri,
        code: flow.code,
        code_verifier: flow.verifier,
      });
      expect(response.statusCode, response.body).toBe(200);
    },
  );
  it("preserves the original SPA 24-hour deadline", async () => {
    const start = Date.now(),
      { tokens } = await login(spaClientId);
    vi.useFakeTimers({ toFake: ["Date"], now: start + 23 * 3600000 });
    const rotated = (await refresh(tokens.refresh_token!, spaClientId)).json<Tokens>();
    expect(rotated.refresh_token).toBeTypeOf("string");
    vi.setSystemTime(start + 24 * 3600000 + 1000);
    for (const token of [tokens.refresh_token!, rotated.refresh_token!])
      expect((await refresh(token, spaClientId)).statusCode).toBe(400);
  });
  it.each([publicClientId, confidentialClientId])("uses a 90-day non-SPA refresh lifetime for %s", async (clientId) => {
    const start = Date.now(),
      { tokens } = await login(clientId);
    vi.useFakeTimers({ toFake: ["Date"], now: start + 89 * 86400000 });
    expect((await refresh(tokens.refresh_token!, clientId)).statusCode).toBe(200);
    vi.setSystemTime(start + 90 * 86400000 + 1000);
    expect((await refresh(tokens.refresh_token!, clientId)).statusCode).toBe(400);
  });
  it("redeems each authorization code at most once under concurrency", async () => {
    const flow = await authorize(context, config),
      params = {
        grant_type: "authorization_code",
        client_id: publicClientId,
        redirect_uri: "http://localhost:3000/callback",
        code: flow.code,
        code_verifier: flow.verifier,
      };
    const responses = await Promise.all([tokenRequest(context, config, params), tokenRequest(context, config, params)]);
    expect(responses.map((item) => item.statusCode).sort()).toEqual([200, 400]);
  });
  it("matches localhost ports while preserving the code's exact redirect URI", async () => {
    const flow = await authorize(context, config, { redirectUri: "http://localhost:49152/callback" });
    const response = await tokenRequest(context, config, {
      grant_type: "authorization_code",
      client_id: publicClientId,
      redirect_uri: "http://localhost:49152/callback",
      code: flow.code,
      code_verifier: flow.verifier,
    });
    expect(response.statusCode, response.body).toBe(200);
  });
  it("supports registered custom native schemes", async () => {
    const { clientId, ...client } = context.clientStore.list()[0]!;
    await context.clientStore.update(clientId, {
      ...client,
      redirectUris: [{ type: "native", uri: "com.example.app:/callback" }],
    });
    const flow = await authorize(context, config, { redirectUri: "com.example.app:/callback" });
    const response = await tokenRequest(context, config, {
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: "com.example.app:/callback",
      code: flow.code,
      code_verifier: flow.verifier,
    });
    expect(response.statusCode, response.body).toBe(200);
  });
  it("publishes actual capabilities and limits token CORS to registered SPA origins", async () => {
    const metadata = (await context.app.inject(`${config.issuerPath}/.well-known/openid-configuration`)).json();
    expect(metadata.code_challenge_methods_supported).toEqual(["S256", "plain"]);
    expect(metadata).not.toHaveProperty("pushed_authorization_request_endpoint");
    expect(metadata).not.toHaveProperty("dpop_signing_alg_values_supported");
    expect(metadata.claim_types_supported).toEqual(["normal", "distributed"]);
    for (const origin of ["http://localhost:3000", "https://evil.test"]) {
      const response = await context.app.inject({
        method: "OPTIONS",
        url: config.tokenPath,
        headers: { origin, "access-control-request-method": "POST" },
      });
      expect(response.statusCode).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe(origin.includes("evil") ? undefined : origin);
    }
    const auth = await context.app.inject({ url: config.authorizePath, headers: { origin: "http://localhost:3000" } });
    expect(auth.headers["access-control-allow-origin"]).toBeUndefined();
  });
  it("permits MSAL telemetry and routing headers in SPA token preflights", async () => {
    const requested = [
      "content-type",
      "x-client-current-telemetry",
      "x-client-last-telemetry",
      "x-ms-lib-capability",
      "x-anchormailbox",
      "x-app-name",
      "x-app-ver",
    ];
    const response = await context.app.inject({
      method: "OPTIONS",
      url: config.tokenPath,
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "POST",
        "access-control-request-headers": requested.join(", "),
      },
    });
    expect(response.statusCode).toBe(204);
    const allowed = String(response.headers["access-control-allow-headers"]).toLowerCase().split(/,\s*/);
    for (const header of requested) expect(allowed).toContain(header);
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });
  it.each(
    ["GET", "POST"].flatMap((method) =>
      [false, true].map((trailingSlash) => ({ method: method as "GET" | "POST", trailingSlash })),
    ),
  )(
    "logs out through $method (trailing slash: $trailingSlash) without optional client hints and preserves refresh tokens",
    async ({ method, trailingSlash }) => {
      const { tokens, jar } = await login();
      const params = new URLSearchParams({ post_logout_redirect_uri: "http://localhost:3000/callback" });
      let response = await context.app.inject({
        method,
        url: config.logoutPath + (trailingSlash ? "/" : "") + (method === "GET" ? `?${params}` : ""),
        headers: { cookie: jar, ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
        ...(method === "POST" ? { payload: params.toString() } : {}),
      });
      const action = /<form[^>]+action="([^"]+)"/.exec(response.body)?.[1];
      const xsrf = /name="xsrf" value="([^"]+)"/.exec(response.body)?.[1];
      expect(action, response.body).toBeTruthy();
      const nextJar = cookieJar(jar, response.headers);
      response = await context.app.inject({
        method: "POST",
        url: new URL(action!, config.issuer).pathname,
        headers: { cookie: nextJar, "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ xsrf: xsrf!, logout: "yes" }).toString(),
      });
      expect(response.headers.location).toBe("http://localhost:3000/callback");
      expect((await refresh(tokens.refresh_token!)).statusCode).toBe(200);
    },
  );
  it("returns JSON diagnostic fields for token errors regardless of Accept", async () => {
    const response = await tokenRequest(
      context,
      config,
      {
        grant_type: "authorization_code",
        client_id: publicClientId,
        code: "missing",
        redirect_uri: "http://localhost:3000/callback",
      },
      { accept: "text/html" },
    );
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "invalid_grant",
      error_codes: expect.any(Array),
      trace_id: expect.any(String),
      correlation_id: expect.any(String),
      timestamp: expect.any(String),
    });
  });
  it("retains subjects across a process restart", async () => {
    const original = (await login()).tokens;
    await context.app.close();
    context = await buildApp(config, { https: false });
    const restarted = (await login()).tokens;
    expect(decodeJwt(restarted.id_token!).sub).toBe(decodeJwt(original.id_token!).sub);
    expect(decodeJwt(restarted.access_token).sub).toBe(decodeJwt(original.access_token).sub);
  });
  it("binds code and refresh behavior to the URI type at authorization time", async () => {
    const flow = await authorize(context, config);
    const { clientId, ...client } = context.clientStore.list()[0]!;
    await context.clientStore.update(clientId, {
      ...client,
      redirectUris: [{ uri: "http://localhost:3000/callback", type: "spa" }],
    });
    const exchanged = await tokenRequest(context, config, {
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: "http://localhost:3000/callback",
      code: flow.code,
      code_verifier: flow.verifier,
    });
    expect(exchanged.statusCode, exchanged.body).toBe(200);
    expect((await refresh(exchanged.json<Tokens>().refresh_token!)).statusCode).toBe(200);
    const spaFlow = await authorize(context, config, { clientId });
    await context.clientStore.update(clientId, client);
    const denied = await tokenRequest(context, config, {
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: "http://localhost:3000/callback",
      code: spaFlow.code,
      code_verifier: spaFlow.verifier,
    });
    expect(denied.statusCode).toBe(400);
  });
  it("leaves inapplicable JWT and claim faults unconsumed", async () => {
    context.store.set({ scenario: "MISSING_CLAIM", mode: "LIMITED", failureCount: 1, parameters: { claim: "oid" } });
    await login(publicClientId, "openid");
    expect(context.store.get().remainingFailures).toBe(1);
    context.store.set({ scenario: "WRONG_AUDIENCE", mode: "LIMITED", failureCount: 1 });
    await login(publicClientId, "profile");
    expect(context.store.get().remainingFailures).toBe(1);
    const { sub, ...user } = context.userStore.find("user-admin")!;
    await context.userStore.update(sub, { ...user, groups: [] });
    context.store.set({ scenario: "NO_GROUPS", mode: "LIMITED", failureCount: 1 });
    await login();
    expect(context.store.get().remainingFailures).toBe(1);
  });
  it.each(["application/json", "*/*"])("adds diagnostics to %s token errors", async (accept) => {
    const response = await tokenRequest(
      context,
      config,
      {
        grant_type: "authorization_code",
        client_id: publicClientId,
        code: "missing",
        redirect_uri: "http://localhost:3000/callback",
      },
      { accept },
    );
    expect(response.json()).toMatchObject({
      error: "invalid_grant",
      trace_id: expect.any(String),
      error_codes: [70000],
    });
  });
  it.each([
    { resource: "api://unsupported" },
    { claims: JSON.stringify({ id_token: { acrs: { essential: true } } }) },
    { dpop_jkt: "unsupported-key-thumbprint" },
    { scope: "urn:mock:offline_access" },
  ])("explicitly rejects unsupported request semantics %#", async (extra) => {
    const params = new URLSearchParams({
      client_id: publicClientId,
      redirect_uri: "http://localhost:3000/callback",
      response_type: "code",
      scope: "openid",
      ...extra,
    });
    const response = await context.app.inject({ url: config.authorizePath + "?" + params.toString() });
    expect(response.statusCode).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(response.json()).toMatchObject({ error: expect.any(String), trace_id: expect.any(String) });
    expect(response.headers["cache-control"]).toBe("no-store");
    const trailing = await context.app.inject({ url: config.authorizePath + "/?" + params.toString() });
    expect(trailing.statusCode).toBe(400);
    expect(trailing.headers.location).toBeUndefined();
  });
  it("rejects unsupported DPoP proofs without consuming authorization codes", async () => {
    const flow = await authorize(context, config);
    const params = {
      grant_type: "authorization_code",
      client_id: publicClientId,
      redirect_uri: "http://localhost:3000/callback",
      code: flow.code,
      code_verifier: flow.verifier,
    };
    const rejected = await tokenRequest(context, config, params, { dpop: "unsupported-proof" });
    expect(rejected.statusCode, rejected.body).toBe(400);
    expect(rejected.json().error).toBe("invalid_request");
    expect(rejected.json()).toHaveProperty("trace_id");
    expect((await tokenRequest(context, config, params)).statusCode).toBe(200);
  });
  it.each(["GET", "POST"] as const)(
    "rejects excessive %s fields instead of silently discarding protocol parameters",
    async (method) => {
      const params = new URLSearchParams({
        client_id: publicClientId,
        response_type: "code",
        scope: "openid",
        redirect_uri: "http://localhost:3000/callback",
      });
      for (let index = 0; index < 1000; index++) params.append("unused" + index, "");
      params.append("claims", "{}");
      const response = await context.app.inject({
        method,
        url: config.authorizePath + (method === "GET" ? `?${params}` : ""),
        ...(method === "POST"
          ? { headers: { "content-type": "application/x-www-form-urlencoded" }, payload: params.toString() }
          : {}),
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.headers.location).toBeUndefined();
      expect(response.json()).toMatchObject({
        error: "invalid_request",
        error_description: "too many request parameters",
      });
    },
  );
  it("permits SPA localhost ephemeral ports for code exchange and refresh", async () => {
    const redirectUri = "http://localhost:49153/callback",
      origin = "http://localhost:49153";
    const flow = await authorize(context, config, { clientId: spaClientId, redirectUri });
    const response = await tokenRequest(
      context,
      config,
      {
        grant_type: "authorization_code",
        client_id: spaClientId,
        redirect_uri: redirectUri,
        code: flow.code,
        code_verifier: flow.verifier,
      },
      { origin },
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(origin);
    const refreshed = await tokenRequest(
      context,
      config,
      { grant_type: "refresh_token", client_id: spaClientId, refresh_token: response.json<Tokens>().refresh_token! },
      { origin },
    );
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect(refreshed.headers["access-control-allow-origin"]).toBe(origin);
  });
  it.each(
    ["authorization_code", "refresh_token"].flatMap((grantType) =>
      [publicClientId, confidentialClientId, spaClientId].map((clientId) => ({ grantType, clientId })),
    ),
  )(
    "rejects excessive $grantType fields for $clientId before a trailing scope can be discarded",
    async ({ grantType, clientId }) => {
      const scope = `openid offline_access ${defaultResourceUri}/api.read ${defaultResourceUri}/api.write`;
      const flow = await authorize(context, config, { scope, clientId });
      const codeParams = {
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: "http://localhost:3000/callback",
        code: flow.code,
        code_verifier: flow.verifier,
        ...credentials(clientId),
      };
      const params = new URLSearchParams(
        grantType === "authorization_code"
          ? codeParams
          : {
              grant_type: "refresh_token",
              client_id: clientId,
              refresh_token: (await tokenRequest(context, config, codeParams, headers(clientId))).json<Tokens>()
                .refresh_token!,
              ...credentials(clientId),
            },
      );
      while (params.size < 1000) params.append("unused", "");
      params.append("scope", `${defaultResourceUri}/api.read`);
      const rejected = await context.app.inject({
        method: "POST",
        url: config.tokenPath,
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html", ...headers(clientId) },
        payload: params.toString(),
      });
      expect(rejected.statusCode, rejected.body).toBe(400);
      expect(rejected.json()).toMatchObject({
        error: "invalid_request",
        error_description: "too many request parameters",
        trace_id: expect.any(String),
      });
      expect(rejected.headers["cache-control"]).toBe("no-store");
      expect(rejected.headers["pragma"]).toBe("no-cache");
      params.delete("unused");
      expect(rejected.headers["access-control-allow-origin"]).toBe(headers(clientId).origin);
      const retry = await tokenRequest(context, config, Object.fromEntries(params), headers(clientId));
      expect(retry.statusCode, retry.body).toBe(200);
      expect(decodeJwt(retry.json<Tokens>().access_token).scp).toBe("api.read");
    },
  );
  it("accepts the token field limit and retains a trailing duplicate scope for validation", async () => {
    const { tokens } = await login();
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: publicClientId,
      refresh_token: tokens.refresh_token!,
      scope: `${defaultResourceUri}/api.read`,
    });
    while (params.size < 999) params.append("unused", "");
    params.append("scope", `${defaultResourceUri}/api.write`);
    const rejected = await context.app.inject({
      method: "POST",
      url: config.tokenPath,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: params.toString(),
    });
    expect(rejected.statusCode, rejected.body).toBe(400);
    expect(rejected.json().error).toBe("invalid_request");
    params.delete("scope");
    params.append("scope", `${defaultResourceUri}/api.read`);
    params.append("unused", "");
    const accepted = await context.app.inject({
      method: "POST",
      url: config.tokenPath,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: params.toString(),
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(decodeJwt(accepted.json<Tokens>().access_token).scp).toBe("api.read");
  });
});
