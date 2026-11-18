import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet, jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AppContext } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { publicClientId, confidentialClientId, spaClientId } from "../src/clients/types.js";
import { defaultResourceAppId } from "../src/resources/types.js";
import { authorizationResponse, authorize, tokenRequest, type FlowOptions } from "./entra-flow.js";
import { testConfig } from "./test-config.js";

const transports = (["GET", "POST"] as const).flatMap((method) =>
  (["query", "fragment", "form_post"] as const).map((responseMode) => ({ method, responseMode })),
);
const callbackUri = "http://localhost:3000/callback";
const state = "state & <tag> \"quoted\" 'value'";
const verifier = "v".repeat(43);

function expectCallback(callback: URL, mode: (typeof transports)[number]["responseMode"]) {
  const destination = new URL(callback);
  if (mode === "query") {
    expect(destination.search).not.toBe("");
    destination.search = "";
  } else if (mode === "fragment") {
    expect(destination.hash).not.toBe("");
    destination.hash = "";
  }
  expect(destination.href).toBe(callbackUri);
}

interface Tokens {
  access_token: string;
  id_token: string;
  refresh_token: string;
  client_info?: string;
}

describe("public protocol compatibility", () => {
  let context: AppContext, config: AppConfig, directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "protocol-compatibility-"));
    config = testConfig({
      issuer: "http://localhost/tenant/v2.0",
      keyDirectory: join(directory, "keys"),
      clientConfigFile: join(directory, "clients.json"),
      userConfigFile: join(directory, "users.json"),
    });
    context = await buildApp(config, { https: false });
  });
  afterAll(async () => {
    await context.app.close();
    await rm(directory, { recursive: true, force: true });
  });

  function requestAuthorization(
    extra: Record<string, string | string[]>,
    transport: (typeof transports)[number],
    trailingSlash = false,
  ) {
    const params = new URLSearchParams({
      client_id: publicClientId,
      redirect_uri: callbackUri,
      response_type: "code",
      scope: "openid profile",
      state,
      response_mode: transport.responseMode,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    for (const [name, value] of Object.entries(extra)) {
      params.delete(name);
      for (const item of typeof value === "string" ? [value] : value) params.append(name, item);
    }
    return context.app.inject({
      method: transport.method,
      url: config.authorizePath + (trailingSlash ? "/" : "") + (transport.method === "GET" ? `?${params}` : ""),
      ...(transport.method === "POST"
        ? { headers: { "content-type": "application/x-www-form-urlencoded" }, payload: params.toString() }
        : {}),
    });
  }

  function credentials(clientId: string): Record<string, string> {
    return clientId === confidentialClientId ? { client_secret: "mock-client-secret-change-me" } : {};
  }
  function headers(clientId: string): Record<string, string> {
    return clientId === spaClientId ? { origin: "http://localhost:3000" } : {};
  }
  async function redeem(
    flow: Awaited<ReturnType<typeof authorize>>,
    clientId = publicClientId,
    extra: Record<string, string> = {},
  ) {
    const response = await tokenRequest(
      context,
      config,
      {
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: callbackUri,
        code: flow.code,
        code_verifier: flow.verifier,
        ...credentials(clientId),
        ...extra,
      },
      headers(clientId),
    );
    expect(response.statusCode).toBe(200);
    return response.json<Tokens>();
  }
  async function refresh(token: string, clientId = publicClientId, extra: Record<string, string> = {}) {
    const response = await tokenRequest(
      context,
      config,
      {
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: token,
        ...credentials(clientId),
        ...extra,
      },
      headers(clientId),
    );
    expect(response.statusCode).toBe(200);
    return response.json<Tokens>();
  }

  it.each(transports)("treats empty optional values as omitted over $method / $responseMode", async (transport) => {
    const flow = await authorize(context, config, {
      ...transport,
      trailingSlash: true,
      extraParams: {
        claims: "",
        resource: "",
        dpop_jkt: "",
        client_info: "",
        login_hint: "",
        ui_locales: "",
        domain_hint: "",
        unknown_extension: "ignored",
      },
    });
    expectCallback(flow.callback, transport.responseMode);
    expect(flow.response.get("state")).toBe("entra-state");
    expect(flow.response.has("error")).toBe(false);
    expect(flow.response.has("client_info")).toBe(false);
    const tokens = await redeem(flow, publicClientId, {
      claims: "",
      scope: "",
      client_info: "",
      unknown_extension: "ignored",
    });
    expect(tokens.client_info).toBeUndefined();
    const renewed = await refresh(tokens.refresh_token, publicClientId, { claims: "", scope: "", client_info: "" });
    expect(renewed.client_info).toBeUndefined();
    const keys = createLocalJWKSet((await context.app.inject(config.jwksPath)).json());
    for (const issued of [tokens, renewed]) {
      const id = await jwtVerify(issued.id_token, keys, { issuer: config.issuer, audience: publicClientId });
      const access = await jwtVerify(issued.access_token, keys, {
        issuer: config.issuer,
        audience: defaultResourceAppId,
      });
      expect(id.payload.nonce).toBe("entra-nonce");
      expect(access.payload.scp).toBe("api.read");
    }
  });

  it.each(transports)("returns semantic errors with state over $method / $responseMode", async (transport) => {
    const invalid: Record<string, string | string[]>[] = [
      { claims: "{" },
      { claims: ["", "{}"] },
      { claims: JSON.stringify({ access_token: { acrs: { essential: true, value: "c1" } } }) },
      { code_challenge: "short", code_challenge_method: "plain" },
      { resource: "api://unsupported" },
      { dpop_jkt: "unsupported" },
      { scope: "urn:mock:offline_access" },
      { client_info: ["", "1"] },
    ];
    for (const extra of invalid)
      for (const trailing of [false, true]) {
        const response = await requestAuthorization(extra, transport, trailing);
        expect(response.statusCode).toBe(transport.responseMode === "form_post" ? 400 : 303);
        const result = authorizationResponse(response.body, response.headers.location, config.issuer)!;
        expectCallback(result.callback, transport.responseMode);
        expect(result.params.get("state")).toBe(state);
        expect(result.params.get("error")).toBe(extra.scope ? "invalid_scope" : "invalid_request");
        expect(result.params.has("code")).toBe(false);
        expect(response.headers["cache-control"]).toBe("no-store");
      }
  });

  it.each(transports)(
    "never sends errors to an unverified callback over $method / $responseMode",
    async (transport) => {
      for (const extra of [
        { redirect_uri: "https://unregistered.example/callback" },
        { redirect_uri: "" },
        { redirect_uri: [callbackUri, callbackUri] },
        { client_id: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
        { client_id: "" },
        { client_id: [publicClientId, publicClientId] },
      ]) {
        const response = await requestAuthorization({ ...extra, claims: "{" }, transport);
        expect(response.statusCode).toBe(400);
        expect(authorizationResponse(response.body, response.headers.location, config.issuer)).toBeUndefined();
        expect(response.headers.location).toBeUndefined();
      }
    },
  );

  it.each(["GET", "POST"] as const)(
    "does not hide duplicate empty token or logout parameters over %s",
    async (method) => {
      const params = new URLSearchParams({
        client_id: publicClientId,
        grant_type: "authorization_code",
        code: "missing",
        redirect_uri: callbackUri,
      });
      params.append("client_info", "");
      params.append("client_info", "1");
      // Token issuance is POST-only; both token extensions and logout must retain duplicates.
      const token = await context.app.inject({
        method: "POST",
        url: config.tokenPath,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: params.toString(),
      });
      expect(token.statusCode).toBe(400);
      expect(token.json().error).toBe("invalid_request");
      const logoutParams = new URLSearchParams({ client_id: publicClientId });
      logoutParams.append("post_logout_redirect_uri", "");
      logoutParams.append("post_logout_redirect_uri", callbackUri);
      const logout = await context.app.inject({
        method,
        url: config.logoutPath + (method === "GET" ? `?${logoutParams}` : ""),
        ...(method === "POST"
          ? { headers: { "content-type": "application/x-www-form-urlencoded" }, payload: logoutParams.toString() }
          : {}),
      });
      expect(logout.statusCode).toBe(400);
      expect(logout.headers.location).toBeUndefined();
    },
  );

  it.each(["GET", "POST"] as const)("treats an empty logout destination as omitted over %s", async (method) => {
    const flow = await authorize(context, config);
    const params = new URLSearchParams({
      client_id: publicClientId,
      post_logout_redirect_uri: "",
      id_token_hint: "",
      logout_hint: "",
    });
    const response = await context.app.inject({
      method,
      url: config.logoutPath + (method === "GET" ? `?${params}` : ""),
      headers: {
        cookie: flow.jar,
        ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(method === "POST" ? { payload: params.toString() } : {}),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(`${config.logoutPath}/confirm`);
  });

  it.each(["admin@example.com", "ADMIN@EXAMPLE.COM"])(
    "silently authenticates the matching hinted user: %s",
    async (hint) => {
      const initial = await authorize(context, config);
      const flow = await authorize(context, config, {
        jar: initial.jar,
        prompt: "none",
        extraParams: { login_hint: hint },
      });
      const issued = await redeem(flow);
      const keys = createLocalJWKSet((await context.app.inject(config.jwksPath)).json());
      const id = await jwtVerify(issued.id_token, keys, { issuer: config.issuer, audience: publicClientId });
      expect(id.payload.oid).toBe(context.userStore.find("user-admin")!.oid);
    },
  );

  it.each(["user@example.com", "unknown@example.com", "opaque-hint"])(
    "does not silently use another account for hint %s",
    async (hint) => {
      const initial = await authorize(context, config);
      await expect(
        authorize(context, config, { jar: initial.jar, prompt: "none", extraParams: { login_hint: hint } }),
      ).rejects.toThrow("login_required");
    },
  );

  it("matches a nonempty mail alias and permits an explicit interactive account choice", async () => {
    const { sub, ...user } = context.userStore.find("user-admin")!;
    await context.userStore.update(sub, { ...user, mail: "alias@example.com" });
    try {
      const initial = await authorize(context, config);
      const alias = await authorize(context, config, {
        jar: initial.jar,
        prompt: "none",
        extraParams: { login_hint: "ALIAS@example.com" },
      });
      expect(alias.code).toBeTypeOf("string");
      const chosen = await authorize(context, config, {
        jar: initial.jar,
        userId: "user-normal",
        extraParams: { login_hint: "unknown@example.com" },
      });
      const tokens = await redeem(chosen);
      const keys = createLocalJWKSet((await context.app.inject(config.jwksPath)).json());
      const id = await jwtVerify(tokens.id_token, keys, { issuer: config.issuer, audience: publicClientId });
      expect(id.payload.oid).toBe(context.userStore.find("user-normal")!.oid);
    } finally {
      await context.userStore.update(sub, user);
    }
  });

  it("keeps max_age reauthentication and silent failure behavior", async () => {
    const before = Math.floor(Date.now() / 1000);
    const initial = await authorize(context, config);
    await expect(
      authorize(context, config, { jar: initial.jar, prompt: "none", extraParams: { max_age: "0" } }),
    ).rejects.toThrow("login_required");
    const flow = await authorize(context, config, { jar: initial.jar, extraParams: { max_age: "0" } });
    const tokens = await redeem(flow);
    const keys = createLocalJWKSet((await context.app.inject(config.jwksPath)).json());
    const id = await jwtVerify(tokens.id_token, keys, { issuer: config.issuer, audience: publicClientId });
    expect(id.payload.auth_time).toBeGreaterThanOrEqual(before);
  });

  it.each(
    [publicClientId, confidentialClientId, spaClientId].flatMap((clientId) =>
      transports.map((transport) => ({ clientId, ...transport })),
    ),
  )("returns requested client_info across $clientId / $method / $responseMode", async ({ clientId, ...transport }) => {
    const flow = await authorize(context, config, { clientId, ...transport, extraParams: { client_info: "1" } });
    const tokens = await redeem(flow, clientId, { client_info: "1" });
    const renewed = await refresh(tokens.refresh_token, clientId, { client_info: "1" });
    const expected = { uid: context.userStore.find("user-admin")!.oid, utid: config.tenantId };
    for (const info of [flow.response.get("client_info"), tokens.client_info, renewed.client_info]) {
      expect(info).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(JSON.parse(Buffer.from(info!, "base64url").toString("utf8"))).toEqual(expected);
    }
    const keys = createLocalJWKSet((await context.app.inject(config.jwksPath)).json());
    const id = await jwtVerify(tokens.id_token, keys, { issuer: config.issuer, audience: clientId });
    expect(id.payload).not.toHaveProperty("client_info");
    expect(id.payload.nonce).toBe("entra-nonce");
  });

  it.each([undefined, "", "0", "future-value"])("does not emit unrequested client_info for flag %s", async (flag) => {
    const extra = flag === undefined ? {} : { client_info: flag };
    const options: FlowOptions = { extraParams: extra };
    const flow = await authorize(context, config, options);
    expect(flow.response.has("client_info")).toBe(false);
    const tokens = await redeem(flow, publicClientId, extra);
    expect(tokens.client_info).toBeUndefined();
    expect((await refresh(tokens.refresh_token, publicClientId, extra)).client_info).toBeUndefined();
  });

  it("decides client_info per request and identifies the actual authenticated user", async () => {
    const requested = await authorize(context, config, { extraParams: { client_info: "1" } });
    const tokens = await redeem(requested);
    expect(tokens.client_info).toBeUndefined();
    const renewed = await refresh(tokens.refresh_token, publicClientId, { client_info: "1" });
    expect(renewed.client_info).toBe(requested.response.get("client_info"));
    expect((await refresh(renewed.refresh_token)).client_info).toBeUndefined();
    const other = await authorize(context, config, { userId: "user-normal" });
    const issued = await redeem(other, publicClientId, { client_info: "1" });
    expect(JSON.parse(Buffer.from(issued.client_info!, "base64url").toString("utf8"))).toEqual({
      uid: context.userStore.find("user-normal")!.oid,
      utid: config.tenantId,
    });
    expect(issued.client_info).not.toBe(renewed.client_info);
  });

  it("does not leak deferred validation failures into a concurrent valid request", async () => {
    const [invalid, valid] = await Promise.all([
      requestAuthorization({ claims: "{" }, { method: "GET", responseMode: "query" }),
      authorize(context, config),
    ]);
    expect(authorizationResponse(invalid.body, invalid.headers.location, config.issuer)!.params.get("error")).toBe(
      "invalid_request",
    );
    expect((await redeem(valid)).access_token).toBeTypeOf("string");
  });

  it("does not consume a valid code when client_info is duplicated", async () => {
    const flow = await authorize(context, config);
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: publicClientId,
      redirect_uri: callbackUri,
      code: flow.code,
      code_verifier: flow.verifier,
    });
    params.append("client_info", "");
    params.append("client_info", "1");
    const rejected = await context.app.inject({
      method: "POST",
      url: config.tokenPath,
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      payload: params.toString(),
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toBe("invalid_request");
    expect((await redeem(flow, publicClientId, { client_info: "1" })).client_info).toBeTypeOf("string");
  });
});
