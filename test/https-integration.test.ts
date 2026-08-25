import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createLocalJWKSet, jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AppContext } from "../src/app.js";
import {
  loadConfig,
  mockIssuer,
  mockIssuerPath,
  mockOrigin,
} from "../src/config.js";
import { loadTlsServerOptions } from "../src/tls.js";

const execFileAsync = promisify(execFile);
const setupTlsScript = fileURLToPath(
  new URL("../scripts/setup-tls.mjs", import.meta.url),
);
const issuerUrl = new URL(mockOrigin);

interface NetworkResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

interface TlsRequestOptions {
  method?: string;
  headers?: OutgoingHttpHeaders;
  payload?: string;
  servername?: string;
  trustCa?: boolean;
}

function updateCookies(
  current: string,
  setCookie: string | string[] | undefined,
): string {
  const jar = new Map(
    current
      .split("; ")
      .filter(Boolean)
      .map((part) => [part.split("=")[0]!, part]),
  );
  const values = Array.isArray(setCookie)
    ? setCookie
    : setCookie
      ? [setCookie]
      : [];
  for (const cookie of values) {
    const pair = cookie.split(";")[0]!;
    jar.set(pair.split("=")[0]!, pair);
  }
  return [...jar.values()].join("; ");
}

describe("direct HTTPS hosting", () => {
  let context: AppContext;
  let stateDirectory: string;
  let ca: Buffer;
  let port: number;

  function requestTls(
    path: string,
    options: TlsRequestOptions = {},
  ): Promise<NetworkResponse> {
    return new Promise((resolve, reject) => {
      const request = httpsRequest(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method: options.method ?? "GET",
          servername: options.servername ?? issuerUrl.hostname,
          ...(options.trustCa === false ? {} : { ca }),
          headers: {
            host: issuerUrl.host,
            ...options.headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            resolve({
              statusCode: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks),
            });
          });
        },
      );
      request.on("error", reject);
      if (options.payload) request.write(options.payload);
      request.end();
    });
  }

  beforeAll(async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), "mock-idp-https-"));
    const tlsDirectory = join(stateDirectory, "tls");
    const tlsPrivateDirectory = join(stateDirectory, "tls-private");
    await execFileAsync(process.execPath, [
      setupTlsScript,
      "--output-dir",
      tlsDirectory,
      "--private-dir",
      tlsPrivateDirectory,
    ]);
    const config = {
      ...loadConfig(),
      host: "127.0.0.1",
      keyDirectory: join(stateDirectory, "keys"),
      clientConfigFile: join(stateDirectory, "clients.json"),
      tlsCaCertificateFile: join(tlsDirectory, "ca.crt"),
      tlsCertificateFile: join(tlsDirectory, "server.crt"),
      tlsPrivateKeyFile: join(tlsPrivateDirectory, "server.key.pem"),
      logger: false,
    };
    ca = await readFile(config.tlsCaCertificateFile);
    context = await buildApp(config, {
      https: await loadTlsServerOptions(config),
    });
    await context.app.listen({ host: config.host, port: 0 });
    const address = context.app.server.address();
    if (!address || typeof address === "string")
      throw new Error("HTTPS test server did not expose a TCP address");
    port = address.port;
  }, 20_000);

  afterAll(async () => {
    try {
      await context?.app.close();
    } finally {
      if (stateDirectory)
        await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("completes an authorization code flow with HTTPS metadata and issuers", async () => {
    const discovery = await requestTls(
      `${mockIssuerPath}/.well-known/openid-configuration`,
    );
    expect(discovery.statusCode, discovery.body.toString()).toBe(200);
    const metadata = JSON.parse(discovery.body.toString()) as Record<
      string,
      unknown
    >;
    expect(metadata).toMatchObject({
      issuer: mockIssuer,
      authorization_endpoint: `${mockIssuer}/authorize`,
      token_endpoint: `${mockIssuer}/token`,
      jwks_uri: `${mockIssuer}/jwks`,
    });

    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({
      client_id: "mock-public-client",
      redirect_uri: "http://localhost:3000/callback",
      response_type: "code",
      scope: "openid profile",
      state: "https-state",
      nonce: "https-nonce",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    let jar = "";
    let response = await requestTls(
      `${mockIssuerPath}/authorize?${query.toString()}`,
    );
    jar = updateCookies(jar, response.headers["set-cookie"]);
    expect(response.statusCode).toBe(303);
    expect(response.headers["set-cookie"]?.join(";")).toMatch(
      /;\s*secure(?:;|$)/i,
    );

    const interaction = new URL(String(response.headers.location), mockIssuer);
    response = await requestTls(
      `${interaction.pathname}${interaction.search}`,
      {
        headers: { cookie: jar },
      },
    );
    jar = updateCookies(jar, response.headers["set-cookie"]);
    expect(response.statusCode).toBe(200);
    expect(response.body.toString()).toContain("Select a test user");

    const selection = "accountId=user-admin";
    response = await requestTls(
      `${interaction.pathname}${interaction.search}`,
      {
        method: "POST",
        headers: {
          cookie: jar,
          "content-type": "application/x-www-form-urlencoded",
          "content-length": Buffer.byteLength(selection),
        },
        payload: selection,
      },
    );
    jar = updateCookies(jar, response.headers["set-cookie"]);
    for (
      let attempts = 0;
      attempts < 5 &&
      response.headers.location &&
      !String(response.headers.location).startsWith("http://localhost:3000");
      attempts++
    ) {
      const next = new URL(String(response.headers.location), mockIssuer);
      response = await requestTls(`${next.pathname}${next.search}`, {
        headers: { cookie: jar },
      });
      jar = updateCookies(jar, response.headers["set-cookie"]);
    }

    const callback = new URL(String(response.headers.location));
    expect(callback.searchParams.get("state")).toBe("https-state");
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "mock-public-client",
      redirect_uri: "http://localhost:3000/callback",
      code: String(code),
      code_verifier: verifier,
    }).toString();
    const tokenResponse = await requestTls(`${mockIssuerPath}/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": Buffer.byteLength(tokenBody),
      },
      payload: tokenBody,
    });
    expect(tokenResponse.statusCode, tokenResponse.body.toString()).toBe(200);
    const tokens = JSON.parse(tokenResponse.body.toString()) as {
      id_token: string;
      access_token: string;
    };
    const jwksResponse = await requestTls(`${mockIssuerPath}/jwks`);
    const jwks = JSON.parse(jwksResponse.body.toString());
    await expect(
      jwtVerify(tokens.id_token, createLocalJWKSet(jwks), {
        issuer: mockIssuer,
        audience: "mock-public-client",
      }),
    ).resolves.toBeDefined();
    await expect(
      jwtVerify(tokens.access_token, createLocalJWKSet(jwks), {
        issuer: mockIssuer,
        audience: "urn:mock-api",
      }),
    ).resolves.toBeDefined();
  });

  it("rejects untrusted CAs and a hostname outside the certificate SAN", async () => {
    await expect(
      requestTls("/health", { trustCa: false }),
    ).rejects.toBeDefined();
    await expect(
      requestTls("/health", { servername: "unexpected.test" }),
    ).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  });

  it("does not accept plaintext HTTP on the TLS listener", async () => {
    await expect(
      new Promise<void>((resolve, reject) => {
        const request = httpRequest(
          { hostname: "127.0.0.1", port, path: "/health" },
          (response) => {
            response.resume();
            resolve();
          },
        );
        request.on("error", reject);
        request.end();
      }),
    ).rejects.toBeDefined();
  });

  it("keeps origin enforcement active behind the TLS connection", async () => {
    const health = await requestTls("/health");
    expect(health.statusCode).toBe(200);

    const admin = await requestTls("/__mock");
    expect(admin.statusCode).toBe(200);

    const rejectedAdmin = await requestTls("/__mock", {
      headers: { host: "unexpected.test:19000" },
    });
    expect(rejectedAdmin.statusCode).toBe(400);
    expect(JSON.parse(rejectedAdmin.body.toString())).toMatchObject({
      error: "invalid_request_origin",
    });

    const rejectedDiscovery = await requestTls(
      `${mockIssuerPath}/.well-known/openid-configuration`,
      { headers: { host: "unexpected.test:19000" } },
    );
    expect(rejectedDiscovery.statusCode).toBe(400);
    expect(JSON.parse(rejectedDiscovery.body.toString())).toMatchObject({
      error: "invalid_request_origin",
    });
  });
});
