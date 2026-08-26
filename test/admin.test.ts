import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type AppContext } from "../src/app.js";
import { mockTenantId, type AppConfig } from "../src/config.js";
import { scenarioNames } from "../src/scenario/types.js";
import { testConfig } from "./test-config.js";

const tokenPath = "/oauth2/v2.0/token";
const jwksPath = "/discovery/v2.0/keys";

describe("test configuration safety", () => {
  it.each([
    {
      name: "key directory",
      keyDirectory: ".data/test-keys",
      clientConfigFile: join(tmpdir(), "safe-test-clients.json"),
    },
    {
      name: "client configuration",
      keyDirectory: join(tmpdir(), "safe-test-keys"),
      clientConfigFile: ".data/test-clients.json",
    },
  ])("rejects a $name below the repository .data directory", (paths) => {
    expect(() => testConfig(paths)).toThrow(
      "must not resolve inside the repository .data directory",
    );
  });
});

describe("admin API and UI", () => {
  let context: AppContext;
  let appConfig: AppConfig;
  let stateDirectory: string;

  beforeEach(async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), "mock-idp-admin-"));
    appConfig = testConfig({
      issuer: "http://localhost",
      keyDirectory: join(stateDirectory, "keys"),
      clientConfigFile: join(stateDirectory, "clients.json"),
    });
    context = await buildApp(appConfig, { https: false });
  });
  afterEach(async () => {
    try {
      await context.app.close();
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("sets, reads, clears, and resets scenarios", async () => {
    const set = await context.app.inject({
      method: "PUT",
      url: "/__mock/api/scenario",
      payload: { scenario: "TOKEN_500", mode: "LIMITED", failureCount: 2 },
    });
    expect(set.json()).toMatchObject({
      scenario: "TOKEN_500",
      remainingFailures: 2,
      status: "ACTIVE",
    });
    expect(
      (await context.app.inject("/__mock/api/scenario")).json().scenario,
    ).toBe("TOKEN_500");
    expect(
      (
        await context.app.inject({
          method: "DELETE",
          url: "/__mock/api/scenario",
        })
      ).json().scenario,
    ).toBe("NORMAL");
    expect(
      (
        await context.app.inject({
          method: "POST",
          url: "/__mock/api/reset",
          payload: {},
        })
      ).json().lastCompleted,
    ).toBeNull();
  });

  it("exposes automatic LIMITED completion and history through the API", async () => {
    await context.app.inject({
      method: "PUT",
      url: "/__mock/api/scenario",
      payload: { scenario: "TOKEN_500", mode: "LIMITED", failureCount: 1 },
    });
    expect(
      (
        await context.app.inject({
          method: "POST",
          url: tokenPath,
          headers: {
            host: "localhost",
            "content-type": "application/x-www-form-urlencoded",
          },
          payload: "grant_type=authorization_code&code=invalid",
        })
      ).statusCode,
    ).toBe(500);
    expect(
      (await context.app.inject("/__mock/api/scenario")).json(),
    ).toMatchObject({
      scenario: "NORMAL",
      status: "NORMAL",
      lastCompleted: {
        scenario: "TOKEN_500",
        initialFailureCount: 1,
        remainingFailures: 0,
        triggeredCount: 1,
        completed: true,
      },
    });
  });

  it("resets the active count and published signing key through the Reset API", async () => {
    const initialKeys = (
      await context.app.inject({
        url: jwksPath,
        headers: { host: "localhost" },
      })
    ).json<{ keys: Array<{ kid?: string }> }>().keys;
    expect(initialKeys).toHaveLength(1);

    await context.app.inject({
      method: "PUT",
      url: "/__mock/api/scenario",
      payload: { scenario: "SIGNING_KEY_ROLLOVER", mode: "CONTINUOUS" },
    });
    expect(
      (
        await context.app.inject({
          url: jwksPath,
          headers: { host: "localhost" },
        })
      ).json<{ keys: unknown[] }>().keys,
    ).toHaveLength(2);

    await context.app.inject({ method: "DELETE", url: "/__mock/api/scenario" });
    expect(
      (
        await context.app.inject({
          url: jwksPath,
          headers: { host: "localhost" },
        })
      ).json<{ keys: unknown[] }>().keys,
    ).toHaveLength(2);
    await context.app.inject({
      method: "PUT",
      url: "/__mock/api/scenario",
      payload: {
        scenario: "AUTH_500",
        mode: "LIMITED",
        failureCount: 2,
      },
    });

    const reset = await context.app.inject({
      method: "POST",
      url: "/__mock/api/reset",
      payload: {},
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({
      scenario: "NORMAL",
      status: "NORMAL",
      initialFailureCount: null,
      remainingFailures: null,
      triggeredCount: 0,
      lastCompleted: null,
    });
    const resetKeys = (
      await context.app.inject({
        url: jwksPath,
        headers: { host: "localhost" },
      })
    ).json<{ keys: Array<{ kid?: string }> }>().keys;
    expect(resetKeys.map(({ kid }) => kid)).toEqual([initialKeys[0]?.kid]);
  });

  it.each([
    { scenario: "TOKEN_500", mode: "LIMITED" },
    { scenario: "TOKEN_500", mode: "LIMITED", failureCount: 0 },
    { scenario: "TOKEN_500", mode: "CONTINUOUS", failureCount: 2 },
    { scenario: "BOGUS", mode: "CONTINUOUS" },
    {
      scenario: "TOKEN_TIMEOUT",
      mode: "LIMITED",
      failureCount: 1,
      parameters: { delayMs: -1 },
    },
    {
      scenario: "TOKEN_TIMEOUT",
      mode: "CONTINUOUS",
      parameters: { delayMs: 300_001 },
    },
    {
      scenario: "TOKEN_500",
      mode: "CONTINUOUS",
      parameters: { delayMs: 1 },
    },
    {
      scenario: "TOKEN_400",
      mode: "CONTINUOUS",
      parameters: { error: "invalid_grant", unexpected: true },
    },
    {
      scenario: "TOKEN_429",
      mode: "CONTINUOUS",
      parameters: { retryAfterSeconds: 0 },
    },
    {
      scenario: "TOKEN_500",
      mode: "CONTINUOUS",
      parameters: { retryAfterSeconds: 1.5 },
    },
    {
      scenario: "DISCOVERY_INVALID",
      mode: "CONTINUOUS",
    },
    {
      scenario: "UNKNOWN_GROUPS",
      mode: "CONTINUOUS",
    },
  ])("rejects invalid input %#", async (payload) => {
    expect(
      (
        await context.app.inject({
          method: "PUT",
          url: "/__mock/api/scenario",
          payload,
        })
      ).statusCode,
    ).toBe(400);
  });

  it("normalizes every 429 and preserves optional Retry-After for every 500", async () => {
    for (const scenario of [
      "AUTH_429",
      "TOKEN_429",
      "JWKS_429",
      "DISCOVERY_429",
    ] as const) {
      const defaulted = await context.app.inject({
        method: "PUT",
        url: "/__mock/api/scenario",
        payload: { scenario, mode: "CONTINUOUS" },
      });
      expect(defaulted.statusCode).toBe(200);
      expect(defaulted.json().parameters).toEqual({ retryAfterSeconds: 60 });

      const configured = await context.app.inject({
        method: "PUT",
        url: "/__mock/api/scenario",
        payload: {
          scenario,
          mode: "CONTINUOUS",
          parameters: { retryAfterSeconds: 15 },
        },
      });
      expect(configured.statusCode).toBe(200);
      expect(configured.json().parameters).toEqual({ retryAfterSeconds: 15 });
    }

    for (const scenario of [
      "AUTH_500",
      "TOKEN_500",
      "JWKS_500",
      "DISCOVERY_500",
    ] as const) {
      const configured = await context.app.inject({
        method: "PUT",
        url: "/__mock/api/scenario",
        payload: {
          scenario,
          mode: "CONTINUOUS",
          parameters: { retryAfterSeconds: 15 },
        },
      });
      expect(configured.statusCode).toBe(200);
      expect(configured.json().parameters).toEqual({ retryAfterSeconds: 15 });

      const omitted = await context.app.inject({
        method: "PUT",
        url: "/__mock/api/scenario",
        payload: { scenario, mode: "CONTINUOUS" },
      });
      expect(omitted.statusCode).toBe(200);
      expect(omitted.json().parameters).toEqual({});
    }
  });

  it("serves the admin UI", async () => {
    const response = await context.app.inject("/__mock");
    expect(response.body).toContain("Mock OIDC Provider");
    expect(response.body).toContain("アプリ接続情報");
    expect(response.body).toContain("Authority URL");
    expect(response.body).toContain("Tenant ID");
    expect(response.body).toContain(mockTenantId);
    expect(response.body).toContain("http://localhost");
    expect(response.body).toContain('<html lang="ja">');
    expect(response.body).toContain("現在のシナリオ");
    expect(response.body).toContain("シナリオの状態");
    expect(response.body).toContain("実行状況");
    expect(response.body).toContain("設定した失敗回数");
    expect(response.body).toContain("残り失敗回数");
    expect(response.body).toContain("Retry-After（秒、任意）");
    expect(response.body).toContain(
      "Client secretは平文で保存・表示されます。このAdmin APIには認証がないため、インターネットに公開しないでください。",
    );
    for (const text of [
      "適用",
      "NORMALに戻す",
      "シナリオを初期状態に戻す",
      "各シナリオの詳細は README の「シナリオ API」を参照してください。",
      "シナリオを停止します（履歴は残ります）",
      "履歴と鍵の状態を初期化します",
      "OIDC Clientを登録",
      "OIDC Clientを編集",
      "保存",
      "キャンセル",
      "削除",
      "登録済みのOIDC Clientはありません。",
      "すべてのOIDC Clientを初期状態に戻しますか？",
    ])
      expect(response.body).toContain(text);
    expect(response.body).not.toContain(
      "Never expose this unauthenticated Admin API to the internet.",
    );
    expect(response.body).toContain('id="scenario"');
    expect(response.body).toContain('id="authorityUrl"');
    expect(response.body).toContain('id="tenantId"');
    expect(response.body).toContain('id="copyAuthority"');
    expect(response.body).toContain('id="copyTenantId"');
    expect(response.body).toContain('aria-label="Authority URLをコピー"');
    expect(response.body).toContain('title="Authority URLをコピー"');
    expect(response.body).toContain('aria-label="Tenant IDをコピー"');
    expect(response.body).toContain('title="Tenant IDをコピー"');
    expect(response.body).toContain('id="connectionMessage"');
    expect(response.body).toContain("copyConnectionValue");
    expect(response.body).toContain("navigator.clipboard");
    expect(response.body).toContain("copyFallback");
    expect(response.body).not.toContain('<div class="label">Issuer</div>');
    expect(response.body).toContain('id="mode"');
    expect(response.body).toContain('id="normal"');
    expect(response.body).toContain('id="refresh"');
    expect(response.body).toContain('id="reset"');
    expect(response.body).toContain('aria-label="状態を再読み込み"');
    expect(response.body).toContain('title="状態を再読み込み"');
    const stateHtml = /<section id="state"[\s\S]*?<\/section>/.exec(
      response.body,
    )?.[0];
    if (!stateHtml) throw new Error("State panel was not found");
    expect(stateHtml).toContain('id="refresh"');
    expect(stateHtml).toContain('id="history"');
    expect(response.body.match(/id="refresh"/g)).toHaveLength(1);
    expect(response.body).toContain('max="300000"');
    expect(response.body).toContain('id="retryAfterRequired"');
    expect(response.body).toContain('value="60" required');
    expect(response.body).toContain('id="retryAfterOptional"');
    expect(response.body).toContain("retryAfterRequired");
    expect(response.body).toContain("retryAfterOptional");
    expect(scenarioNames).toHaveLength(28);
    for (const scenario of scenarioNames)
      expect(response.body).toContain(`value="${scenario}"`);
    expect(response.body).not.toContain('value="UNKNOWN_GROUPS"');
    expect(response.body).not.toContain('value="DISCOVERY_INVALID"');
    expect(response.body).toContain('<p id="rolloverNote" class="warning">');
    expect(response.body).toContain("新しい署名鍵はJWKSで公開され続けます");
    expect(response.body).toContain('class="grid state-grid"');
    expect(response.body).toContain('class="state-current"');
    expect(response.body).toContain('class="state-details"');
    expect(response.body).toContain('class="history"');
    expect(response.body).toContain("overflow-wrap:anywhere");
    expect(response.body).not.toContain(
      '<section class="card"><div class="label">直近で完了したシナリオ</div>',
    );
    expect(response.body).toContain("/__mock/api/scenario");
    expect(response.body).not.toContain("setInterval");
    expect(response.body).toContain("OIDC Client");
    expect(response.body).toContain("/__mock/api/clients");
    expect(response.body).toContain("body:'{}'");
    expect(response.body).not.toContain("Allowed scopes");
    expect(response.body).not.toContain("clientScope");
    const inlineScript = /<script>([\s\S]+)<\/script>/.exec(response.body)?.[1];
    if (!inlineScript) throw new Error("Admin UI inline script was not found");
    expect(() => new Script(inlineScript)).not.toThrow();
  });

  it("creates, updates, deletes, and resets OIDC clients independently", async () => {
    const payload = {
      clientId: "admin-api-client",
      clientType: "CONFIDENTIAL",
      clientSecret: "visible-secret",
      tokenEndpointAuthMethod: "client_secret_post",
      redirectUris: ["http://localhost:4321/callback"],
      postLogoutRedirectUris: ["http://localhost:4321/signed-out"],
      accessTokenAudience: "urn:admin-api",
      accessTokenScope: "access_as_user",
      emailOptionalClaim: false,
    };
    const created = await context.app.inject({
      method: "POST",
      url: "/__mock/api/clients",
      payload,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      clientId: payload.clientId,
      clientSecret: "visible-secret",
    });
    expect(created.json()).not.toHaveProperty("scopes");
    expect(
      (
        await context.app.inject({
          method: "POST",
          url: "/__mock/api/clients",
          payload,
        })
      ).statusCode,
    ).toBe(409);

    const { clientId, ...updatePayload } = payload;
    const updated = await context.app.inject({
      method: "PUT",
      url: `/__mock/api/clients/${clientId}`,
      payload: {
        ...updatePayload,
        clientSecret: "changed",
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      clientId: payload.clientId,
      clientSecret: "changed",
    });

    await context.app.inject({
      method: "PUT",
      url: "/__mock/api/scenario",
      payload: { scenario: "TOKEN_500", mode: "CONTINUOUS" },
    });
    await context.app.inject({
      method: "POST",
      url: "/__mock/api/clients/reset",
      payload: {},
    });
    expect(
      (await context.app.inject("/__mock/api/scenario")).json().scenario,
    ).toBe("TOKEN_500");
    expect(
      (await context.app.inject("/__mock/api/clients")).json(),
    ).toHaveLength(2);
    expect(
      (
        await context.app.inject({
          method: "DELETE",
          url: `/__mock/api/clients/${payload.clientId}`,
        })
      ).statusCode,
    ).toBe(404);
  });

  it.each([
    {
      clientId: "bad",
      clientType: "PUBLIC",
      clientSecret: "no",
      tokenEndpointAuthMethod: "none",
      redirectUris: ["http://localhost/cb"],
      postLogoutRedirectUris: [],
      accessTokenAudience: "urn:x",
      accessTokenScope: "access_as_user",
      emailOptionalClaim: false,
    },
    {
      clientId: "bad",
      clientType: "CONFIDENTIAL",
      tokenEndpointAuthMethod: "client_secret_basic",
      redirectUris: ["http://localhost/cb"],
      postLogoutRedirectUris: [],
      accessTokenAudience: "urn:x",
      accessTokenScope: "access_as_user",
      emailOptionalClaim: false,
    },
    {
      clientId: "bad",
      clientType: "PUBLIC",
      tokenEndpointAuthMethod: "none",
      redirectUris: [],
      postLogoutRedirectUris: [],
      accessTokenAudience: "urn:x",
      accessTokenScope: "access_as_user",
      emailOptionalClaim: false,
    },
    {
      clientId: "bad",
      clientType: "PUBLIC",
      tokenEndpointAuthMethod: "none",
      redirectUris: ["relative"],
      postLogoutRedirectUris: [],
      accessTokenAudience: "not a uri",
      accessTokenScope: "access_as_user",
      emailOptionalClaim: false,
    },
    {
      clientId: "legacy-api-input",
      clientType: "PUBLIC",
      tokenEndpointAuthMethod: "none",
      redirectUris: ["http://localhost/cb"],
      postLogoutRedirectUris: [],
      scopes: ["openid"],
      accessTokenAudience: "urn:x",
      accessTokenScope: "access_as_user",
      emailOptionalClaim: false,
    },
  ])("rejects invalid OIDC client %#", async (payload) => {
    const response = await context.app.inject({
      method: "POST",
      url: "/__mock/api/clients",
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_client");
  });

  it("rejects provider-incompatible client metadata without changing persisted restart state", async () => {
    const clientFile = context.clientStore.filePath;
    const beforeFile = await readFile(clientFile, "utf8");
    const before = (await context.app.inject("/__mock/api/clients")).json();
    const create = await context.app.inject({
      method: "POST",
      url: "/__mock/api/clients",
      payload: {
        clientId: "fragment-client",
        clientType: "PUBLIC",
        tokenEndpointAuthMethod: "none",
        redirectUris: ["http://localhost/callback#fragment"],
        postLogoutRedirectUris: [],
        accessTokenAudience: "urn:fragment-client",
        accessTokenScope: "access_as_user",
        emailOptionalClaim: false,
      },
    });
    const update = await context.app.inject({
      method: "PUT",
      url: "/__mock/api/clients/mock-public-client",
      payload: {
        clientType: "PUBLIC",
        tokenEndpointAuthMethod: "none",
        redirectUris: ["http://localhost:3000/callback"],
        postLogoutRedirectUris: [],
        accessTokenAudience: "urn:mock-api#fragment",
        accessTokenScope: "access_as_user",
        emailOptionalClaim: false,
      },
    });
    for (const response of [create, update]) {
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("invalid_client");
    }
    expect((await context.app.inject("/__mock/api/clients")).json()).toEqual(
      before,
    );
    expect(await readFile(clientFile, "utf8")).toBe(beforeFile);

    await context.app.close();
    context = await buildApp(appConfig, { https: false });
    expect((await context.app.inject("/__mock/api/clients")).json()).toEqual(
      before,
    );
  });

  it.each(["https://evil.test", "null"])(
    "rejects Admin mutations from Origin %s",
    async (origin) => {
      const before = context.store.get();
      const response = await context.app.inject({
        method: "PUT",
        url: "/__mock/api/scenario",
        headers: { origin },
        payload: { scenario: "TOKEN_500", mode: "CONTINUOUS" },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe("invalid_admin_origin");
      expect(context.store.get()).toEqual(before);
    },
  );

  it("allows same-origin and Origin-less JSON mutations", async () => {
    const sameOrigin = await context.app.inject({
      method: "PUT",
      url: "/__mock/api/scenario",
      headers: { origin: "http://localhost" },
      payload: { scenario: "TOKEN_500", mode: "CONTINUOUS" },
    });
    expect(sameOrigin.statusCode).toBe(200);
    const commandLine = await context.app.inject({
      method: "DELETE",
      url: "/__mock/api/scenario",
    });
    expect(commandLine.statusCode).toBe(200);
    expect(commandLine.json().scenario).toBe("NORMAL");
  });

  it("rejects non-JSON bodies and requires reset to receive exactly {}", async () => {
    const crossSiteForm = await context.app.inject({
      method: "PUT",
      url: "/__mock/api/scenario",
      headers: {
        origin: "https://evil.test",
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "scenario=TOKEN_500&mode=CONTINUOUS",
    });
    expect(crossSiteForm.statusCode).toBe(403);
    expect(crossSiteForm.json().error).toBe("invalid_admin_origin");

    const form = await context.app.inject({
      method: "PUT",
      url: "/__mock/api/scenario",
      headers: {
        origin: "http://localhost",
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "scenario=TOKEN_500&mode=CONTINUOUS",
    });
    expect(form.statusCode).toBe(415);
    expect(form.json().error).toBe("unsupported_media_type");

    const invalidReset = await context.app.inject({
      method: "POST",
      url: "/__mock/api/reset",
      payload: { unexpected: true },
    });
    expect(invalidReset.statusCode).toBe(400);
    expect(invalidReset.json().error).toBe("invalid_reset_body");
    expect(
      (
        await context.app.inject({
          method: "POST",
          url: "/__mock/api/reset",
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
  });

  it("sets protective headers on Admin pages and responses with secrets", async () => {
    for (const response of [
      await context.app.inject("/__mock"),
      await context.app.inject("/__mock/api/clients"),
    ]) {
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-security-policy"]).toBe(
        "frame-ancestors 'none'",
      );
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-frame-options"]).toBe("DENY");
    }
  });
});
