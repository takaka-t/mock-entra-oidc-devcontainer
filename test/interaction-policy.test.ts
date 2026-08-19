import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type AppContext } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const host = "mock-idp.test:9000";
const issuer = `http://${host}`;

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

  async start(options: { prompt?: string; state?: string } = {}) {
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
    });
    return this.inject(`/authorize?${query}`);
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
  let keyDirectory: string;

  beforeAll(async () => {
    keyDirectory = await mkdtemp(join(tmpdir(), "mock-idp-interaction-"));
    context = await buildApp(
      loadConfig({
        NODE_ENV: "test",
        OIDC_ISSUER: issuer,
        KEY_DIRECTORY: keyDirectory,
      }),
    );
  });

  beforeEach(() => context.store.reset());

  afterAll(async () => {
    await context.app.close();
    await rm(keyDirectory, { recursive: true, force: true });
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
