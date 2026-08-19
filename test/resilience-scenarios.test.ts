import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type AppContext } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const host = "mock-idp.test:9000";
const issuer = `http://${host}`;

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

describe("official Entra resilience scenarios", () => {
  let context: AppContext;
  let stateDirectory: string;

  beforeAll(async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), "mock-idp-resilience-"));
    context = await buildApp(
      loadConfig({
        NODE_ENV: "test",
        OIDC_ISSUER: issuer,
        KEY_DIRECTORY: join(stateDirectory, "keys"),
        CLIENT_CONFIG_FILE: join(stateDirectory, "clients.json"),
      }),
    );
  });

  beforeEach(() => context.store.reset());

  afterAll(async () => {
    await context.app.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });

  async function authorize(): Promise<{ code: string; verifier: string }> {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const query = new URLSearchParams({
      client_id: "mock-public-client",
      redirect_uri: "http://localhost:3000/callback",
      response_type: "code",
      scope: "openid profile",
      state: randomBytes(8).toString("base64url"),
      nonce: randomBytes(8).toString("base64url"),
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    let jar = "";
    let response = await context.app.inject({
      url: `/authorize?${query}`,
      headers: { host },
    });
    jar = cookies(jar, response.headers);
    const interaction = new URL(String(response.headers.location), issuer);
    const interactionUrl = `${interaction.pathname}${interaction.search}`;
    response = await context.app.inject({
      url: interactionUrl,
      headers: { host, cookie: jar },
    });
    jar = cookies(jar, response.headers);
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
      let attempts = 0;
      attempts < 6 &&
      response.headers.location &&
      !String(response.headers.location).startsWith("http://localhost:3000");
      attempts++
    ) {
      const location = new URL(String(response.headers.location), issuer);
      response = await context.app.inject({
        url: `${location.pathname}${location.search}`,
        headers: { host, cookie: jar },
      });
      jar = cookies(jar, response.headers);
    }
    const callback = new URL(String(response.headers.location));
    return { code: String(callback.searchParams.get("code")), verifier };
  }

  async function exchange(code: string, verifier: string) {
    return context.app.inject({
      method: "POST",
      url: "/token",
      headers: {
        host,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "mock-public-client",
        redirect_uri: "http://localhost:3000/callback",
        code,
        code_verifier: verifier,
      }).toString(),
    });
  }

  async function invalidTokenRequest(origin?: string) {
    return context.app.inject({
      method: "POST",
      url: "/token",
      headers: {
        host,
        ...(origin ? { origin } : {}),
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "grant_type=authorization_code&code=invalid",
    });
  }

  it("returns TOKEN_429 with the documented Retry-After contract", async () => {
    context.store.set({
      scenario: "TOKEN_429",
      mode: "LIMITED",
      failureCount: 1,
    });
    const response = await invalidTokenRequest("http://localhost:3000");

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("60");
    expect(response.headers["access-control-expose-headers"]).toContain(
      "Retry-After",
    );
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      error: "temporarily_unavailable",
      error_description: "Injected TOKEN_429 fault",
    });
    expect(context.store.get().scenario).toBe("NORMAL");
  });

  it("adds Retry-After to TOKEN_500 only when requested", async () => {
    context.store.set({
      scenario: "TOKEN_500",
      mode: "LIMITED",
      failureCount: 1,
      parameters: { retryAfterSeconds: 7 },
    });
    let response = await invalidTokenRequest("http://localhost:3000");
    expect(response.statusCode).toBe(500);
    expect(response.headers["retry-after"]).toBe("7");
    expect(response.headers["access-control-expose-headers"]).toContain(
      "Retry-After",
    );

    context.store.set({
      scenario: "TOKEN_500",
      mode: "LIMITED",
      failureCount: 1,
    });
    response = await invalidTokenRequest();
    expect(response.statusCode).toBe(500);
    expect(response.headers["retry-after"]).toBeUndefined();
  });

  it("does not consume TOKEN_429 when the request Host is invalid", async () => {
    context.store.set({
      scenario: "TOKEN_429",
      mode: "LIMITED",
      failureCount: 1,
    });
    const rejected = await context.app.inject({
      method: "POST",
      url: "/token",
      headers: {
        host: "evil.test",
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "grant_type=authorization_code&code=invalid",
    });
    expect(rejected.statusCode).toBe(400);
    expect(context.store.get().remainingFailures).toBe(1);
    expect((await invalidTokenRequest()).statusCode).toBe(429);
  });

  it.each([
    ["DISCOVERY_INVALID", "/.well-known/openid-configuration", {}],
    [
      "JWKS_INVALID",
      "/jwks",
      { keys: [{ kty: "RSA", kid: "mock-invalid-jwk" }] },
    ],
  ] as const)("returns and recovers from %s", async (scenario, url, body) => {
    context.store.set({
      scenario,
      mode: "LIMITED",
      failureCount: 1,
    });
    const invalid = await context.app.inject({ url, headers: { host } });
    expect(invalid.statusCode).toBe(200);
    expect(invalid.json()).toEqual(body);
    expect(context.store.get().scenario).toBe("NORMAL");

    const recovered = await context.app.inject({ url, headers: { host } });
    expect(recovered.statusCode).toBe(200);
    if (scenario === "DISCOVERY_INVALID")
      expect(recovered.json()).toHaveProperty("issuer", issuer);
    else expect(recovered.json<{ keys: unknown[] }>().keys.length).toBe(1);
  });

  it("supports successful signing-key rollover and keeps both public keys until reset", async () => {
    const initialJwks = (
      await context.app.inject({ url: "/jwks", headers: { host } })
    ).json<{ keys: Array<{ kid?: string }> }>();
    expect(initialJwks.keys).toHaveLength(1);
    const initialKid = initialJwks.keys[0]?.kid;
    const flow = await authorize();

    context.store.set({
      scenario: "SIGNING_KEY_ROLLOVER",
      mode: "LIMITED",
      failureCount: 1,
    });
    const publishedJwks = (
      await context.app.inject({ url: "/jwks", headers: { host } })
    ).json<{ keys: Array<{ kid?: string }> }>();
    expect(publishedJwks.keys.map(({ kid }) => kid)).toEqual([
      initialKid,
      "mock-rollover-key",
    ]);

    const response = await exchange(flow.code, flow.verifier);
    expect(response.statusCode, response.body).toBe(200);
    const tokens = response.json<{ id_token: string; access_token: string }>();
    for (const [token, audience] of [
      [tokens.id_token, "mock-public-client"],
      [tokens.access_token, "urn:mock-api"],
    ] as const) {
      expect(decodeProtectedHeader(token).kid).toBe("mock-rollover-key");
      await expect(
        jwtVerify(token, createLocalJWKSet(initialJwks), {
          issuer,
          audience,
        }),
      ).rejects.toMatchObject({ code: "ERR_JWKS_NO_MATCHING_KEY" });
      await expect(
        jwtVerify(token, createLocalJWKSet(publishedJwks), {
          issuer,
          audience,
        }),
      ).resolves.toBeDefined();
    }
    expect(context.store.get().scenario).toBe("NORMAL");
    expect(
      (await context.app.inject({ url: "/jwks", headers: { host } })).json<{
        keys: unknown[];
      }>().keys,
    ).toHaveLength(2);

    context.store.reset();
    const resetJwks = (
      await context.app.inject({ url: "/jwks", headers: { host } })
    ).json<{ keys: Array<{ kid?: string }> }>();
    expect(resetJwks.keys.map(({ kid }) => kid)).toEqual([initialKid]);

    const normalFlow = await authorize();
    const normalResponse = await exchange(normalFlow.code, normalFlow.verifier);
    const normalToken = normalResponse.json<{ id_token: string }>().id_token;
    expect(decodeProtectedHeader(normalToken).kid).toBe(initialKid);
  });

  it("gives JWKS faults precedence over the published rollover key set", async () => {
    context.store.set({
      scenario: "SIGNING_KEY_ROLLOVER",
      mode: "CONTINUOUS",
    });
    context.store.clear();
    expect(
      (await context.app.inject({ url: "/jwks", headers: { host } })).json<{
        keys: unknown[];
      }>().keys,
    ).toHaveLength(2);

    context.store.set({
      scenario: "JWKS_INVALID",
      mode: "LIMITED",
      failureCount: 1,
    });
    expect(
      (await context.app.inject({ url: "/jwks", headers: { host } })).json(),
    ).toEqual({ keys: [{ kty: "RSA", kid: "mock-invalid-jwk" }] });
    expect(
      (await context.app.inject({ url: "/jwks", headers: { host } })).json<{
        keys: unknown[];
      }>().keys,
    ).toHaveLength(2);

    context.store.set({
      scenario: "JWKS_500",
      mode: "LIMITED",
      failureCount: 1,
    });
    expect(
      (await context.app.inject({ url: "/jwks", headers: { host } }))
        .statusCode,
    ).toBe(500);
    expect(
      (await context.app.inject({ url: "/jwks", headers: { host } })).json<{
        keys: unknown[];
      }>().keys,
    ).toHaveLength(2);

    context.store.set({
      scenario: "JWKS_TIMEOUT",
      mode: "LIMITED",
      failureCount: 1,
      parameters: { delayMs: 1 },
    });
    expect(
      (await context.app.inject({ url: "/jwks", headers: { host } })).json<{
        keys: unknown[];
      }>().keys,
    ).toHaveLength(2);
  });

  it("starts with only the original public key after a restart", async () => {
    const restartDirectory = await mkdtemp(
      join(tmpdir(), "mock-idp-rollover-restart-"),
    );
    const restartConfig = loadConfig({
      NODE_ENV: "test",
      OIDC_ISSUER: issuer,
      KEY_DIRECTORY: join(restartDirectory, "keys"),
      CLIENT_CONFIG_FILE: join(restartDirectory, "clients.json"),
    });
    let original: AppContext | undefined;
    let restarted: AppContext | undefined;
    try {
      original = await buildApp(restartConfig);
      original.store.set({
        scenario: "SIGNING_KEY_ROLLOVER",
        mode: "CONTINUOUS",
      });
      expect(
        (await original.app.inject({ url: "/jwks", headers: { host } })).json<{
          keys: unknown[];
        }>().keys,
      ).toHaveLength(2);
      await original.app.close();
      original = undefined;

      restarted = await buildApp(restartConfig);
      const restartedKeys = (
        await restarted.app.inject({ url: "/jwks", headers: { host } })
      ).json<{ keys: Array<{ kid?: string }> }>().keys;
      expect(restartedKeys.map(({ kid }) => kid)).toEqual(["mock-normal-key"]);
    } finally {
      await original?.app.close();
      await restarted?.app.close();
      await rm(restartDirectory, { recursive: true, force: true });
    }
  });
});
