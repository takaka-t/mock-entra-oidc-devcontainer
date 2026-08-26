import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type AppContext } from "../src/app.js";
import { testConfig } from "./test-config.js";

const host = "mock-idp.test:9000";
const issuer = `http://${host}`;
const authorizePath = "/oauth2/v2.0/authorize";
const authorizationFaultCases = [
  ["AUTH_LOGIN_REQUIRED", "login_required"],
  ["AUTH_INTERACTION_REQUIRED", "interaction_required"],
  ["AUTH_TEMPORARILY_UNAVAILABLE", "temporarily_unavailable"],
  ["AUTH_SERVER_ERROR", "server_error"],
] as const;

function mergeCookies(current: string, headers: OutgoingHttpHeaders): string {
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

class BrowserFlow {
  #cookies = "";
  #lastOpenedUrl: string | null = null;

  constructor(private readonly context: AppContext) {}

  async start(
    options: {
      prompt?: string;
      state?: string;
      responseMode?: "query" | "form_post";
    } = {},
  ) {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const query = new URLSearchParams({
      client_id: "mock-public-client",
      redirect_uri: "http://localhost:3000/callback",
      response_type: "code",
      scope: "openid profile",
      state: options.state ?? "interaction-state",
      nonce: randomBytes(12).toString("base64url"),
      code_challenge: challenge,
      code_challenge_method: "S256",
      ...(options.prompt ? { prompt: options.prompt } : {}),
      ...(options.responseMode ? { response_mode: options.responseMode } : {}),
    });
    return this.inject(`${authorizePath}?${query}`);
  }

  async openLocation(response: LightMyRequestResponse) {
    const location = new URL(String(response.headers.location), issuer);
    this.#lastOpenedUrl = `${location.pathname}${location.search}`;
    return this.inject(this.#lastOpenedUrl);
  }

  async submit(
    _interactionResponse: LightMyRequestResponse,
    payload = "accountId=user-normal",
  ) {
    if (!this.#lastOpenedUrl)
      throw new Error("No interaction URL has been opened");
    return this.inject(this.#lastOpenedUrl, {
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      payload,
    });
  }

  async submitLocation(
    response: LightMyRequestResponse,
    payload = "accountId=user-normal",
  ) {
    const location = new URL(String(response.headers.location), issuer);
    this.#lastOpenedUrl = `${location.pathname}${location.search}`;
    return this.submit(response, payload);
  }

  async submitEncodedLocation(
    response: LightMyRequestResponse,
    payload = "accountId=user-normal",
  ) {
    const location = new URL(String(response.headers.location), issuer);
    this.#lastOpenedUrl = `${location.pathname.replace("/interaction/", "/%69nteraction/")}${location.search}`;
    return this.submit(response, payload);
  }

  async followToCallback(
    initialResponse: LightMyRequestResponse,
  ): Promise<URL> {
    let response = initialResponse;
    for (let attempts = 0; attempts < 8; attempts++) {
      const rawLocation = response.headers.location;
      if (!rawLocation)
        throw new Error(
          `Expected redirect, received ${response.statusCode}: ${response.body.slice(0, 200)}`,
        );
      if (String(rawLocation).startsWith("http://localhost:3000"))
        return new URL(String(rawLocation));
      response = await this.openLocation(response);
    }
    throw new Error("OIDC redirect chain did not reach the callback");
  }

  async complete(options: { prompt?: string; state?: string } = {}) {
    const start = await this.start(options);
    const interaction = await this.openLocation(start);
    expect(interaction.statusCode, interaction.body).toBe(200);
    expect(interaction.body).toContain("Select a test user");
    return this.followToCallback(await this.submit(interaction));
  }

  private async inject(
    url: string,
    options: {
      method?: "GET" | "POST";
      contentType?: string;
      payload?: string;
    } = {},
  ) {
    const response = await this.context.app.inject({
      method: options.method ?? "GET",
      url,
      headers: {
        host,
        ...(this.#cookies ? { cookie: this.#cookies } : {}),
        ...(options.contentType ? { "content-type": options.contentType } : {}),
      },
      ...(options.payload === undefined ? {} : { payload: options.payload }),
    });
    this.#cookies = mergeCookies(this.#cookies, response.headers);
    return response;
  }
}

describe("custom interaction policy", () => {
  let context: AppContext;
  let stateDirectory: string;

  beforeAll(async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), "mock-idp-interaction-"));
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

  it("applies ACCESS_DENIED to a new session", async () => {
    context.store.set({
      scenario: "ACCESS_DENIED",
      mode: "LIMITED",
      failureCount: 1,
    });
    const browser = new BrowserFlow(context);
    const interaction = await browser.openLocation(
      await browser.start({ state: "new-session-denied" }),
    );
    expect(interaction.statusCode).toBe(303);
    const callback = await browser.followToCallback(interaction);
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("state")).toBe("new-session-denied");
    expect(context.store.get()).toMatchObject({
      scenario: "NORMAL",
      lastCompleted: { scenario: "ACCESS_DENIED", triggeredCount: 1 },
    });
  });

  it("cannot bypass ACCESS_DENIED by posting directly to the interaction", async () => {
    context.store.set({
      scenario: "ACCESS_DENIED",
      mode: "LIMITED",
      failureCount: 1,
    });
    const browser = new BrowserFlow(context);
    const denied = await browser.submitLocation(
      await browser.start({ state: "direct-post-denied" }),
    );
    expect(denied.statusCode).toBe(303);
    const callback = await browser.followToCallback(denied);
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("state")).toBe("direct-post-denied");
    expect(callback.searchParams.get("code")).toBeNull();
  });

  it("cannot bypass ACCESS_DENIED through an encoded interaction route", async () => {
    context.store.set({
      scenario: "ACCESS_DENIED",
      mode: "LIMITED",
      failureCount: 1,
    });
    const browser = new BrowserFlow(context);
    const denied = await browser.submitEncodedLocation(
      await browser.start({ state: "encoded-post-denied" }),
    );
    expect(denied.statusCode).toBe(303);
    const callback = await browser.followToCallback(denied);
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("state")).toBe("encoded-post-denied");
    expect(callback.searchParams.get("code")).toBeNull();
  });

  it("applies ACCESS_DENIED even when an existing session can skip login", async () => {
    const browser = new BrowserFlow(context);
    expect((await browser.complete()).searchParams.get("code")).toBeTruthy();
    context.store.set({
      scenario: "ACCESS_DENIED",
      mode: "LIMITED",
      failureCount: 1,
    });

    const interaction = await browser.openLocation(
      await browser.start({ state: "existing-session-denied" }),
    );
    expect(interaction.statusCode).toBe(303);
    const callback = await browser.followToCallback(interaction);
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("state")).toBe("existing-session-denied");
  });

  it("returns access_denied directly for prompt=none", async () => {
    context.store.set({
      scenario: "ACCESS_DENIED",
      mode: "LIMITED",
      failureCount: 1,
    });
    const callback = new URL(
      String(
        (
          await new BrowserFlow(context).start({
            prompt: "none",
            state: "silent-denied",
          })
        ).headers.location,
      ),
    );
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("state")).toBe("silent-denied");
    expect(context.store.get().scenario).toBe("NORMAL");
  });

  it.each(authorizationFaultCases)(
    "returns %s through the validated authorization redirect",
    async (scenario, expectedError) => {
      context.store.set({ scenario, mode: "LIMITED", failureCount: 1 });
      const browser = new BrowserFlow(context);
      const interaction = await browser.openLocation(
        await browser.start({ state: `${scenario}-state` }),
      );

      expect(interaction.statusCode).toBe(303);
      const callback = await browser.followToCallback(interaction);
      expect(callback.searchParams.get("error")).toBe(expectedError);
      expect(callback.searchParams.get("state")).toBe(`${scenario}-state`);
      expect(callback.searchParams.get("code")).toBeNull();
      expect(context.store.get()).toMatchObject({
        scenario: "NORMAL",
        lastCompleted: { scenario, triggeredCount: 1 },
      });
    },
  );

  it.each(authorizationFaultCases)(
    "cannot bypass %s by posting directly to the interaction",
    async (scenario, expectedError) => {
      context.store.set({ scenario, mode: "LIMITED", failureCount: 1 });
      const browser = new BrowserFlow(context);
      const finished = await browser.submitLocation(
        await browser.start({ state: `${scenario}-direct` }),
      );
      const callback = await browser.followToCallback(finished);

      expect(callback.searchParams.get("error")).toBe(expectedError);
      expect(callback.searchParams.get("state")).toBe(`${scenario}-direct`);
      expect(callback.searchParams.get("code")).toBeNull();
    },
  );

  it.each(authorizationFaultCases)(
    "returns %s directly for prompt=none",
    async (scenario, expectedError) => {
      context.store.set({ scenario, mode: "LIMITED", failureCount: 1 });
      const response = await new BrowserFlow(context).start({
        prompt: "none",
        state: `${scenario}-silent`,
      });
      const callback = new URL(String(response.headers.location));

      expect(callback.searchParams.get("error")).toBe(expectedError);
      expect(callback.searchParams.get("state")).toBe(`${scenario}-silent`);
      expect(callback.searchParams.get("code")).toBeNull();
    },
  );

  it("preserves response_mode=form_post for AUTH_LOGIN_REQUIRED", async () => {
    context.store.set({
      scenario: "AUTH_LOGIN_REQUIRED",
      mode: "LIMITED",
      failureCount: 1,
    });
    const response = await new BrowserFlow(context).start({
      prompt: "none",
      state: "form-post-state",
      responseMode: "form_post",
    });

    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain(
      '<input type="hidden" name="error" value="login_required"/>',
    );
    expect(response.body).toContain(
      '<input type="hidden" name="state" value="form-post-state"/>',
    );
    expect(response.body).not.toContain('name="code"');
  });

  it("does not send an authorization fault to an unregistered redirect URI", async () => {
    context.store.set({
      scenario: "AUTH_LOGIN_REQUIRED",
      mode: "LIMITED",
      failureCount: 1,
    });
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({
      client_id: "mock-public-client",
      redirect_uri: "https://unregistered.example.test/callback",
      response_type: "code",
      scope: "openid",
      state: "must-not-leak",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    const response = await context.app.inject({
      url: `${authorizePath}?${query}`,
      headers: { host },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(context.store.get()).toMatchObject({
      scenario: "AUTH_LOGIN_REQUIRED",
      remainingFailures: 1,
      triggeredCount: 0,
    });
  });

  it("naturally returns login_required for a fresh prompt=none request", async () => {
    const response = await new BrowserFlow(context).start({
      prompt: "none",
      state: "fresh-silent-login",
    });
    const callback = new URL(String(response.headers.location));

    expect(callback.searchParams.get("error")).toBe("login_required");
    expect(callback.searchParams.get("state")).toBe("fresh-silent-login");
    expect(callback.searchParams.get("code")).toBeNull();
  });

  it("injects AUTH_LOGIN_REQUIRED when an existing session could authenticate silently", async () => {
    const browser = new BrowserFlow(context);
    expect((await browser.complete()).searchParams.get("code")).toBeTruthy();
    context.store.set({
      scenario: "AUTH_LOGIN_REQUIRED",
      mode: "LIMITED",
      failureCount: 1,
    });

    const response = await browser.start({
      prompt: "none",
      state: "existing-silent-login",
    });
    const callback = new URL(String(response.headers.location));

    expect(callback.searchParams.get("error")).toBe("login_required");
    expect(callback.searchParams.get("state")).toBe("existing-silent-login");
    expect(callback.searchParams.get("code")).toBeNull();
    expect(context.store.get()).toMatchObject({
      scenario: "NORMAL",
      lastCompleted: {
        scenario: "AUTH_LOGIN_REQUIRED",
        triggeredCount: 1,
      },
    });
  });

  it("returns two LIMITED AUTH_LOGIN_REQUIRED errors before silent authentication recovers", async () => {
    const browser = new BrowserFlow(context);
    expect((await browser.complete()).searchParams.get("code")).toBeTruthy();
    context.store.set({
      scenario: "AUTH_LOGIN_REQUIRED",
      mode: "LIMITED",
      failureCount: 2,
    });

    for (const [state, remainingFailures] of [
      ["limited-login-one", 1],
      ["limited-login-two", 0],
    ] as const) {
      const response = await browser.start({ prompt: "none", state });
      const callback = new URL(String(response.headers.location));
      expect(callback.searchParams.get("error")).toBe("login_required");
      expect(callback.searchParams.get("state")).toBe(state);
      if (remainingFailures === 0)
        expect(context.store.get().scenario).toBe("NORMAL");
      else
        expect(context.store.get().remainingFailures).toBe(remainingFailures);
    }

    const recovered = new URL(
      String(
        (
          await browser.start({
            prompt: "none",
            state: "limited-login-recovered",
          })
        ).headers.location,
      ),
    );
    expect(recovered.searchParams.get("error")).toBeNull();
    expect(recovered.searchParams.get("code")).toBeTruthy();
    expect(recovered.searchParams.get("state")).toBe("limited-login-recovered");
  });

  it("keeps CONTINUOUS AUTH_LOGIN_REQUIRED active across requests", async () => {
    context.store.set({
      scenario: "AUTH_LOGIN_REQUIRED",
      mode: "CONTINUOUS",
    });
    const browser = new BrowserFlow(context);

    for (const state of ["continuous-login-one", "continuous-login-two"]) {
      const response = await browser.start({ prompt: "none", state });
      const callback = new URL(String(response.headers.location));
      expect(callback.searchParams.get("error")).toBe("login_required");
      expect(callback.searchParams.get("state")).toBe(state);
    }
    expect(context.store.get()).toMatchObject({
      scenario: "AUTH_LOGIN_REQUIRED",
      status: "ACTIVE",
      triggeredCount: 2,
    });
  });

  it.each([
    "ACCESS_DENIED",
    "AUTH_LOGIN_REQUIRED",
    "AUTH_INTERACTION_REQUIRED",
    "AUTH_TEMPORARILY_UNAVAILABLE",
    "AUTH_SERVER_ERROR",
  ] as const)("does not consume %s for HEAD /authorize", async (scenario) => {
    context.store.set({ scenario, mode: "LIMITED", failureCount: 1 });
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({
      client_id: "mock-public-client",
      redirect_uri: "http://localhost:3000/callback",
      response_type: "code",
      scope: "openid",
      state: "head-must-not-consume",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });

    await context.app.inject({
      method: "HEAD",
      url: `${authorizePath}?${query}`,
      headers: { host },
    });

    expect(context.store.get()).toMatchObject({
      scenario,
      remainingFailures: 1,
      triggeredCount: 0,
    });
  });

  it("allows exactly one concurrent authorization to consume LIMITED 1", async () => {
    context.store.set({
      scenario: "ACCESS_DENIED",
      mode: "LIMITED",
      failureCount: 1,
    });
    const first = new BrowserFlow(context);
    const second = new BrowserFlow(context);
    const starts = await Promise.all([
      first.start({ state: "parallel-one" }),
      second.start({ state: "parallel-two" }),
    ]);
    const interactions = await Promise.all([
      first.openLocation(starts[0]),
      second.openLocation(starts[1]),
    ]);
    expect(interactions.map((response) => response.statusCode).sort()).toEqual([
      200, 303,
    ]);
    expect(context.store.get().lastCompleted).toMatchObject({
      scenario: "ACCESS_DENIED",
      triggeredCount: 1,
    });
  });

  it("supports prompt=select_account for fresh and existing sessions", async () => {
    const browser = new BrowserFlow(context);
    const fresh = await browser.complete({
      prompt: "select_account",
      state: "fresh-select",
    });
    expect(fresh.searchParams.get("code")).toBeTruthy();
    expect(fresh.searchParams.get("state")).toBe("fresh-select");

    const start = await browser.start({
      prompt: "select_account",
      state: "existing-select",
    });
    const picker = await browser.openLocation(start);
    expect(picker.statusCode).toBe(200);
    expect(picker.body).toContain("Select a test user");
    const existing = await browser.followToCallback(
      await browser.submit(picker, "accountId=user-normal"),
    );
    expect(existing.searchParams.get("code")).toBeTruthy();
    expect(existing.searchParams.get("state")).toBe("existing-select");
  });

  it("returns 400 for an invalid interaction body", async () => {
    const browser = new BrowserFlow(context);
    const picker = await browser.openLocation(await browser.start());
    const response = await browser.submit(picker, "unexpected=value");
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_interaction_body" });
  });

  it("sets protective headers on interaction responses", async () => {
    const browser = new BrowserFlow(context);
    const picker = await browser.openLocation(await browser.start());
    expect(picker.headers["cache-control"]).toBe("no-store");
    expect(picker.headers["content-security-policy"]).toBe(
      "frame-ancestors 'none'",
    );
    expect(picker.headers["referrer-policy"]).toBe("no-referrer");
    expect(picker.headers["x-content-type-options"]).toBe("nosniff");
    expect(picker.headers["x-frame-options"]).toBe("DENY");
  });
});
