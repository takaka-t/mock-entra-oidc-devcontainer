import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet, jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AppContext } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const host = "login.microsoftonline.test:19000";
const issuerPath = "/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/v2.0";
const issuer = `http://${host}${issuerPath}`;

function updateCookies(current: string, headers: OutgoingHttpHeaders): string {
  const jar = new Map(
    current
      .split("; ")
      .filter(Boolean)
      .map((part) => [part.split("=")[0]!, part]),
  );
  const setCookies = headers["set-cookie"];
  for (const cookie of Array.isArray(setCookies)
    ? setCookies
    : setCookies
      ? [setCookies]
      : []) {
    const pair = cookie.split(";")[0]!;
    jar.set(pair.split("=")[0]!, pair);
  }
  return [...jar.values()].join("; ");
}

describe("issuer routing and origin enforcement", () => {
  let context: AppContext;
  let keyDirectory: string;

  beforeAll(async () => {
    keyDirectory = await mkdtemp(join(tmpdir(), "mock-idp-path-"));
    context = await buildApp(
      loadConfig({
        NODE_ENV: "test",
        OIDC_ISSUER: issuer,
        KEY_DIRECTORY: keyDirectory,
      }),
    );
  });

  afterAll(async () => {
    await context.app.close();
    await rm(keyDirectory, { recursive: true, force: true });
  });

  it("completes discovery through token verification below an issuer path", async () => {
    const discovery = await context.app.inject({
      url: `${issuerPath}/.well-known/openid-configuration`,
      headers: { host },
    });
    expect(discovery.statusCode, discovery.body).toBe(200);
    expect(discovery.json()).toMatchObject({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
    });

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const query = new URLSearchParams({
      client_id: "mock-public-client",
      redirect_uri: "http://localhost:3000/callback",
      response_type: "code",
      scope: "openid profile",
      state: "path-state",
      nonce: "path-nonce",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    let jar = "";
    let response = await context.app.inject({
      url: `${issuerPath}/authorize?${query}`,
      headers: { host },
    });
    jar = updateCookies(jar, response.headers);
    const interaction = new URL(String(response.headers.location), issuer);
    expect(interaction.pathname).toMatch(
      new RegExp(`^${issuerPath}/interaction/`),
    );

    response = await context.app.inject({
      url: `${interaction.pathname}${interaction.search}`,
      headers: { host, cookie: jar },
    });
    jar = updateCookies(jar, response.headers);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Select a test user");

    response = await context.app.inject({
      method: "POST",
      url: `${interaction.pathname}${interaction.search}`,
      headers: {
        host,
        cookie: jar,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "accountId=user-admin",
    });
    jar = updateCookies(jar, response.headers);
    for (
      let attempts = 0;
      attempts < 5 &&
      response.headers.location &&
      !String(response.headers.location).startsWith("http://localhost:3000");
      attempts++
    ) {
      const next = new URL(String(response.headers.location), issuer);
      expect(next.pathname.startsWith(issuerPath)).toBe(true);
      response = await context.app.inject({
        url: `${next.pathname}${next.search}`,
        headers: { host, cookie: jar },
      });
      jar = updateCookies(jar, response.headers);
    }
    const callback = new URL(String(response.headers.location));
    expect(callback.searchParams.get("state")).toBe("path-state");
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();

    const token = await context.app.inject({
      method: "POST",
      url: `${issuerPath}/token`,
      headers: {
        host,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "mock-public-client",
        redirect_uri: "http://localhost:3000/callback",
        code: String(code),
        code_verifier: verifier,
      }).toString(),
    });
    expect(token.statusCode, token.body).toBe(200);
    const tokens = token.json<{ id_token: string; access_token: string }>();
    const jwks = (
      await context.app.inject({
        url: `${issuerPath}/jwks`,
        headers: { host },
      })
    ).json();
    for (const [jwt, audience] of [
      [tokens.id_token, "mock-public-client"],
      [tokens.access_token, "urn:mock-api"],
    ] as const) {
      const verified = await jwtVerify(jwt, createLocalJWKSet(jwks), {
        issuer,
        audience,
        requiredClaims: ["iss", "aud", "iat", "exp", "nbf"],
      });
      expect(verified.payload.nbf).toBe(verified.payload.iat);
      expect(verified.payload.nbf).toBeLessThanOrEqual(Date.now() / 1000);
      expect(verified.payload.exp).toBeGreaterThan(Date.now() / 1000);
      expect(verified.payload.mail).toBe("admin@example.com");
    }
  });

  it("rejects a mismatched Host before a fault is consumed", async () => {
    context.store.set({
      scenario: "DISCOVERY_500",
      mode: "LIMITED",
      failureCount: 1,
    });
    const mismatch = await context.app.inject({
      url: `${issuerPath}/.well-known/openid-configuration`,
      headers: { host: "unexpected.test:19000" },
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error).toBe("invalid_request_origin");
    expect(context.store.get().remainingFailures).toBe(1);

    expect(
      (
        await context.app.inject({
          url: `${issuerPath}/.well-known/openid-configuration`,
          headers: { host },
        })
      ).statusCode,
    ).toBe(500);
  });

  it("applies resilience scenarios only below the configured issuer path", async () => {
    context.store.set({
      scenario: "TOKEN_429",
      mode: "LIMITED",
      failureCount: 1,
    });
    const throttled = await context.app.inject({
      method: "POST",
      url: `${issuerPath}/token`,
      headers: {
        host,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "grant_type=authorization_code&code=invalid",
    });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers["retry-after"]).toBe("60");

    context.store.set({
      scenario: "DISCOVERY_INVALID",
      mode: "LIMITED",
      failureCount: 1,
    });
    expect(
      (
        await context.app.inject({
          url: `${issuerPath}/.well-known/openid-configuration`,
          headers: { host },
        })
      ).json(),
    ).toEqual({});

    context.store.set({
      scenario: "JWKS_INVALID",
      mode: "LIMITED",
      failureCount: 1,
    });
    expect(
      (
        await context.app.inject({
          url: `${issuerPath}/jwks`,
          headers: { host },
        })
      ).json(),
    ).toEqual({ keys: [{ kty: "RSA", kid: "mock-invalid-jwk" }] });

    context.store.set({
      scenario: "SIGNING_KEY_ROLLOVER",
      mode: "CONTINUOUS",
    });
    expect(
      (
        await context.app.inject({
          url: `${issuerPath}/jwks`,
          headers: { host },
        })
      ).json<{ keys: unknown[] }>().keys,
    ).toHaveLength(2);
    context.store.reset();
  });

  it.each([
    `attacker@${host}`,
    `${host}/path`,
    `${host}\\path`,
    `${host}?query`,
    `${host}#fragment`,
    `${host},attacker.test`,
  ])("rejects malformed Host authority %s for Admin routes", async (value) => {
    const response = await context.app.inject({
      url: "/__mock",
      headers: { host: value },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_request_origin");
  });

  it("only serves Admin routes through the issuer origin", async () => {
    expect(
      (
        await context.app.inject({
          url: "/__mock/api/clients",
          headers: { host },
        })
      ).statusCode,
    ).toBe(200);
    const mismatch = await context.app.inject({
      url: "/__mock/api/clients",
      headers: { host: "unexpected.test:19000" },
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error).toBe("invalid_request_origin");
  });

  it("enforces Admin protections for percent-encoded static route spellings", async () => {
    const encodedClientsPath = "/%5f%5fmock/api/clients";
    expect(
      (
        await context.app.inject({
          url: encodedClientsPath,
          headers: { host },
        })
      ).statusCode,
    ).toBe(200);

    const wrongHost = await context.app.inject({
      url: encodedClientsPath,
      headers: { host: "unexpected.test:19000" },
    });
    expect(wrongHost.statusCode).toBe(400);
    expect(wrongHost.json().error).toBe("invalid_request_origin");

    const before = context.store.get();
    const crossSiteForm = await context.app.inject({
      method: "PUT",
      url: "/%5f%5fmock/api/scenario",
      headers: {
        host,
        origin: "https://evil.test",
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "scenario=TOKEN_500&mode=CONTINUOUS",
    });
    expect(crossSiteForm.statusCode).toBe(403);
    expect(crossSiteForm.json().error).toBe("invalid_admin_origin");
    expect(context.store.get()).toEqual(before);

    const nonJson = await context.app.inject({
      method: "PUT",
      url: "/%5f%5fmock/api/scenario",
      headers: {
        host,
        origin: `http://${host}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "scenario=TOKEN_500&mode=CONTINUOUS",
    });
    expect(nonJson.statusCode).toBe(415);
    expect(nonJson.json().error).toBe("unsupported_media_type");
    expect(context.store.get()).toEqual(before);
  });

  it("does not mount path-based endpoints at the origin root", async () => {
    const response = await context.app.inject({
      url: "/authorize",
      headers: { host },
    });
    expect(response.statusCode).toBe(404);
    expect(
      (
        await context.app.inject({
          url: "/health",
          headers: { host: "any-local-host.test" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await context.app.inject({
          url: "/he%61lth",
          headers: { host: "any-local-host.test" },
        })
      ).statusCode,
    ).toBe(200);
  });
});

describe("trusted HTTPS proxy", () => {
  it("uses forwarded origin only when TRUST_PROXY is enabled", async () => {
    const keyDirectory = await mkdtemp(join(tmpdir(), "mock-idp-proxy-"));
    const context = await buildApp(
      loadConfig({
        NODE_ENV: "test",
        OIDC_ISSUER: `https://login.microsoftonline.test${issuerPath}`,
        TRUST_PROXY: "true",
        KEY_DIRECTORY: keyDirectory,
      }),
    );
    try {
      const response = await context.app.inject({
        url: `${issuerPath}/.well-known/openid-configuration`,
        headers: {
          host: "internal-proxy:9000",
          "x-forwarded-host": "login.microsoftonline.test",
          "x-forwarded-proto": "https",
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().issuer).toBe(
        `https://login.microsoftonline.test${issuerPath}`,
      );
      expect(
        (
          await context.app.inject({
            url: "/__mock",
            headers: {
              host: "internal-proxy:9000",
              "x-forwarded-host": "login.microsoftonline.test",
              "x-forwarded-proto": "https",
            },
          })
        ).statusCode,
      ).toBe(200);
      for (const headers of [
        {
          host: "internal-proxy:9000",
          "x-forwarded-host": "login.microsoftonline.test,attacker.test",
          "x-forwarded-proto": "https",
        },
        {
          host: "internal-proxy:9000",
          "x-forwarded-host": "attacker@login.microsoftonline.test",
          "x-forwarded-proto": "https",
        },
        {
          host: "internal-proxy:9000",
          "x-forwarded-host": "login.microsoftonline.test",
          "x-forwarded-proto": "https,http",
        },
      ]) {
        const rejected = await context.app.inject({
          url: "/__mock",
          headers,
        });
        expect(rejected.statusCode).toBe(400);
        expect(rejected.json().error).toBe("invalid_request_origin");
      }
    } finally {
      await context.app.close();
      await rm(keyDirectory, { recursive: true, force: true });
    }
  });
});
