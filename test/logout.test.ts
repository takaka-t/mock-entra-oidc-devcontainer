import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AppContext } from "../src/app.js";
import { mockAuthorizePath, mockIssuerPath, mockLogoutPath, mockOrigin, mockTokenPath } from "../src/config.js";
import { testConfig } from "./test-config.js";

const host = new URL(mockOrigin).host;
const origin = `http://${host}`;
const clientId = "logout-client";
const redirectUri = "http://localhost:3000/callback";
const postLogoutRedirectUri = "http://localhost:3000/signed-out";

function cookies(current: string, headers: OutgoingHttpHeaders): string {
  const jar = new Map(
    current
      .split("; ")
      .filter(Boolean)
      .map((part) => [part.split("=")[0]!, part]),
  );
  const values = headers["set-cookie"];
  for (const cookie of Array.isArray(values) ? values : values ? [values] : [])
    jar.set(cookie.split(";")[0]!.split("=")[0]!, cookie.split(";")[0]!);
  return [...jar.values()].join("; ");
}

describe("RP-initiated logout", () => {
  let context: AppContext;
  let stateDirectory: string;

  beforeAll(async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), "mock-idp-logout-"));
    context = await buildApp(
      testConfig({
        issuer: `${origin}${mockIssuerPath}`,
        keyDirectory: join(stateDirectory, "keys"),
        clientConfigFile: join(stateDirectory, "clients.json"),
        userConfigFile: join(stateDirectory, "users.json"),
      }),
      { https: false },
    );
    await context.clientStore.create({
      clientId,
      clientType: "PUBLIC",
      tokenEndpointAuthMethod: "none",
      redirectUris: [redirectUri],
      postLogoutRedirectUris: [postLogoutRedirectUri],
      accessTokenAudience: "urn:mock-api",
      accessTokenScope: "access_as_user",
      emailOptionalClaim: false,
    });
  });

  afterAll(async () => {
    try {
      await context.app.close();
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  /** Signs in and returns the ID token plus the browser session cookies. */
  async function signIn(): Promise<{ idToken: string; jar: string }> {
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid profile",
      state: "test-state",
      nonce: "test-nonce",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    let jar = "";
    let response = await context.app.inject({
      url: `${mockAuthorizePath}?${query}`,
      headers: { host, cookie: jar },
    });
    jar = cookies(jar, response.headers);
    const interaction = new URL(String(response.headers.location), origin);
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
      let i = 0;
      i < 5 && response.headers.location && !String(response.headers.location).startsWith(redirectUri);
      i++
    ) {
      const next = new URL(String(response.headers.location), origin);
      response = await context.app.inject({
        url: `${next.pathname}${next.search}`,
        headers: { host, cookie: jar },
      });
      jar = cookies(jar, response.headers);
    }
    const callback = new URL(String(response.headers.location));
    const token = await context.app.inject({
      method: "POST",
      url: mockTokenPath,
      headers: { host, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: redirectUri,
        code: String(callback.searchParams.get("code")),
        code_verifier: verifier,
      }).toString(),
    });
    expect(token.statusCode, token.body).toBe(200);
    return {
      idToken: token.json<{ id_token: string }>().id_token,
      jar,
    };
  }

  /** Requests logout and returns the confirmation form's action and xsrf token. */
  async function requestLogout(
    idToken: string,
    jar: string,
    withPostLogoutRedirectUri: boolean,
  ): Promise<{ action: string; xsrf: string }> {
    const query = new URLSearchParams({
      id_token_hint: idToken,
      ...(withPostLogoutRedirectUri ? { post_logout_redirect_uri: postLogoutRedirectUri, state: "bye" } : {}),
    });
    const response = await context.app.inject({
      url: `${mockLogoutPath}?${query}`,
      headers: { host, cookie: jar },
    });
    expect(response.statusCode, response.body).toBe(200);
    return {
      action: String(/action="([^"]+)"/.exec(response.body)?.[1]),
      xsrf: String(/name="xsrf" value="([^"]+)"/.exec(response.body)?.[1]),
    };
  }

  it("advertises the Entra-compliant end_session_endpoint", async () => {
    const discovery = await context.app.inject({
      url: `${mockIssuerPath}/.well-known/openid-configuration`,
      headers: { host },
    });
    expect(discovery.json()).toMatchObject({
      end_session_endpoint: `${origin}${mockLogoutPath}`,
    });
  });

  it("points the confirmation form at the tenant-scoped logout path", async () => {
    const { idToken, jar } = await signIn();
    const { action, xsrf } = await requestLogout(idToken, jar, true);

    expect(action).toBe(`${origin}${mockLogoutPath}/confirm`);
    // The mount prefix must not be lost: an origin-level path is unroutable.
    expect(new URL(action).pathname).not.toBe("/session/end/confirm");
    expect(xsrf).not.toBe("undefined");
  });

  it("completes sign-out at the registered post_logout_redirect_uri", async () => {
    const { idToken, jar } = await signIn();
    const { action, xsrf } = await requestLogout(idToken, jar, true);

    const confirmed = await context.app.inject({
      method: "POST",
      url: new URL(action).pathname,
      headers: {
        host,
        cookie: jar,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams({ xsrf, logout: "yes" }).toString(),
    });

    expect(confirmed.statusCode, confirmed.body).toBe(303);
    const location = new URL(String(confirmed.headers.location));
    expect(`${location.origin}${location.pathname}`).toBe(postLogoutRedirectUri);
    expect(location.searchParams.get("state")).toBe("bye");
  });

  it("serves its own success page when no post_logout_redirect_uri is given", async () => {
    const { idToken, jar } = await signIn();
    const { action, xsrf } = await requestLogout(idToken, jar, false);

    const confirmed = await context.app.inject({
      method: "POST",
      url: new URL(action).pathname,
      headers: {
        host,
        cookie: jar,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams({ xsrf, logout: "yes" }).toString(),
    });
    expect(confirmed.statusCode, confirmed.body).toBe(303);
    const success = new URL(String(confirmed.headers.location));
    expect(success.pathname).toBe(`${mockLogoutPath}/success`);

    const page = await context.app.inject({
      url: `${success.pathname}${success.search}`,
      headers: { host, cookie: jar },
    });
    expect(page.statusCode, page.body).toBe(200);
  });

  it("protects the confirmation page like the sign-in interaction pages", async () => {
    const { idToken, jar } = await signIn();
    const query = new URLSearchParams({
      id_token_hint: idToken,
      post_logout_redirect_uri: postLogoutRedirectUri,
    });
    const response = await context.app.inject({
      url: `${mockLogoutPath}?${query}`,
      headers: { host, cookie: jar },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers).toMatchObject({
      "cache-control": "no-store",
      "content-security-policy": "frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
  });

  it.each([
    ["/session/end", "origin-level internal route"],
    ["/session/end/confirm", "origin-level confirmation route"],
    [`${mockIssuerPath}/logout`, "legacy nested logout path"],
    [`${mockIssuerPath}/session/end`, "legacy nested internal route"],
  ])("does not expose %s (%s)", async (path) => {
    for (const method of ["GET", "POST"] as const) {
      const response = await context.app.inject({
        method,
        url: path,
        headers: {
          host,
          ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(method === "POST" ? { payload: "" } : {}),
      });
      expect(response.statusCode, `${method} ${path}`).toBe(404);
    }
  });
});
