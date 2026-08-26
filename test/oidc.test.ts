import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  jwtVerify,
} from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp, type AppContext } from "../src/app.js";
import { testConfig } from "./test-config.js";

const host = "mock-idp.test:9000";
const authorizePath = "/oauth2/v2.0/authorize";
const tokenPath = "/oauth2/v2.0/token";
const jwksPath = "/discovery/v2.0/keys";
function cookies(current: string, headers: OutgoingHttpHeaders): string {
  const jar = new Map(
    current
      .split("; ")
      .filter(Boolean)
      .map((part) => [part.split("=")[0]!, part]),
  );
  const values = headers["set-cookie"];
  for (const cookie of Array.isArray(values)
    ? values
    : values
      ? [values]
      : []) {
    const pair = cookie.split(";")[0]!;
    jar.set(pair.split("=")[0]!, pair);
  }
  return [...jar.values()].join("; ");
}

describe("OIDC provider", () => {
  let context: AppContext;
  let stateDirectory: string;
  beforeAll(async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), "mock-idp-oidc-"));
    context = await buildApp(
      testConfig({
        issuer: `http://${host}`,
        keyDirectory: join(stateDirectory, "keys"),
        clientConfigFile: join(stateDirectory, "clients.json"),
      }),
      { https: false },
    );
  });
  afterAll(async () => {
    try {
      await context.app.close();
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  async function authorize(
    verifier = randomBytes(32).toString("base64url"),
    challenge = "",
    clientId = "mock-public-client",
    scope = "openid profile",
  ): Promise<{ code: string; verifier: string }> {
    challenge ||= createHash("sha256").update(verifier).digest("base64url");
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: "http://localhost:3000/callback",
      response_type: "code",
      scope,
      state: "test-state",
      nonce: "test-nonce",
      code_challenge: challenge,
      code_challenge_method: "S256",
      ...(scope.includes("offline_access") ? { prompt: "consent" } : {}),
    });
    let jar = "";
    let response = await context.app.inject({
      url: `${authorizePath}?${query}`,
      headers: { host, cookie: jar },
    });
    jar = cookies(jar, response.headers);
    expect(response.statusCode).toBe(303);
    const interactionLocation = new URL(
      String(response.headers.location),
      `http://${host}`,
    );
    const interactionUrl = `${interactionLocation.pathname}${interactionLocation.search}`;
    response = await context.app.inject({
      url: interactionUrl,
      headers: { host, cookie: jar },
    });
    jar = cookies(jar, response.headers);
    expect(response.body).toContain("Select a test user");
    response = await context.app.inject({
      method: "POST",
      url: interactionUrl,
      headers: {
        host,
        cookie: jar,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "accountId=user-admin",
    });
    jar = cookies(jar, response.headers);
    for (
      let i = 0;
      i < 5 &&
      response.headers.location &&
      !String(response.headers.location).startsWith("http://localhost:3000");
      i++
    ) {
      const next = new URL(String(response.headers.location), `http://${host}`);
      response = await context.app.inject({
        url: `${next.pathname}${next.search}`,
        headers: { host, cookie: jar },
      });
      jar = cookies(jar, response.headers);
    }
    const callback = new URL(String(response.headers.location));
    expect(callback.searchParams.get("state")).toBe("test-state");
    return { code: String(callback.searchParams.get("code")), verifier };
  }

  async function exchange(
    code: string,
    verifier?: string,
    options: {
      clientId?: string;
      clientSecret?: string;
      redirectUri?: string;
    } = {},
  ) {
    const clientId = options.clientId ?? "mock-public-client";
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: options.redirectUri ?? "http://localhost:3000/callback",
      code,
      ...(verifier ? { code_verifier: verifier } : {}),
    });
    return context.app.inject({
      method: "POST",
      url: tokenPath,
      headers: {
        host,
        "content-type": "application/x-www-form-urlencoded",
        ...(options.clientSecret !== undefined
          ? {
              authorization: `Basic ${Buffer.from(`${clientId}:${options.clientSecret}`).toString("base64")}`,
            }
          : {}),
      },
      payload: body.toString(),
    });
  }

  it("completes S256 flow with verifiable ID and access JWTs", async () => {
    const discovery = await context.app.inject({
      url: "/.well-known/openid-configuration",
      headers: { host },
    });
    expect(discovery.json()).toMatchObject({
      issuer: `http://${host}`,
      authorization_endpoint: `http://${host}${authorizePath}`,
      token_endpoint: `http://${host}${tokenPath}`,
      jwks_uri: `http://${host}${jwksPath}`,
      code_challenge_methods_supported: ["S256"],
    });
    const flow = await authorize();
    const response = await exchange(flow.code, flow.verifier);
    expect(response.statusCode, response.body).toBe(200);
    const tokens = response.json<{ id_token: string; access_token: string }>();
    expect(decodeProtectedHeader(tokens.id_token)).not.toHaveProperty("typ");
    expect(decodeProtectedHeader(tokens.access_token).typ).toBe("at+jwt");
    const jwks = (
      await context.app.inject({ url: jwksPath, headers: { host } })
    ).json();
    const id = await jwtVerify(tokens.id_token, createLocalJWKSet(jwks), {
      issuer: `http://${host}`,
      audience: "mock-public-client",
    });
    expect(id.payload).toMatchObject({
      iss: `http://${host}`,
      sub: "user-admin",
      groups: ["app-admin-group-id", "app-user-group-id"],
      nonce: "test-nonce",
      ver: "2.0",
    });
    expect(id.payload.mail).toBeUndefined();
    expect(id.payload.email).toBeUndefined();
    expect(id.payload.sid).toBeTypeOf("string");
    expect(id.payload.nbf).toBe(id.payload.iat);
    const access = await jwtVerify(
      tokens.access_token,
      createLocalJWKSet(jwks),
      {
        issuer: `http://${host}`,
        audience: "urn:mock-api",
      },
    );
    expect(access.payload).toMatchObject({
      iss: `http://${host}`,
      sub: "user-admin",
      ver: "2.0",
      azp: "mock-public-client",
      azpacr: "0",
      scp: "access_as_user",
    });
    expect(access.payload.mail).toBeUndefined();
    expect(access.payload.email).toBeUndefined();
    expect(access.payload.sid).toBe(id.payload.sid);
    expect(access.payload.nbf).toBe(access.payload.iat);
  });

  it("supports the confidential client with client_secret_basic and PKCE", async () => {
    const flow = await authorize(undefined, "", "mock-confidential-client");
    expect(
      (
        await exchange(flow.code, flow.verifier, {
          clientId: "mock-confidential-client",
          clientSecret: "mock-client-secret-change-me",
        })
      ).statusCode,
    ).toBe(200);
  });

  it("rejects an unknown authorization code with invalid_grant", async () => {
    const response = await exchange(
      "unknown-authorization-code",
      randomBytes(32).toString("base64url"),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("rejects an expired authorization code with invalid_grant", async () => {
    const flow = await authorize();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 601_000 });
    try {
      const response = await exchange(flow.code, flow.verifier);

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: "invalid_grant" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects reuse of a consumed authorization code with invalid_grant", async () => {
    const flow = await authorize();
    const first = await exchange(flow.code, flow.verifier);
    expect(first.statusCode, first.body).toBe(200);

    const reused = await exchange(flow.code, flow.verifier);
    expect(reused.statusCode).toBe(400);
    expect(reused.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("rejects a token redirect_uri mismatch with invalid_grant", async () => {
    const flow = await authorize();
    const response = await exchange(flow.code, flow.verifier, {
      redirectUri: "http://localhost:3000/other-callback",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("rejects a wrong confidential client secret without consuming the code", async () => {
    const flow = await authorize(undefined, "", "mock-confidential-client");
    const rejected = await exchange(flow.code, flow.verifier, {
      clientId: "mock-confidential-client",
      clientSecret: "wrong-client-secret",
    });

    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toMatchObject({ error: "invalid_client" });
    expect(rejected.headers["www-authenticate"]).toMatch(/^Basic /);
    expect(rejected.headers["www-authenticate"]).toContain(
      'error="invalid_client"',
    );

    const accepted = await exchange(flow.code, flow.verifier, {
      clientId: "mock-confidential-client",
      clientSecret: "mock-client-secret-change-me",
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
  });

  it("issues a refresh token to a public client requesting offline_access", async () => {
    const flow = await authorize(
      undefined,
      "",
      "mock-public-client",
      "openid offline_access",
    );
    const response = await exchange(flow.code, flow.verifier);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ refresh_token: string }>().refresh_token).toBeTypeOf(
      "string",
    );
  });

  it("uses a dynamic client's auth method and audience and scopes email claims", async () => {
    await context.clientStore.create({
      clientId: "dynamic-post-client",
      clientType: "CONFIDENTIAL",
      clientSecret: "post-secret",
      tokenEndpointAuthMethod: "client_secret_post",
      redirectUris: ["http://localhost:3000/callback"],
      postLogoutRedirectUris: ["http://localhost:3000/signed-out"],
      accessTokenAudience: "urn:dynamic-api",
      accessTokenScope: "access_as_user",
      emailOptionalClaim: false,
    });
    const flow = await authorize(
      undefined,
      "",
      "dynamic-post-client",
      "openid profile email offline_access",
    );
    const response = await context.app.inject({
      method: "POST",
      url: tokenPath,
      headers: { host, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "dynamic-post-client",
        client_secret: "post-secret",
        redirect_uri: "http://localhost:3000/callback",
        code: flow.code,
        code_verifier: flow.verifier,
      }).toString(),
    });
    expect(response.statusCode, response.body).toBe(200);
    const tokens = response.json<{
      id_token: string;
      access_token: string;
      refresh_token: string;
    }>();
    expect(decodeJwt(tokens.id_token).email).toBe("admin@example.com");
    expect(decodeJwt(tokens.access_token).email).toBe("admin@example.com");
    expect(decodeJwt(tokens.access_token).aud).toBe("urn:dynamic-api");
    expect(decodeJwt(tokens.access_token).azp).toBe("dynamic-post-client");
    expect(decodeJwt(tokens.access_token).azpacr).toBe("1");
    expect(decodeJwt(tokens.access_token).scp).toBe("access_as_user");
    expect(tokens.refresh_token).toBeTypeOf("string");
    await context.clientStore.delete("dynamic-post-client");
    const rejected = await context.app.inject({
      url:
        `${authorizePath}?` +
        new URLSearchParams({
          client_id: "dynamic-post-client",
          redirect_uri: "http://localhost:3000/callback",
          response_type: "code",
          scope: "openid",
          code_challenge: "a".repeat(43),
          code_challenge_method: "S256",
        }).toString(),
      headers: { host },
    });
    expect(rejected.statusCode).toBe(400);
  });

  it("includes email without the email scope when emailOptionalClaim is enabled", async () => {
    await context.clientStore.create({
      clientId: "email-optional-claim-client",
      clientType: "PUBLIC",
      tokenEndpointAuthMethod: "none",
      redirectUris: ["http://localhost:3000/callback"],
      postLogoutRedirectUris: [],
      accessTokenAudience: "urn:mock-api",
      accessTokenScope: "access_as_user",
      emailOptionalClaim: true,
    });
    const flow = await authorize(
      undefined,
      "",
      "email-optional-claim-client",
      "openid profile",
    );
    const response = await exchange(flow.code, flow.verifier, {
      clientId: "email-optional-claim-client",
    });
    expect(response.statusCode, response.body).toBe(200);
    const tokens = response.json<{ id_token: string; access_token: string }>();
    expect(decodeJwt(tokens.id_token).email).toBe("admin@example.com");
    expect(decodeJwt(tokens.access_token).email).toBe("admin@example.com");
    await context.clientStore.delete("email-optional-claim-client");
  });

  it("returns ACCESS_DENIED through the OIDC redirect flow", async () => {
    context.store.set({
      scenario: "ACCESS_DENIED",
      mode: "LIMITED",
      failureCount: 1,
      parameters: {},
    });
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const query = new URLSearchParams({
      client_id: "mock-public-client",
      redirect_uri: "http://localhost:3000/callback",
      response_type: "code",
      scope: "openid",
      state: "denied-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const start = await context.app.inject({
      url: `${authorizePath}?${query}`,
      headers: { host },
    });
    const interaction = new URL(
      String(start.headers.location),
      `http://${host}`,
    );
    const denied = await context.app.inject({
      url: interaction.pathname,
      headers: { host, cookie: cookies("", start.headers) },
    });
    const resume = new URL(String(denied.headers.location), `http://${host}`);
    const completed = await context.app.inject({
      url: `${resume.pathname}${resume.search}`,
      headers: {
        host,
        cookie: cookies(cookies("", start.headers), denied.headers),
      },
    });
    const callback = new URL(String(completed.headers.location));
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("state")).toBe("denied-state");
    expect(context.store.get().scenario).toBe("NORMAL");
  });

  it("rejects missing, mismatched, and malformed PKCE data", async () => {
    let flow = await authorize();
    const missing = await exchange(flow.code);
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: "invalid_grant" });

    flow = await authorize();
    const mismatched = await exchange(
      flow.code,
      "different-verifier-that-is-long-enough-123456789",
    );
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json()).toMatchObject({ error: "invalid_grant" });

    const query = new URLSearchParams({
      client_id: "mock-public-client",
      redirect_uri: "http://localhost:3000/callback",
      response_type: "code",
      scope: "openid",
      code_challenge: "bad",
      code_challenge_method: "S256",
    });
    const malformed = await context.app.inject({
      url: `${authorizePath}?${query}`,
      headers: { host },
    });
    expect(malformed.statusCode).toBe(303);
    expect(String(malformed.headers.location)).toContain(
      "error=invalid_request",
    );
  });

  it("limits HTTP faults to their endpoint and count", async () => {
    context.store.set({
      scenario: "TOKEN_500",
      mode: "LIMITED",
      failureCount: 2,
      parameters: {},
    });
    expect(
      (await context.app.inject({ url: jwksPath, headers: { host } }))
        .statusCode,
    ).toBe(200);
    expect((await exchange("bad", "bad")).statusCode).toBe(500);
    expect((await exchange("bad", "bad")).statusCode).toBe(500);
    expect((await exchange("bad", "bad")).statusCode).toBe(400);
    expect(context.store.get().scenario).toBe("NORMAL");
  });

  it("returns configurable TOKEN_400 OAuth errors", async () => {
    context.store.set({
      scenario: "TOKEN_400",
      mode: "LIMITED",
      failureCount: 1,
      parameters: {
        error: "temporarily_unavailable",
        errorDescription: "planned test failure",
      },
    });
    const response = await exchange("not-a-code", "not-a-verifier");
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "temporarily_unavailable",
      error_description: "planned test failure",
    });
    expect(context.store.get().scenario).toBe("NORMAL");
  });

  it.each([
    ["JWKS_500", jwksPath],
    ["DISCOVERY_500", "/.well-known/openid-configuration"],
  ] as const)("injects %s only at its endpoint", async (scenario, url) => {
    context.store.set({
      scenario,
      mode: "LIMITED",
      failureCount: 1,
      parameters: {},
    });
    expect(
      (await context.app.inject({ url, headers: { host } })).statusCode,
    ).toBe(500);
    expect(context.store.get().scenario).toBe("NORMAL");
  });

  it("delays timeout targets and consumes on acceptance", async () => {
    context.store.set({
      scenario: "DISCOVERY_TIMEOUT",
      mode: "LIMITED",
      failureCount: 1,
      parameters: { delayMs: 50 },
    });
    const started = Date.now();
    expect(
      (
        await context.app.inject({
          url: "/.well-known/openid-configuration",
          headers: { host },
        })
      ).statusCode,
    ).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(context.store.get().scenario).toBe("NORMAL");
  });

  it("mutates each claim/JWT scenario", async () => {
    for (const scenario of [
      "NO_GROUPS",
      "WRONG_AUDIENCE",
      "WRONG_ISSUER",
      "EXPIRED_TOKEN",
      "FUTURE_NBF",
      "INVALID_SIGNATURE",
      "UNKNOWN_KID",
    ] as const) {
      const flow = await authorize();
      context.store.set({
        scenario,
        mode: "LIMITED",
        failureCount: 1,
        parameters: {},
      });
      const response = await exchange(flow.code, flow.verifier);
      expect(response.statusCode, response.body).toBe(200);
      const tokens = response.json<{
        id_token: string;
        access_token: string;
      }>();
      const payload = decodeJwt(tokens.id_token);
      const accessPayload = decodeJwt(tokens.access_token);
      expect(decodeProtectedHeader(tokens.id_token)).not.toHaveProperty("typ");
      expect(decodeProtectedHeader(tokens.access_token).typ).toBe("at+jwt");
      expect(payload.sid).toBeTypeOf("string");
      expect(accessPayload.sid).toBe(payload.sid);
      const jwks = (
        await context.app.inject({ url: jwksPath, headers: { host } })
      ).json();
      const tokenCases = [
        {
          token: tokens.id_token,
          claims: payload,
          audience: "mock-public-client",
        },
        {
          token: tokens.access_token,
          claims: accessPayload,
          audience: "urn:mock-api",
        },
      ] as const;
      if (scenario === "NO_GROUPS") {
        expect(payload.groups).toBeUndefined();
        expect(accessPayload.groups).toBeUndefined();
      }
      if (scenario === "NO_GROUPS") {
        for (const tokenCase of tokenCases)
          await expect(
            jwtVerify(tokenCase.token, createLocalJWKSet(jwks), {
              issuer: `http://${host}`,
              audience: tokenCase.audience,
            }),
          ).resolves.toBeDefined();
      }
      if (scenario === "WRONG_AUDIENCE") {
        expect(payload.aud).toBe("unexpected-audience");
        expect(accessPayload.aud).toBe("unexpected-audience");
        for (const tokenCase of tokenCases) {
          await expect(
            jwtVerify(tokenCase.token, createLocalJWKSet(jwks), {
              issuer: `http://${host}`,
            }),
          ).resolves.toBeDefined();
          await expect(
            jwtVerify(tokenCase.token, createLocalJWKSet(jwks), {
              issuer: `http://${host}`,
              audience: tokenCase.audience,
            }),
          ).rejects.toMatchObject({
            code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
            claim: "aud",
          });
        }
      }
      if (scenario === "WRONG_ISSUER") {
        expect(payload.iss).toBe("https://wrong-issuer.invalid");
        expect(accessPayload.iss).toBe("https://wrong-issuer.invalid");
        for (const tokenCase of tokenCases) {
          await expect(
            jwtVerify(tokenCase.token, createLocalJWKSet(jwks), {
              audience: tokenCase.audience,
            }),
          ).resolves.toBeDefined();
          await expect(
            jwtVerify(tokenCase.token, createLocalJWKSet(jwks), {
              issuer: `http://${host}`,
              audience: tokenCase.audience,
            }),
          ).rejects.toMatchObject({
            code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
            claim: "iss",
          });
        }
      }
      if (scenario === "EXPIRED_TOKEN") {
        expect(payload.exp).toBeLessThan(Date.now() / 1000);
        expect(accessPayload.exp).toBeLessThan(Date.now() / 1000);
        for (const claims of [payload, accessPayload]) {
          expect(claims.iat).toBeLessThanOrEqual(claims.nbf as number);
          expect(claims.nbf).toBeLessThan(claims.exp as number);
        }
        for (const tokenCase of tokenCases) {
          await expect(
            jwtVerify(tokenCase.token, createLocalJWKSet(jwks), {
              issuer: `http://${host}`,
              audience: tokenCase.audience,
            }),
          ).rejects.toMatchObject({ code: "ERR_JWT_EXPIRED" });
          await expect(
            jwtVerify(tokenCase.token, createLocalJWKSet(jwks), {
              issuer: `http://${host}`,
              audience: tokenCase.audience,
              currentDate: new Date(
                ((tokenCase.claims.exp as number) - 1) * 1000,
              ),
            }),
          ).resolves.toBeDefined();
        }
      }
      if (scenario === "FUTURE_NBF") {
        expect(payload.nbf).toBeGreaterThan(Date.now() / 1000);
        expect(accessPayload.nbf).toBeGreaterThan(Date.now() / 1000);
        expect(payload.nbf).toBeLessThan(payload.exp as number);
        expect(accessPayload.nbf).toBeLessThan(accessPayload.exp as number);
        for (const tokenCase of tokenCases) {
          await expect(
            jwtVerify(tokenCase.token, createLocalJWKSet(jwks), {
              issuer: `http://${host}`,
              audience: tokenCase.audience,
            }),
          ).rejects.toMatchObject({
            code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
            claim: "nbf",
          });
          await expect(
            jwtVerify(tokenCase.token, createLocalJWKSet(jwks), {
              issuer: `http://${host}`,
              audience: tokenCase.audience,
              currentDate: new Date(
                ((tokenCase.claims.nbf as number) + 1) * 1000,
              ),
            }),
          ).resolves.toBeDefined();
        }
      }
      if (scenario === "INVALID_SIGNATURE" || scenario === "UNKNOWN_KID") {
        const expectedCode =
          scenario === "INVALID_SIGNATURE"
            ? "ERR_JWS_SIGNATURE_VERIFICATION_FAILED"
            : "ERR_JWKS_NO_MATCHING_KEY";
        const expectedKid =
          scenario === "INVALID_SIGNATURE" ? jwks.keys[0].kid : "unknown-kid";
        for (const token of [tokens.id_token, tokens.access_token]) {
          expect(decodeProtectedHeader(token).kid).toBe(expectedKid);
          await expect(
            jwtVerify(token, createLocalJWKSet(jwks)),
          ).rejects.toMatchObject({ code: expectedCode });
        }
      }
    }
  });

  it("preserves sid and the optional email claim through SIGNING_KEY_ROLLOVER", async () => {
    await context.clientStore.create({
      clientId: "rollover-email-optional-claim-client",
      clientType: "PUBLIC",
      tokenEndpointAuthMethod: "none",
      redirectUris: ["http://localhost:3000/callback"],
      postLogoutRedirectUris: [],
      accessTokenAudience: "urn:mock-api",
      accessTokenScope: "access_as_user",
      emailOptionalClaim: true,
    });
    const flow = await authorize(
      undefined,
      "",
      "rollover-email-optional-claim-client",
      "openid profile",
    );
    context.store.set({
      scenario: "SIGNING_KEY_ROLLOVER",
      mode: "LIMITED",
      failureCount: 1,
      parameters: {},
    });
    const response = await exchange(flow.code, flow.verifier, {
      clientId: "rollover-email-optional-claim-client",
    });
    expect(response.statusCode, response.body).toBe(200);
    const tokens = response.json<{ id_token: string; access_token: string }>();
    expect(decodeProtectedHeader(tokens.id_token).kid).toBe(
      "mock-rollover-key",
    );
    const payload = decodeJwt(tokens.id_token);
    expect(payload.sid).toBeTypeOf("string");
    expect(payload.email).toBe("admin@example.com");
    const jwks = (
      await context.app.inject({ url: jwksPath, headers: { host } })
    ).json();
    await expect(
      jwtVerify(tokens.id_token, createLocalJWKSet(jwks), {
        issuer: `http://${host}`,
        audience: "rollover-email-optional-claim-client",
      }),
    ).resolves.toBeDefined();
    await context.clientStore.delete("rollover-email-optional-claim-client");
  });

  it("does not consume token faults for preflight and preserves CORS/cache headers", async () => {
    context.store.set({
      scenario: "TOKEN_400",
      mode: "LIMITED",
      failureCount: 1,
    });
    const origin = "http://localhost:3000";
    const preflight = await context.app.inject({
      method: "OPTIONS",
      url: tokenPath,
      headers: {
        host,
        origin,
        "access-control-request-method": "POST",
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(origin);
    expect(preflight.headers.vary).toContain("Origin");
    expect(context.store.get().remainingFailures).toBe(1);

    const fault = await context.app.inject({
      method: "POST",
      url: tokenPath,
      headers: {
        host,
        origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "grant_type=authorization_code&code=invalid",
    });
    expect(fault.statusCode).toBe(400);
    expect(fault.headers["access-control-allow-origin"]).toBe(origin);
    expect(fault.headers.vary).toContain("Origin");
    expect(fault.headers["cache-control"]).toBe("no-store");
    expect(context.store.get().scenario).toBe("NORMAL");
  });

  it.each([
    ["TOKEN_TIMEOUT", "POST", tokenPath, 400],
    ["JWKS_TIMEOUT", "GET", jwksPath, 200],
    ["DISCOVERY_TIMEOUT", "GET", "/.well-known/openid-configuration", 200],
  ] as const)(
    "delays and consumes %s",
    async (scenario, method, url, status) => {
      context.store.set({
        scenario,
        mode: "LIMITED",
        failureCount: 1,
        parameters: { delayMs: 40 },
      });
      const started = Date.now();
      const response = await context.app.inject({
        method,
        url,
        headers: {
          host,
          ...(method === "POST"
            ? { "content-type": "application/x-www-form-urlencoded" }
            : {}),
        },
        ...(method === "POST"
          ? { payload: "grant_type=authorization_code&code=invalid" }
          : {}),
      });
      expect(response.statusCode).toBe(status);
      expect(Date.now() - started).toBeGreaterThanOrEqual(30);
      expect(context.store.get().scenario).toBe("NORMAL");
    },
  );

  it.each(["WRONG_ISSUER", "NO_GROUPS"] as const)(
    "does not retroactively apply %s activated during a token timeout",
    async (nextScenario) => {
      const flow = await authorize();
      context.store.set({
        scenario: "TOKEN_TIMEOUT",
        mode: "LIMITED",
        failureCount: 1,
        parameters: { delayMs: 75 },
      });
      const pending = exchange(flow.code, flow.verifier);
      await vi.waitFor(() =>
        expect(context.store.get().scenario).toBe("NORMAL"),
      );
      context.store.set({ scenario: nextScenario, mode: "CONTINUOUS" });

      const response = await pending;
      expect(response.statusCode, response.body).toBe(200);
      const tokens = response.json<{
        id_token: string;
        access_token: string;
      }>();
      for (const token of [tokens.id_token, tokens.access_token]) {
        expect(decodeJwt(token)).toMatchObject({
          iss: `http://${host}`,
          groups: ["app-admin-group-id", "app-user-group-id"],
        });
      }
      expect(context.store.get()).toMatchObject({
        scenario: nextScenario,
        triggeredCount: 0,
      });
      context.store.clear();
    },
  );
});
