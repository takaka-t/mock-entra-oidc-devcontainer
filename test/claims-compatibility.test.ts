import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet, jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AppContext } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { confidentialClientId, publicClientId, spaClientId } from "../src/clients/types.js";
import { defaultResourceAppId, defaultResourceUri } from "../src/resources/types.js";
import { authorizationResponse, authorize, tokenRequest } from "./entra-flow.js";
import { testConfig } from "./test-config.js";

const msalIdClaims = {
  signin_state: { essential: false },
  login_hint: { essential: false },
  tenant_region_sub_scope: { essential: false },
};
const msalClaims = JSON.stringify({ id_token: msalIdClaims });
const capability = { xms_cc: { values: ["CP1", "future-capability"] } };
const acceptedClaims = [
  {},
  { id_token: {}, userinfo: {}, access_token: {} },
  { id_token: msalIdClaims },
  { id_token: msalIdClaims, access_token: capability },
  { id_token: { unknown: null, sub: null, acr: {}, acrs: { essential: false } } },
  { id_token: { unknown: { essential: true } } },
  { id_token: { unknown: { value: "preferred", extension: true } } },
  { id_token: { unknown: { values: ["preferred", "alternative"] } } },
  { id_token: { acr: { essential: false, value: "unavailable" } } },
  { id_token: { acr: { values: ["unavailable"] } } },
  { userinfo: { email: null, unknown: { essential: false } } },
  { access_token: { unknown: { essential: false }, ...capability } },
  { access_token: { xms_cc: { values: [] } } },
  { future_extension: { unknown: true } },
].map((claims) => JSON.stringify(claims));

const rejectedClaims: (string | string[])[] = [
  " ",
  "{",
  "null",
  "[]",
  '"claims"',
  "false",
  "1",
  ...[
    { id_token: null },
    { userinfo: [] },
    { access_token: "claims" },
    { id_token: { unknown: [] } },
    { id_token: { unknown: false } },
    { id_token: { unknown: "claim" } },
    { id_token: { unknown: { essential: "false" } } },
    { id_token: { unknown: { values: "value" } } },
    { id_token: { unknown: { values: null } } },
    { id_token: { unknown: { value: "one", values: ["two"] } } },
    { access_token: { xms_cc: { values: [1] } } },
    ...["id_token", "access_token", "userinfo"].flatMap((section) => [
      ...["sub", "acrs"].flatMap((name) => [
        { [section]: { ...msalIdClaims, [name]: { value: "constraint" } } },
        { [section]: { ...msalIdClaims, [name]: { values: ["constraint"] } } },
      ]),
      { [section]: { ...msalIdClaims, acr: { essential: true } } },
      { [section]: { ...msalIdClaims, acr: { essential: true, values: ["required"] } } },
      { [section]: { ...msalIdClaims, acrs: { essential: true } } },
    ]),
  ].map((claims) => JSON.stringify(claims)),
  ["{}", msalClaims],
];

interface Tokens {
  access_token: string;
  id_token: string;
  refresh_token: string;
  scope: string;
}

