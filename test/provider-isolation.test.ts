import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp, type AppContext } from "../src/app.js";
import { testConfig } from "./test-config.js";

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

function authorizationUrl(clientId: string, scope: string) {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    url:
      "/authorize?" +
      new URLSearchParams({
        client_id: clientId,
        redirect_uri: "http://localhost:3000/callback",
        response_type: "code",
        scope,
        state: randomBytes(8).toString("base64url"),
        nonce: randomBytes(8).toString("base64url"),
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
        ...(scope.includes("offline_access") ? { prompt: "consent" } : {}),
      }).toString(),
  };
}

async function authorize(
  context: AppContext,
  issuer: string,
  host: string,
  scope: string,
) {
  const request = authorizationUrl("mock-public-client", scope);
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
  expect(response.statusCode, response.body).toBe(200);
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
  const code = callback.searchParams.get("code");
  if (!code) throw new Error(`Authorization failed: ${callback.toString()}`);
  return { code, verifier: request.verifier };
}

async function exchangeCode(
  context: AppContext,
  host: string,
  code: string,
  verifier: string,
) {
  return context.app.inject({
    method: "POST",
    url: "/token",
    headers: { host, "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "mock-public-client",
      redirect_uri: "http://localhost:3000/callback",
      code,
      code_verifier: verifier,
    }).toString(),
  });
}

async function refresh(
  context: AppContext,
  host: string,
  refreshToken: string,
) {
  return context.app.inject({
    method: "POST",
    url: "/token",
    headers: { host, "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: "mock-public-client",
      refresh_token: refreshToken,
    }).toString(),
  });
}

describe("Provider instance isolation", () => {
  it("does not share codes, refresh tokens, or dynamic clients", async () => {
    const stateDirectory = await mkdtemp(
      join(tmpdir(), "mock-idp-provider-isolation-"),
    );
    const issuerA = "http://issuer-a.test";
    const issuerB = "http://issuer-b.test";
    const contextA = await buildApp(
      testConfig({
        issuer: issuerA,
        keyDirectory: join(stateDirectory, "a", "keys"),
        clientConfigFile: join(stateDirectory, "a", "clients.json"),
      }),
      { https: false },
    );
    const contextB = await buildApp(
      testConfig({
        issuer: issuerB,
        keyDirectory: join(stateDirectory, "b", "keys"),
        clientConfigFile: join(stateDirectory, "b", "clients.json"),
      }),
      { https: false },
    );
    try {
      const flow = await authorize(
        contextA,
        issuerA,
        "issuer-a.test",
        "openid offline_access",
      );
      const crossCode = await exchangeCode(
        contextB,
        "issuer-b.test",
        flow.code,
        flow.verifier,
      );
      expect(crossCode.statusCode).toBe(400);
      expect(crossCode.json()).toMatchObject({ error: "invalid_grant" });

      const issued = await exchangeCode(
        contextA,
        "issuer-a.test",
        flow.code,
        flow.verifier,
      );
      expect(issued.statusCode, issued.body).toBe(200);
      const refreshToken = issued.json<{ refresh_token: string }>()
        .refresh_token;
      expect(refreshToken).toBeTypeOf("string");

      const crossRefresh = await refresh(
        contextB,
        "issuer-b.test",
        refreshToken,
      );
      expect(crossRefresh.statusCode).toBe(400);
      expect(crossRefresh.json()).toMatchObject({ error: "invalid_grant" });
      expect(
        (await refresh(contextA, "issuer-a.test", refreshToken)).statusCode,
      ).toBe(200);

      await contextA.clientStore.create({
        clientId: "provider-a-only",
        clientType: "PUBLIC",
        tokenEndpointAuthMethod: "none",
        redirectUris: ["http://localhost:3000/callback"],
        postLogoutRedirectUris: [],
        accessTokenAudience: "urn:provider-a-only",
      });
      const dynamicRequest = authorizationUrl("provider-a-only", "openid");
      expect(
        (
          await contextA.app.inject({
            url: dynamicRequest.url,
            headers: { host: "issuer-a.test" },
          })
        ).statusCode,
      ).toBe(303);
      const crossClient = await contextB.app.inject({
        url: dynamicRequest.url,
        headers: { host: "issuer-b.test" },
      });
      expect(crossClient.statusCode).toBe(400);
      expect(crossClient.body).toContain("invalid_client");
    } finally {
      try {
        await contextA.app.close();
      } finally {
        try {
          await contextB.app.close();
        } finally {
          await rm(stateDirectory, { recursive: true, force: true });
        }
      }
    }
  });
});
