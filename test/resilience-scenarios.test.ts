import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type AppContext } from "../src/app.js";
import { testConfig } from "./test-config.js";

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
      testConfig({
        issuer,
        keyDirectory: join(stateDirectory, "keys"),
        clientConfigFile: join(stateDirectory, "clients.json"),
      }),
      { https: false },
    );
  });

  beforeEach(() => context.store.reset());

  afterAll(async () => {
    try {
      await context.app.close();
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  function authorizationRequest(state = randomBytes(8).toString("base64url")) {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return {
      verifier,
      url:
        "/authorize?" +
        new URLSearchParams({
          client_id: "mock-public-client",
          redirect_uri: "http://localhost:3000/callback",
          response_type: "code",
          scope: "openid profile",
          state,
          nonce: randomBytes(8).toString("base64url"),
          code_challenge: challenge,
          code_challenge_method: "S256",
        }).toString(),
    };
  }

  async function authorize(): Promise<{ code: string; verifier: string }> {
    const request = authorizationRequest();
    let jar = "";
    let response = await context.app.inject({
      url: request.url,
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
    return {
      code: String(callback.searchParams.get("code")),
      verifier: request.verifier,
    };
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

  type HttpEndpoint = "authorization-http" | "token" | "jwks" | "discovery";

  function withTrailingSlashes(url: string, trailingSlashes: number): string {
    const parsed = new URL(url, issuer);
    return `${parsed.pathname}${"/".repeat(trailingSlashes)}${parsed.search}`;
  }

  async function requestEndpoint(
    endpoint: HttpEndpoint,
    origin?: string,
    trailingSlashes = 0,
  ) {
    switch (endpoint) {
      case "authorization-http":
        return context.app.inject({
          url: withTrailingSlashes(authorizationRequest().url, trailingSlashes),
          headers: { host, ...(origin ? { origin } : {}) },
        });
      case "token":
        return context.app.inject({
          method: "POST",
          url: withTrailingSlashes("/token", trailingSlashes),
          headers: {
            host,
            ...(origin ? { origin } : {}),
            "content-type": "application/x-www-form-urlencoded",
          },
          payload: "grant_type=authorization_code&code=invalid",
        });
      case "jwks":
        return context.app.inject({
          url: withTrailingSlashes("/jwks", trailingSlashes),
          headers: { host, ...(origin ? { origin } : {}) },
        });
      case "discovery":
        return context.app.inject({
          url: withTrailingSlashes(
            "/.well-known/openid-configuration",
            trailingSlashes,
          ),
          headers: { host, ...(origin ? { origin } : {}) },
        });
    }
  }

  it.each([
    ["AUTH_429", "authorization-http"],
    ["TOKEN_429", "token"],
    ["JWKS_429", "jwks"],
    ["DISCOVERY_429", "discovery"],
  ] as const)(
    "returns %s with the documented Retry-After contract",
    async (scenario, endpoint) => {
      context.store.set({
        scenario,
        mode: "CONTINUOUS",
      });
      const response = await requestEndpoint(endpoint, "http://localhost:3000");

      expect(response.statusCode).toBe(429);
      expect(response.headers["retry-after"]).toBe("60");
      expect(response.headers["access-control-expose-headers"]).toContain(
        "Retry-After",
      );
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({
        error: "temporarily_unavailable",
        error_description: `Injected ${scenario} fault`,
      });
      if (scenario === "AUTH_429")
        expect(response.headers.location).toBeUndefined();
      expect(context.store.get()).toMatchObject({
        scenario,
        status: "ACTIVE",
        triggeredCount: 1,
      });
    },
  );

  it.each([
    ["AUTH_500", "authorization-http"],
    ["TOKEN_500", "token"],
    ["JWKS_500", "jwks"],
    ["DISCOVERY_500", "discovery"],
  ] as const)(
    "adds Retry-After to %s only when requested",
    async (scenario, endpoint) => {
      context.store.set({
        scenario,
        mode: "CONTINUOUS",
        parameters: { retryAfterSeconds: 7 },
      });
      let response = await requestEndpoint(endpoint, "http://localhost:3000");
      expect(response.statusCode).toBe(500);
      expect(response.headers["retry-after"]).toBe("7");
      expect(response.headers["access-control-expose-headers"]).toContain(
        "Retry-After",
      );
      expect(response.json()).toEqual({
        error: "server_error",
        error_description: `Injected ${scenario} fault`,
      });
      if (scenario === "AUTH_500")
        expect(response.headers.location).toBeUndefined();

      context.store.set({
        scenario,
        mode: "CONTINUOUS",
      });
      response = await requestEndpoint(endpoint);
      expect(response.statusCode).toBe(500);
      expect(response.headers["retry-after"]).toBeUndefined();
    },
  );

  it.each([
    ["AUTH_429", "authorization-http", 429, 303],
    ["AUTH_500", "authorization-http", 500, 303],
    ["TOKEN_429", "token", 429, 400],
    ["TOKEN_500", "token", 500, 400],
    ["JWKS_429", "jwks", 429, 200],
    ["JWKS_500", "jwks", 500, 200],
    ["DISCOVERY_429", "discovery", 429, 200],
    ["DISCOVERY_500", "discovery", 500, 200],
  ] as const)(
    "returns two %s faults before recovering",
    async (scenario, endpoint, faultStatus, normalStatus) => {
      context.store.set({
        scenario,
        mode: "LIMITED",
        failureCount: 2,
      });

      expect((await requestEndpoint(endpoint)).statusCode).toBe(faultStatus);
      expect(context.store.get()).toMatchObject({
        scenario,
        remainingFailures: 1,
      });
      expect((await requestEndpoint(endpoint)).statusCode).toBe(faultStatus);
      expect(context.store.get().scenario).toBe("NORMAL");
      expect((await requestEndpoint(endpoint)).statusCode).toBe(normalStatus);
    },
  );

  it.each([
    ["AUTH_500", "authorization-http", 303],
    ["TOKEN_500", "token", 400],
    ["JWKS_500", "jwks", 200],
    ["DISCOVERY_500", "discovery", 200],
  ] as const)(
    "injects %s for one provider-compatible trailing slash",
    async (scenario, endpoint, normalStatus) => {
      context.store.set({
        scenario,
        mode: "LIMITED",
        failureCount: 1,
      });

      expect((await requestEndpoint(endpoint, undefined, 1)).statusCode).toBe(
        500,
      );
      expect(context.store.get()).toMatchObject({
        scenario: "NORMAL",
        lastCompleted: { scenario, triggeredCount: 1 },
      });
      expect((await requestEndpoint(endpoint, undefined, 1)).statusCode).toBe(
        normalStatus,
      );
    },
  );

  it.each([
    ["AUTH_500", "authorization-http"],
    ["TOKEN_500", "token"],
    ["JWKS_500", "jwks"],
    ["DISCOVERY_500", "discovery"],
  ] as const)(
    "does not consume %s for two trailing slashes rejected by the provider",
    async (scenario, endpoint) => {
      context.store.set({
        scenario,
        mode: "LIMITED",
        failureCount: 1,
      });

      expect((await requestEndpoint(endpoint, undefined, 2)).statusCode).toBe(
        404,
      );
      expect(context.store.get()).toMatchObject({
        scenario,
        remainingFailures: 1,
        triggeredCount: 0,
      });
    },
  );

  it("delays two AUTH_TIMEOUT requests and then continues authorization normally", async () => {
    context.store.set({
      scenario: "AUTH_TIMEOUT",
      mode: "LIMITED",
      failureCount: 2,
      parameters: { delayMs: 40 },
    });

    for (const remainingFailures of [1, 0]) {
      const started = Date.now();
      const response = await requestEndpoint("authorization-http");
      expect(response.statusCode, response.body).toBe(303);
      expect(Date.now() - started).toBeGreaterThanOrEqual(30);
      if (remainingFailures === 0)
        expect(context.store.get().scenario).toBe("NORMAL");
      else
        expect(context.store.get().remainingFailures).toBe(remainingFailures);
    }

    expect((await requestEndpoint("authorization-http")).statusCode).toBe(303);
  });

  it("keeps CONTINUOUS AUTH_TIMEOUT active across delayed requests", async () => {
    context.store.set({
      scenario: "AUTH_TIMEOUT",
      mode: "CONTINUOUS",
      parameters: { delayMs: 20 },
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      const started = Date.now();
      const response = await requestEndpoint("authorization-http");
      expect(response.statusCode, response.body).toBe(303);
      expect(Date.now() - started).toBeGreaterThanOrEqual(10);
    }
    expect(context.store.get()).toMatchObject({
      scenario: "AUTH_TIMEOUT",
      status: "ACTIVE",
      triggeredCount: 2,
    });
  });

  it("isolates Authorization HTTP faults from other endpoints and Token faults from Authorization", async () => {
    context.store.set({
      scenario: "AUTH_500",
      mode: "LIMITED",
      failureCount: 1,
    });
    expect((await requestEndpoint("token")).statusCode).toBe(400);
    expect((await requestEndpoint("jwks")).statusCode).toBe(200);
    expect((await requestEndpoint("discovery")).statusCode).toBe(200);
    expect(context.store.get()).toMatchObject({
      scenario: "AUTH_500",
      remainingFailures: 1,
      triggeredCount: 0,
    });
    expect((await requestEndpoint("authorization-http")).statusCode).toBe(500);

    context.store.set({
      scenario: "TOKEN_429",
      mode: "LIMITED",
      failureCount: 1,
    });
    expect((await requestEndpoint("authorization-http")).statusCode).toBe(303);
    expect(context.store.get()).toMatchObject({
      scenario: "TOKEN_429",
      remainingFailures: 1,
      triggeredCount: 0,
    });
    expect((await requestEndpoint("token")).statusCode).toBe(429);
  });

  it.each([
    ["AUTH_500", "authorization-http"],
    ["TOKEN_500", "token"],
    ["JWKS_500", "jwks"],
    ["DISCOVERY_500", "discovery"],
  ] as const)(
    "does not consume %s for integrated OPTIONS or HEAD requests",
    async (scenario, endpoint) => {
      context.store.set({ scenario, mode: "LIMITED", failureCount: 1 });
      const url =
        endpoint === "authorization-http"
          ? authorizationRequest("method-isolation").url
          : endpoint === "token"
            ? "/token"
            : endpoint === "jwks"
              ? "/jwks"
              : "/.well-known/openid-configuration";
      const trailingSlashUrl = withTrailingSlashes(url, 1);

      const options = await context.app.inject({
        method: "OPTIONS",
        url: trailingSlashUrl,
        headers: { host },
      });
      expect(options.statusCode).toBe(204);
      await context.app.inject({
        method: "HEAD",
        url: trailingSlashUrl,
        headers: { host },
      });

      expect(context.store.get()).toMatchObject({
        scenario,
        remainingFailures: 1,
        triggeredCount: 0,
      });
    },
  );

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

  it("returns and recovers from JWKS_INVALID", async () => {
    context.store.set({
      scenario: "JWKS_INVALID",
      mode: "LIMITED",
      failureCount: 1,
    });
    const invalid = await context.app.inject({
      url: "/jwks",
      headers: { host },
    });
    expect(invalid.statusCode).toBe(200);
    expect(invalid.json()).toEqual({
      keys: [{ kty: "RSA", kid: "mock-invalid-jwk" }],
    });
    expect(context.store.get().scenario).toBe("NORMAL");

    const recovered = await context.app.inject({
      url: "/jwks",
      headers: { host },
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json<{ keys: unknown[] }>().keys.length).toBe(1);
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
      scenario: "JWKS_429",
      mode: "LIMITED",
      failureCount: 1,
    });
    expect(
      (await context.app.inject({ url: "/jwks", headers: { host } }))
        .statusCode,
    ).toBe(429);
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
    const restartConfig = testConfig({
      issuer,
      keyDirectory: join(restartDirectory, "keys"),
      clientConfigFile: join(restartDirectory, "clients.json"),
    });
    let original: AppContext | undefined;
    let restarted: AppContext | undefined;
    try {
      original = await buildApp(restartConfig, { https: false });
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

      restarted = await buildApp(restartConfig, { https: false });
      const restartedKeys = (
        await restarted.app.inject({ url: "/jwks", headers: { host } })
      ).json<{ keys: Array<{ kid?: string }> }>().keys;
      expect(restartedKeys.map(({ kid }) => kid)).toEqual(["mock-normal-key"]);
    } finally {
      try {
        await original?.app.close();
      } finally {
        try {
          await restarted?.app.close();
        } finally {
          await rm(restartDirectory, { recursive: true, force: true });
        }
      }
    }
  });
});