describe("claims request compatibility", () => {
  let context: AppContext, config: AppConfig, directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "claims-compatibility-"));
    config = testConfig({
      issuer: "http://localhost/tenant/v2.0",
      keyDirectory: join(directory, "keys"),
      clientConfigFile: join(directory, "clients.json"),
      userConfigFile: join(directory, "users.json"),
    });
    context = await buildApp(config, { https: false });
    const { resourceAppId, ...resource } = context.resourceStore.list()[0]!;
    await context.resourceStore.update(resourceAppId, { ...resource, requestedAccessTokenVersion: 2 });
  });
  afterAll(async () => {
    await context.app.close();
    await rm(directory, { recursive: true, force: true });
  });

  const routes = [
    { method: "GET", endpoint: "authorize" },
    { method: "POST", endpoint: "authorize" },
    { method: "POST", endpoint: "authorization_code" },
    { method: "POST", endpoint: "refresh_token" },
  ] as const;

  function request(
    route: (typeof routes)[number],
    claims: string | string[],
    trailingSlash = false,
    extra: Record<string, string> = {},
  ) {
    const params = new URLSearchParams({
      client_id: publicClientId,
      redirect_uri: "http://localhost:3000/callback",
      ...(route.endpoint === "authorize"
        ? { response_type: "code", scope: "openid" }
        : { grant_type: route.endpoint, code: "missing", refresh_token: "missing" }),
      ...extra,
    });
    for (const value of typeof claims === "string" ? [claims] : claims) params.append("claims", value);
    const path = route.endpoint === "authorize" ? config.authorizePath : config.tokenPath;
    return context.app.inject({
      method: route.method,
      url: path + (trailingSlash ? "/" : "") + (route.method === "GET" ? `?${params}` : ""),
      ...(route.method === "POST"
        ? { headers: { "content-type": "application/x-www-form-urlencoded" }, payload: params.toString() }
        : {}),
    });
  }

  it.each(acceptedClaims)("accepts optional claims across authorization, exchange and refresh: %s", async (claims) => {
    for (const route of routes) {
      for (const trailingSlash of [false, true]) {
        const response = await request(route, claims, trailingSlash);
        if (route.endpoint === "authorize") {
          expect(response.statusCode, response.body).toBe(303);
          expect(response.headers.location).toContain("/interaction/");
        } else {
          // Reaching grant validation proves claims were accepted rather than rejected.
          expect(response.json().error, response.body).toBe("invalid_grant");
        }
      }
    }
  });

  it.each(rejectedClaims.map((claims) => ({ claims })))(
    "rejects invalid or unsupported claims: $claims",
    async ({ claims }) => {
      for (const route of routes) {
        for (const trailingSlash of [false, true]) {
          const response = await request(route, claims, trailingSlash);
          if (route.endpoint === "authorize") {
            expect(response.statusCode, response.body).toBe(303);
            const result = authorizationResponse(response.body, response.headers.location, config.issuer)!;
            expect(result.callback.origin).toBe("http://localhost:3000");
            expect(result.params.get("error")).toBe("invalid_request");
            expect(result.params.has("code")).toBe(false);
          } else {
            expect(response.statusCode, response.body).toBe(400);
            expect(response.headers.location).toBeUndefined();
            expect(response.json()).toMatchObject({
              error: "invalid_request",
              trace_id: expect.any(String),
              error_description: expect.any(String),
            });
          }
          expect(response.headers["cache-control"]).toBe("no-store");
        }
      }
    },
  );

  it.each(
    (["GET", "POST"] as const).flatMap((method) => [false, true].map((trailingSlash) => ({ method, trailingSlash }))),
  )(
    "completes SPA login and refresh over $method (trailing slash: $trailingSlash)",
    async ({ method, trailingSlash }) => {
      const flow = await authorize(context, config, {
        clientId: spaClientId,
        method,
        trailingSlash,
        claims: msalClaims,
      });
      expect(flow.callback.searchParams.get("state")).toBe("entra-state");
      const headers = { origin: "http://localhost:3000" };
      const exchange = await tokenRequest(
        context,
        config,
        {
          grant_type: "authorization_code",
          client_id: spaClientId,
          redirect_uri: "http://localhost:3000/callback",
          code: flow.code,
          code_verifier: flow.verifier,
          claims: msalClaims,
        },
        headers,
      );
      expect(exchange.statusCode, exchange.body).toBe(200);
      const issued = exchange.json<Tokens>();
      const refresh = await tokenRequest(
        context,
        config,
        {
          grant_type: "refresh_token",
          client_id: spaClientId,
          refresh_token: issued.refresh_token,
          claims: JSON.stringify({ id_token: msalIdClaims, access_token: capability }),
        },
        headers,
      );
      expect(refresh.statusCode, refresh.body).toBe(200);
      const jwks = createLocalJWKSet((await context.app.inject(config.jwksPath)).json());
      for (const tokens of [issued, refresh.json<Tokens>()]) {
        expect(tokens.scope).toBe(`${defaultResourceUri}/api.read`);
        const id = await jwtVerify(tokens.id_token, jwks, { issuer: config.issuer, audience: spaClientId });
        expect(id.payload.nonce).toBe("entra-nonce");
        const access = await jwtVerify(tokens.access_token, jwks, {
          issuer: config.issuer,
          audience: defaultResourceAppId,
        });
        expect(access.payload.scp).toBe("api.read");
        for (const payload of [id.payload, access.payload]) {
          for (const name of [...Object.keys(msalIdClaims), "xms_cc"]) expect(payload).not.toHaveProperty(name);
        }
      }
    },
  );

  it.each(["authorization_code", "refresh_token"])(
    "authenticates the client before validating %s claims",
    async (grant) => {
      const response = await tokenRequest(
        context,
        config,
        { grant_type: grant, claims: "{" },
        { authorization: "Basic " + Buffer.from(confidentialClientId + ":incorrect").toString("base64") },
      );
      expect(response.statusCode).toBe(401);
      expect(response.json().error).toBe("invalid_client");
      expect(response.headers["www-authenticate"]).toMatch(/^Basic /i);
    },
  );

  it("rejects an unsupported grant before validating claims", async () => {
    const response = await tokenRequest(context, config, {
      grant_type: "client_credentials",
      client_id: publicClientId,
      claims: "{",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("unsupported_grant_type");
  });

  it("does not consume a code or invalidate a refresh token when claims validation fails", async () => {
    const flow = await authorize(context, config);
    const params = { code: flow.code, code_verifier: flow.verifier };
    for (const claims of rejectedClaims) {
      const response = await request({ method: "POST", endpoint: "authorization_code" }, claims, false, params);
      expect(response.json().error, response.body).toBe("invalid_request");
    }
    const exchange = await tokenRequest(context, config, {
      grant_type: "authorization_code",
      client_id: publicClientId,
      redirect_uri: "http://localhost:3000/callback",
      ...params,
      claims: msalClaims,
    });
    expect(exchange.statusCode, exchange.body).toBe(200);
    const { refresh_token } = exchange.json<Tokens>();
    for (const claims of rejectedClaims) {
      const response = await request({ method: "POST", endpoint: "refresh_token" }, claims, false, { refresh_token });
      expect(response.json().error, response.body).toBe("invalid_request");
    }
    const refreshed = await tokenRequest(context, config, {
      grant_type: "refresh_token",
      client_id: publicClientId,
      refresh_token,
      claims: msalClaims,
    });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
  });

  it("does not expand profile scopes or override configured token claims", async () => {
    const claims = JSON.stringify({
      id_token: { name: null, oid: { essential: true }, unknown: { value: "injected" } },
    });
    const flow = await authorize(context, config, { scope: "openid", claims });
    const exchanged = await tokenRequest(context, config, {
      grant_type: "authorization_code",
      client_id: publicClientId,
      redirect_uri: "http://localhost:3000/callback",
      code: flow.code,
      code_verifier: flow.verifier,
      claims,
    });
    expect(exchanged.statusCode, exchanged.body).toBe(200);
    const jwks = createLocalJWKSet((await context.app.inject(config.jwksPath)).json());
    const id = await jwtVerify(exchanged.json<Tokens>().id_token, jwks, {
      issuer: config.issuer,
      audience: publicClientId,
    });
    for (const name of ["name", "oid", "unknown"]) expect(id.payload).not.toHaveProperty(name);
  });

  it("omits claims_parameter_supported and does not advertise unimplemented claims", async () => {
    const response = await context.app.inject(config.issuerPath + "/.well-known/openid-configuration");
    expect(response.statusCode).toBe(200);
    const metadata = response.json<{ claims_supported: string[] }>();
    expect(metadata).not.toHaveProperty("claims_parameter_supported");
    for (const name of Object.keys(msalIdClaims)) expect(metadata.claims_supported).not.toContain(name);
  });
});
