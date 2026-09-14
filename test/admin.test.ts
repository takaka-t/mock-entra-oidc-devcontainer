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
      userConfigFile: join(tmpdir(), "safe-test-users.json"),
    },
    {
      name: "client configuration",
      keyDirectory: join(tmpdir(), "safe-test-keys"),
      clientConfigFile: ".data/test-clients.json",
      userConfigFile: join(tmpdir(), "safe-test-users.json"),
    },
    {
      name: "user configuration",
      keyDirectory: join(tmpdir(), "safe-test-keys"),
      clientConfigFile: join(tmpdir(), "safe-test-clients.json"),
      userConfigFile: ".data/test-users.json",
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
      userConfigFile: join(stateDirectory, "users.json"),
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

  it("records OIDC requests in the access log with the scenario that applied", async () => {
    await context.app.inject({
      method: "PUT",
      url: "/__mock/api/scenario",
      payload: { scenario: "TOKEN_500", mode: "LIMITED", failureCount: 1 },
    });
    const faulted = await context.app.inject({
      method: "POST",
      url: tokenPath,
      headers: {
        host: "localhost",
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "grant_type=authorization_code&code=invalid",
    });
    expect(faulted.statusCode).toBe(500);
    const healthy = await context.app.inject({
      url: jwksPath,
      headers: { host: "localhost" },
    });
    expect(healthy.statusCode).toBe(200);
    const wrongHost = await context.app.inject({
      url: jwksPath,
      headers: { host: "elsewhere.test" },
    });
    expect(wrongHost.statusCode).toBe(400);
    await context.app.inject({ url: "/health" });
    // Opening the Admin UI in a browser also requests the site icon.
    expect(
      (
        await context.app.inject({
          url: "/favicon.ico",
          headers: { host: "localhost" },
        })
      ).statusCode,
    ).toBe(404);

    const listed = await context.app.inject("/__mock/api/access-log");
    expect(listed.statusCode).toBe(200);
    expect(listed.headers["cache-control"]).toBe("no-store");
    const entries = listed.json<Array<Record<string, unknown>>>();
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.id)).toEqual([3, 2, 1]);
    expect(entries).toMatchObject([
      {
        method: "GET",
        path: jwksPath,
        endpoint: "jwks",
        statusCode: 400,
        scenario: "NORMAL",
        fault: null,
      },
      {
        method: "GET",
        path: jwksPath,
        endpoint: "jwks",
        statusCode: 200,
        scenario: "NORMAL",
        fault: null,
      },
      {
        method: "POST",
        path: tokenPath,
        endpoint: "token",
        statusCode: 500,
        scenario: "TOKEN_500",
        fault: {
          scenario: "TOKEN_500",
          endpoint: "token",
          mode: "LIMITED",
          remainingBefore: 1,
          remainingAfter: 0,
        },
      },
    ]);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual([
        "durationMs",
        "endpoint",
        "fault",
        "id",
        "method",
        "path",
        "receivedAt",
        "scenario",
        "statusCode",
      ]);
      expect(typeof entry.durationMs).toBe("number");
      expect(() =>
        new Date(String(entry.receivedAt)).toISOString(),
      ).not.toThrow();
    }
    // Neither the admin API calls above nor /health appear in the log.
    expect(
      entries.some((entry) => String(entry.path).startsWith("/__mock")),
    ).toBe(false);
    expect(entries.some((entry) => entry.path === "/health")).toBe(false);
    expect(entries.some((entry) => entry.path === "/favicon.ico")).toBe(false);

    const cleared = await context.app.inject({
      method: "DELETE",
      url: "/__mock/api/access-log",
    });
    expect(cleared.statusCode).toBe(204);
    expect((await context.app.inject("/__mock/api/access-log")).json()).toEqual(
      [],
    );
    expect(
      (await context.app.inject("/__mock/api/scenario")).json(),
    ).toMatchObject({ lastCompleted: { scenario: "TOKEN_500" } });
  });

  it("rejects cross-site access log clears and leaves the log intact", async () => {
    await context.app.inject({
      url: jwksPath,
      headers: { host: "localhost" },
    });
    const crossSite = await context.app.inject({
      method: "DELETE",
      url: "/__mock/api/access-log",
      headers: { origin: "https://evil.test" },
    });
    expect(crossSite.statusCode).toBe(403);
    expect(crossSite.json().error).toBe("invalid_admin_origin");
    expect(
      (await context.app.inject("/__mock/api/access-log")).json(),
    ).toHaveLength(1);
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
    expect(response.body).toContain("Mock OIDC Provider 管理画面");
    expect(response.body).toContain("アプリ接続情報");
    expect(response.body).toContain("認可サーバー URL（Authority URL）");
    expect(response.body).toContain("テナント ID（tid）");
    expect(response.body).toContain(mockTenantId);
    expect(response.body).toContain("http://localhost");
    expect(response.body).toContain(
      `id="testLogout" href="${appConfig.issuerOrigin}${appConfig.logoutPath}" target="_blank" rel="noopener noreferrer"`,
    );
    expect(response.body).toContain("ログアウトをテスト");
    expect(response.body).toContain(
      'title="ブラウザに保持された Mock IdP のセッションでログアウト（RP-Initiated Logout）画面の動作を確認できます。"',
    );
    // The logout test is something you click during a test, so it lives in
    // the always-visible scenario header rather than a collapsible card.
    const stateHeaderHtml =
      /<div class="state-header">[\s\S]*?<\/div><\/div>/.exec(
        response.body,
      )?.[0];
    if (!stateHeaderHtml) throw new Error("Scenario header was not found");
    expect(stateHeaderHtml).toContain(
      '<h2>シナリオ</h2><div class="state-tools">',
    );
    expect(stateHeaderHtml).toContain('id="testLogout"');
    expect(stateHeaderHtml).toContain('id="refresh"');
    expect(stateHeaderHtml.indexOf('id="testLogout"')).toBeLessThan(
      stateHeaderHtml.indexOf('id="refresh"'),
    );
    expect(response.body.match(/id="testLogout"/g)).toHaveLength(1);
    expect(response.body).toContain('<html lang="ja">');
    expect(response.body).toContain("現在のシナリオ");
    expect(response.body).toContain("シナリオの設定");
    expect(response.body).not.toContain("<h2>シナリオの状態</h2>");
    expect(response.body).toContain("実行状況");
    expect(response.body).toContain("設定した失敗回数");
    expect(response.body).toContain("残り失敗回数");
    expect(response.body).toContain("Retry-After（秒、任意）");
    expect(response.body).toContain("label.required::after");
    expect(response.body).toContain("＊は必須項目です");
    for (const requiredFor of [
      "clientId",
      "clientSecret",
      "redirectUris",
      "audience",
      "scope",
      "userOid",
      "userName",
      "userPreferredUsername",
      "userMail",
      "retryAfterRequired",
      "failureCount",
    ])
      expect(response.body).toContain(`for="${requiredFor}" class="required"`);
    // Like retryAfterRequired, failureCount is required only while its field
    // is shown: a hidden required input would block submission silently.
    expect(response.body).toContain(
      '<input id="failureCount" type="number" min="1" step="1" value="1" required>',
    );
    expect(response.body).toContain(
      "$('failureCount').disabled=!limited;$('failureCount').required=limited;",
    );
    for (const notRequiredFor of [
      "userSub",
      "logoutUris",
      "userGroups",
      "clientType",
      "retryAfterOptional",
    ])
      expect(response.body).not.toContain(
        `for="${notRequiredFor}" class="required"`,
      );
    expect(response.body).toContain(
      "クライアントシークレットは平文で保存・表示されます。このAdmin APIには認証がないため、インターネットに公開しないでください。",
    );
    for (const text of [
      "適用",
      "NORMALに戻す",
      "シナリオを初期状態に戻す",
      "各シナリオの詳細は README の「シナリオ API」を参照してください。",
      "シナリオを停止します（履歴は残ります）",
      "履歴と鍵の状態を初期化します",
      "OIDC クライアントを登録",
      "更新",
      "保存中…",
      "キャンセル",
      "削除",
      "登録済みの OIDC クライアントはありません。",
      "すべての OIDC クライアントを初期状態に戻しますか？",
      "テストユーザー一覧",
      "テストユーザーを登録",
      "テストユーザーを初期状態に戻す",
      "登録済みのテストユーザーはありません。",
      "すべてのテストユーザーを初期状態に戻しますか？",
      "ユーザー ID（sub）",
      "オブジェクト ID（oid）",
      "表示名（name）",
      "優先ユーザー名（preferred_username）",
      "メールアドレス（mail）",
      "グループ（groups）",
      "テナント ID（tid）は常にこの Mock の値になります。",
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
    expect(response.body).toContain(
      'aria-label="認可サーバー URL（Authority URL）をコピー"',
    );
    expect(response.body).toContain(
      'title="認可サーバー URL（Authority URL）をコピー"',
    );
    expect(response.body).toContain('aria-label="テナント ID（tid）をコピー"');
    expect(response.body).toContain('title="テナント ID（tid）をコピー"');
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
    // The state read-out and the scenario form share one card so the
    // fault/normal border frames the whole control panel.
    expect(stateHtml).toContain("<h2>シナリオ</h2>");
    expect(stateHtml).toContain('<form id="form" class="scenario-form">');
    expect(stateHtml).toContain(
      '<h3 class="state-details-title">シナリオの設定</h3>',
    );
    expect(stateHtml).toContain('id="rolloverNote"');
    expect(stateHtml).toContain('id="reset"');
    expect(stateHtml).not.toContain("<details");
    expect(response.body).not.toContain(
      '<section class="card"><form id="form">',
    );
    expect(response.body.match(/id="refresh"/g)).toHaveLength(1);
    // Every other card collapses and starts collapsed (a saved preference
    // reopens it); the scenario card never collapses.
    for (const [panel, heading, count] of [
      ["connectionPanel", "アプリ接続情報", null],
      ["accessLogPanel", "アクセスログ", "accessLogCount"],
      ["clientPanel", "OIDC クライアント一覧", "clientCount"],
      ["userPanel", "テストユーザー一覧", "userCount"],
    ] as const) {
      const details = new RegExp(
        `<details class="card" id="${panel}"><summary>([\\s\\S]*?)</summary>`,
      ).exec(response.body);
      if (!details) throw new Error(`${panel} was not found`);
      expect(details[1]).toContain(`<h2>${heading}`);
      expect(details[1]).not.toContain("<button");
      if (count)
        expect(details[1]).toContain(`<span id="${count}" class="count">`);
      else expect(details[1]).not.toContain('class="count"');
    }
    expect(response.body.match(/<details class="card"/g)).toHaveLength(4);
    expect(response.body.match(/<\/details>/g)).toHaveLength(4);
    expect(response.body).not.toMatch(/<details[^>]* open[ >]/);
    const connectionHtml =
      /<details class="card" id="connectionPanel">[\s\S]*?<\/details>/.exec(
        response.body,
      )?.[0];
    if (!connectionHtml) throw new Error("Connection panel was not found");
    expect(connectionHtml).not.toContain('id="testLogout"');
    expect(connectionHtml).not.toContain('class="actions"');
    const order = [
      'id="connectionPanel"',
      '<section id="state"',
      'id="accessLogPanel"',
      'id="clientPanel"',
      'id="userPanel"',
    ].map((marker) => response.body.indexOf(marker));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const text of [
      "mock-idp-admin-panels",
      "localStorage.getItem(panelStorageKey)",
      "localStorage.setItem(panelStorageKey",
      "addEventListener('toggle'",
      "revealPanel(kind + 'Panel')",
      "revealPanel('accessLogPanel')",
      "'autoOpen' in panel.dataset",
      "Count').textContent='（'",
      "details.card>summary",
      "details.card[open]>summary",
      "max-height:min(28rem,55vh)",
      "position:sticky",
    ])
      expect(response.body).toContain(text);
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
    expect(response.body).toContain('class="state-now"');
    expect(response.body).toContain('aria-label="実行状況"');
    expect(response.body).toContain('id="modeFields" class="contents"');
    expect(response.body).toContain('class="fields"><div id="scenarioField">');
    expect(response.body).toContain('class="history"');
    expect(response.body).toContain("overflow-wrap:anywhere");
    expect(response.body).not.toContain(
      '<section class="card"><div class="label">直近で完了したシナリオ</div>',
    );
    expect(response.body).toContain("/__mock/api/scenario");
    expect(response.body).not.toContain("setInterval");
    expect(response.body).toContain("OIDC クライアント");
    expect(response.body).toContain("/__mock/api/clients");
    expect(response.body).toContain("body:'{}'");
    expect(response.body).not.toContain("Allowed scopes");
    expect(response.body).not.toContain("clientScope");
    for (const id of [
      "users",
      "newUser",
      "resetUsers",
      "userError",
      "userEditor",
      "userForm",
      "userSub",
      "userOid",
      "userName",
      "userPreferredUsername",
      "userMail",
      "userGroups",
      "cancelUser",
      "userEditorError",
    ])
      expect(response.body).toContain(`id="${id}"`);
    expect(response.body).toContain("/__mock/api/users");
    for (const id of [
      "accessLog",
      "accessLogRows",
      "accessLogError",
      "refreshAccessLog",
      "clearAccessLog",
    ])
      expect(response.body).toContain(`id="${id}"`);
    for (const text of [
      "アクセスログ",
      "/__mock/api/access-log",
      "アクセスログはありません。",
      "アクセスログをクリアしますか？",
      "アクセスログをクリア",
      'id="refreshAccessLog" type="button">アクセスログを再読み込み</button>',
      "最新 200 件",
      "管理画面・管理 API へのアクセス（ブラウザが自動的に要求する /favicon.ico を含む）と、query・本文・ヘッダーは記録しません。",
      '<th scope="col">シナリオ</th>',
      "未適用",
      "中断",
      "tr.injected",
      ".log-wrap{max-height:min(28rem,55vh);overflow:auto",
    ])
      expect(response.body).toContain(text);
    expect(response.body).toContain(
      'id="accessLogError" class="error" role="alert"',
    );
    expect(response.body).toContain(
      'id="clearAccessLog" class="danger" type="button"',
    );
    const accessLogHtml =
      /<details class="card" id="accessLogPanel">[\s\S]*?<\/details>/.exec(
        response.body,
      )?.[0];
    if (!accessLogHtml) throw new Error("Access log panel was not found");
    expect(accessLogHtml).toContain('<table id="accessLog"');
    expect(accessLogHtml).not.toContain("innerHTML");
    expect(response.body.indexOf('id="accessLog"')).toBeGreaterThan(
      response.body.indexOf('id="rolloverNote"'),
    );
    expect(response.body.indexOf('id="accessLog"')).toBeLessThan(
      response.body.indexOf("OIDC クライアント一覧"),
    );
    // Lists only carry identifying columns; the rest lives in the dialogs.
    expect(response.body).toContain(
      "listTable(root,['クライアント ID（client_id）','種別（clientType）','リダイレクト URI（redirectUris）','操作'])",
    );
    expect(response.body).toContain(
      "listTable(root,['表示名（name）','優先ユーザー名（preferred_username）','グループ（groups）','操作'])",
    );
    expect(response.body).toContain("table.className='data-table list-table'");
    expect(response.body).not.toContain(
      "'クライアントシークレット（client_secret）：'",
    );
    expect(response.body).not.toContain(
      "'ユーザー ID（sub）：'+user.sub+' ｜ ",
    );
    expect(response.body).toContain(
      '<table id="accessLog" class="data-table log-table">',
    );
    expect(response.body).toContain("crypto.randomUUID");
    expect(response.body).toContain('id="userMail" type="email" required');
    const inlineScript = /<script>([\s\S]+)<\/script>/.exec(response.body)?.[1];
    if (!inlineScript) throw new Error("Admin UI inline script was not found");
    expect(() => new Script(inlineScript)).not.toThrow();
  });

  it("serves accessible registration dialogs and persistent result notices", async () => {
    const { body } = await context.app.inject("/__mock");
    for (const kind of ["client", "user"]) {
      const cap = kind[0]!.toUpperCase() + kind.slice(1);
      const dialog = new RegExp(
        `<dialog id="${kind}Editor"[^>]*>[\\s\\S]*?</dialog>`,
      ).exec(body)?.[0];
      expect(dialog).toBeDefined();
      expect(dialog).toContain(`aria-labelledby="${kind}EditorTitle"`);
      expect(dialog).not.toMatch(/<dialog[^>]*\bopen(?:\s|>)/);
      expect(dialog).toContain(`<form id="${kind}Form">`);
      expect(dialog).toContain(`id="close${cap}" type="button"`);
      expect(dialog).toContain(`id="cancel${cap}" type="button"`);
      expect(dialog).toContain(`id="save${cap}" class="primary" type="submit"`);
      expect(dialog).toContain('role="alert" tabindex="-1"');
      expect(body).toContain(
        `<p id="${kind}Message" role="status" aria-atomic="true">`,
      );
      expect(body).toContain(`id="dismiss${cap}Notice" type="button"`);
      expect(body).toContain(`id="retry${cap}s" class="hidden" type="button"`);
      expect(body.indexOf(`id="${kind}Notice"`)).toBeLessThan(
        body.indexOf(`id="${kind}s"`),
      );
    }
  });

  it("returns localized Admin API messages without changing error codes", async () => {
    const scenario = await context.app.inject({
      method: "PUT",
      url: "/__mock/api/scenario",
      payload: { scenario: "NORMAL", mode: "CONTINUOUS" },
    });
    expect(scenario.statusCode).toBe(400);
    expect(scenario.json()).toMatchObject({
      error: "invalid_scenario",
      message: "NORMAL では mode、failureCount、parameters を指定できません",
    });

    const user = await context.app.inject({
      method: "POST",
      url: "/__mock/api/users",
      payload: {
        sub: "localized-message-user",
        oid: "44444444-4444-4444-4444-444444444444",
        name: "   ",
        preferred_username: "localized-message@example.com",
        mail: "localized-message@example.com",
        groups: [],
      },
    });
    expect(user.statusCode).toBe(400);
    expect(user.json()).toMatchObject({
      error: "invalid_user",
      message: "表示名（name）：値が短すぎるか、少なすぎます",
    });

    const client = await context.app.inject({
      method: "POST",
      url: "/__mock/api/clients",
      payload: {
        clientId: "localized-message-client",
        clientType: "PUBLIC",
        clientSecret: "must-not-be-present",
        tokenEndpointAuthMethod: "none",
        redirectUris: ["http://localhost:3000/callback"],
        postLogoutRedirectUris: [],
        accessTokenAudience: "urn:localized-message",
        accessTokenScope: "access_as_user",
        emailOptionalClaim: false,
      },
    });
    expect(client.statusCode).toBe(400);
    expect(client.json()).toMatchObject({
      error: "invalid_client",
      message:
        "クライアントシークレット（client_secret）：PUBLIC クライアントにはクライアントシークレットを指定できません",
    });
  });

  it.each(["users", "clients"] as const)(
    "keeps %s identifiers consistent across the UI, API, and persistence",
    async (kind) => {
      const idKey = kind === "users" ? "sub" : "clientId";
      const inputId = kind === "users" ? "userSub" : "clientId";
      const payload =
        kind === "users"
          ? {
              oid: "44444444-4444-4444-4444-444444444444",
              name: "境界値ユーザー",
              preferred_username: "boundary@example.com",
              mail: "boundary@example.com",
              groups: ["日本語のグループ"],
            }
          : {
              clientType: "PUBLIC",
              tokenEndpointAuthMethod: "none",
              redirectUris: ["http://localhost/callback"],
              postLogoutRedirectUris: [],
              accessTokenAudience: "urn:boundary",
              accessTokenScope: "access_as_user",
              emailOptionalClaim: false,
            };
      const url = "/__mock/api/" + kind;
      const file =
        kind === "users"
          ? context.userStore.filePath
          : context.clientStore.filePath;
      const html = (await context.app.inject("/__mock")).body;
      const pattern = new RegExp(
        '<input id="' + inputId + '" pattern="([^"]+)"',
      ).exec(html)?.[1];
      expect(pattern).toBeTruthy();
      const browserPattern = new RegExp("^(?:" + pattern + ")$", "v");

      for (const id of [
        "a".repeat(100),
        "  " + "b".repeat(100) + "  ",
        "a/b?c#d% e",
        "...",
      ]) {
        expect(browserPattern.test(id), id).toBe(true);
        const created = await context.app.inject({
          method: "POST",
          url,
          payload: { ...payload, [idKey]: id },
        });
        expect(created.statusCode, created.body).toBe(201);
        expect(created.json()[idKey]).toBe(id.trim());
        const path = new URL(
          url + "/" + encodeURIComponent(id.trim()),
          "http://localhost",
        ).pathname;
        const updated = await context.app.inject({
          method: "PUT",
          url: path,
          payload,
        });
        expect(updated.statusCode, updated.body).toBe(200);
        expect(updated.json()[idKey]).toBe(id.trim());
        const persisted = JSON.parse(await readFile(file, "utf8")) as Record<
          string,
          unknown
        >[];
        expect(persisted.find((item) => item[idKey] === id.trim())).toEqual(
          updated.json(),
        );
        const deleted = await context.app.inject({
          method: "DELETE",
          url: path,
        });
        expect(deleted.statusCode, deleted.body).toBe(204);
      }

      const before = await readFile(file, "utf8");
      for (const id of [
        ".",
        "..",
        " . ",
        "a".repeat(101),
        " ",
        "bad\nid",
        "利用者",
      ]) {
        expect(browserPattern.test(id), id).toBe(false);
        const response = await context.app.inject({
          method: "POST",
          url,
          payload: { ...payload, [idKey]: id },
        });
        expect(response.statusCode, response.body).toBe(400);
        expect(response.json().error).toBe(
          kind === "users" ? "invalid_user" : "invalid_client",
        );
      }
      expect(await readFile(file, "utf8")).toBe(before);
    },
  );

  it("rejects multiline user fields on create and update without changing state", async () => {
    const payload = {
      oid: "44444444-4444-4444-4444-444444444444",
      name: "名前",
      preferred_username: "boundary@example.com",
      mail: "boundary@example.com",
      groups: ["グループ"],
    };
    const before = await readFile(context.userStore.filePath, "utf8");
    for (const newline of ["\r", "\n", "\r\n"]) {
      for (const changes of [
        { name: "first" + newline + "last" },
        { preferred_username: "first" + newline + "last" },
        { groups: ["allowed" + newline + "admin"] },
      ]) {
        for (const method of ["POST", "PUT"] as const) {
          const response = await context.app.inject({
            method,
            url:
              method === "POST"
                ? "/__mock/api/users"
                : "/__mock/api/users/user-normal",
            payload: {
              ...payload,
              ...changes,
              ...(method === "POST" ? { sub: "multiline" } : {}),
            },
          });
          expect(response.statusCode, response.body).toBe(400);
          expect(response.json().error).toBe("invalid_user");
        }
      }
    }
    expect(await readFile(context.userStore.filePath, "utf8")).toBe(before);
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

  it("creates, updates, deletes, and resets test users independently", async () => {
    const payload = {
      sub: "admin-api-user",
      oid: "ABCDEF01-2345-6789-ABCD-EF0123456789",
      name: "API User",
      preferred_username: "api@example.com",
      mail: "api@example.com",
      groups: ["g1", "g1", "g2"],
    };
    const created = await context.app.inject({
      method: "POST",
      url: "/__mock/api/users",
      payload,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({
      ...payload,
      oid: payload.oid.toLowerCase(),
      groups: ["g1", "g2"],
    });
    const duplicate = await context.app.inject({
      method: "POST",
      url: "/__mock/api/users",
      payload,
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error).toBe("user_conflict");
    const oidTaken = await context.app.inject({
      method: "POST",
      url: "/__mock/api/users",
      payload: {
        ...payload,
        sub: "other",
        preferred_username: "o@example.com",
      },
    });
    expect(oidTaken.statusCode).toBe(409);
    expect(oidTaken.json().message).toContain(
      "同じユーザー ID、オブジェクト ID、または優先ユーザー名を持つテストユーザーが既に登録されています",
    );

    const { sub: _sub, ...update } = payload;
    void _sub;
    const updated = await context.app.inject({
      method: "PUT",
      url: "/__mock/api/users/admin-api-user",
      payload: { ...update, name: "Renamed", groups: [] },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      sub: "admin-api-user",
      name: "Renamed",
      groups: [],
    });
    const missing = await context.app.inject({
      method: "PUT",
      url: "/__mock/api/users/nobody",
      payload: update,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("user_not_found");
    expect(
      (await context.app.inject("/__mock/api/users"))
        .json<{ sub: string }[]>()
        .map((user) => user.sub),
    ).toEqual([
      "user-admin",
      "user-normal",
      "user-unauthorized",
      "admin-api-user",
    ]);

    await context.app.inject({
      method: "PUT",
      url: "/__mock/api/scenario",
      payload: { scenario: "TOKEN_500", mode: "CONTINUOUS" },
    });
    const extraClient = await context.app.inject({
      method: "POST",
      url: "/__mock/api/clients",
      payload: {
        clientId: "extra-client",
        clientType: "PUBLIC",
        tokenEndpointAuthMethod: "none",
        redirectUris: ["http://localhost/cb"],
        postLogoutRedirectUris: [],
        accessTokenAudience: "urn:x",
        accessTokenScope: "access_as_user",
        emailOptionalClaim: false,
      },
    });
    expect(extraClient.statusCode).toBe(201);
    const badReset = await context.app.inject({
      method: "POST",
      url: "/__mock/api/users/reset",
      payload: { unexpected: true },
    });
    expect(badReset.statusCode).toBe(400);
    expect(badReset.json().error).toBe("invalid_reset_body");
    const reset = await context.app.inject({
      method: "POST",
      url: "/__mock/api/users/reset",
      payload: {},
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toHaveLength(3);
    expect(
      (await context.app.inject("/__mock/api/scenario")).json(),
    ).toMatchObject({ scenario: "TOKEN_500", status: "ACTIVE" });
    expect(
      (await context.app.inject("/__mock/api/clients")).json(),
    ).toHaveLength(3);

    const deleteMissing = await context.app.inject({
      method: "DELETE",
      url: "/__mock/api/users/admin-api-user",
    });
    expect(deleteMissing.statusCode).toBe(404);
    const deleted = await context.app.inject({
      method: "DELETE",
      url: "/__mock/api/users/user-unauthorized",
    });
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe("");

    await context.app.close();
    context = await buildApp(appConfig, { https: false });
    expect(
      (await context.app.inject("/__mock/api/users"))
        .json<{ sub: string }[]>()
        .map((user) => user.sub),
    ).toEqual(["user-admin", "user-normal"]);
    const clientReset = await context.app.inject({
      method: "POST",
      url: "/__mock/api/clients/reset",
      payload: {},
    });
    expect(clientReset.statusCode).toBe(200);
    expect((await context.app.inject("/__mock/api/users")).json()).toHaveLength(
      2,
    );
  });

  it("generates and returns a persistent sub for a test user when omitted", async () => {
    const response = await context.app.inject({
      method: "POST",
      url: "/__mock/api/users",
      payload: {
        oid: "ABCDEF01-2345-6789-ABCD-EF0123456789",
        name: "Generated Subject User",
        preferred_username: "generated-sub@example.com",
        mail: "generated-sub@example.com",
        groups: [],
      },
    });
    expect(response.statusCode).toBe(201);
    const user = response.json<{ sub: string }>();
    expect(user.sub).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(
      (await context.app.inject("/__mock/api/users")).json(),
    ).toContainEqual(expect.objectContaining({ sub: user.sub }));
  });

  it.each([
    { oid: "not-a-guid" },
    { mail: "nope" },
    { name: "   " },
    { tid: mockTenantId },
    { unknown: true },
    { groups: "g1" },
    { sub: "" },
  ])("rejects invalid test user %#", async (overrides) => {
    const response = await context.app.inject({
      method: "POST",
      url: "/__mock/api/users",
      payload: {
        sub: "bad",
        oid: "abcdef01-2345-6789-abcd-ef0123456789",
        name: "Bad",
        preferred_username: "bad@example.com",
        mail: "bad@example.com",
        groups: [],
        ...overrides,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_user");
    expect((await context.app.inject("/__mock/api/users")).json()).toHaveLength(
      3,
    );
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
      const userDelete = await context.app.inject({
        method: "DELETE",
        url: "/__mock/api/users/user-admin",
        headers: { origin },
      });
      expect(userDelete.statusCode).toBe(403);
      expect(context.userStore.find("user-admin")).toBeDefined();
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
      await context.app.inject("/__mock/api/users"),
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
