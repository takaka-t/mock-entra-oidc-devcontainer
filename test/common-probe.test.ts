import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AppContext } from "../src/app.js";
import type { SetScenarioInput } from "../src/scenario/types.js";
import { testConfig } from "./test-config.js";

const host = "mock-idp.test:9000";
const origin = "http://" + host;

describe.each(["", "/tenant/v2.0"])("common probe with issuer path '%s'", (issuerPath) => {
  let context: AppContext;
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "mock-idp-probe-"));
    context = await buildApp(
      testConfig({
        issuer: origin + issuerPath,
        keyDirectory: join(directory, "keys"),
        clientConfigFile: join(directory, "clients.json"),
        userConfigFile: join(directory, "users.json"),
      }),
      { https: false },
    );
  });
  afterAll(async () => {
    try {
      await context.app.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  /**
   * Every scenario that targets the connectivity probe, with the status it must
   * answer. AUTH_400 takes no parameters and AUTH_TIMEOUT resumes the healthy
   * 200 after its delay, so neither carries Retry-After.
   */
  const probeCases: ReadonlyArray<{
    input: SetScenarioInput;
    faultStatus: number;
    retryAfter: string | null;
  }> = [
    {
      input: { scenario: "AUTH_400", mode: "LIMITED", failureCount: 1 },
      faultStatus: 400,
      retryAfter: null,
    },
    {
      input: { scenario: "AUTH_429", mode: "LIMITED", failureCount: 1, parameters: { retryAfterSeconds: 7 } },
      faultStatus: 429,
      retryAfter: "7",
    },
    {
      input: { scenario: "AUTH_500", mode: "LIMITED", failureCount: 1, parameters: { retryAfterSeconds: 7 } },
      faultStatus: 500,
      retryAfter: "7",
    },
    {
      input: { scenario: "AUTH_TIMEOUT", mode: "LIMITED", failureCount: 1, parameters: { delayMs: 1 } },
      faultStatus: 200,
      retryAfter: null,
    },
  ];

  it.each(["/%63ommon/oauth2/v2.0/authorize", "/common/oauth2/v2.0/%61uthorize/", "/common/oauth2/v2%2E0/authorize"])(
    "enforces origin, CORS, and fault counts for %s",
    async (url) => {
      for (const { input, faultStatus, retryAfter } of probeCases) {
        const scenario = input.scenario;
        context.store.set(input);

        const mismatch = await context.app.inject({
          method: "HEAD",
          url,
          headers: { host: "unexpected.test" },
        });
        expect(mismatch.statusCode).toBe(400);
        // AUTH_400 also answers 400, so assert the origin error's own content
        // type: a wrongly consumed probe fault would reply with text/html.
        expect(mismatch.headers["content-type"]).toBe("application/json; charset=utf-8");
        expect(context.store.get().remainingFailures).toBe(1);

        const preflight = await context.app.inject({
          method: "OPTIONS",
          url,
          headers: { host, origin: "http://localhost:3000" },
        });
        expect(preflight.statusCode).toBe(204);
        expect(preflight.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
        for (const method of ["GET", "POST"] as const) {
          const response = await context.app.inject({
            method,
            url,
            headers: { host },
          });
          expect(response.statusCode, response.body).toBe(404);
        }
        expect(context.store.get().remainingFailures).toBe(1);

        const response = await context.app.inject({
          method: "HEAD",
          url,
          headers: { host, origin: "http://localhost:3000" },
        });
        expect(response.statusCode).toBe(faultStatus);
        expect(response.body).toBe("");
        expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
        expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
        expect(response.headers["cache-control"]).toBe("no-store");
        if (retryAfter === null) {
          expect(response.headers["retry-after"]).toBeUndefined();
        } else {
          expect(response.headers["retry-after"]).toBe(retryAfter);
          expect(response.headers["access-control-expose-headers"]).toContain("Retry-After");
        }
        expect(context.store.get()).toMatchObject({
          scenario: "NORMAL",
          lastCompleted: { scenario, triggeredCount: 1 },
        });
        const recovered = await context.app.inject({
          method: "HEAD",
          url,
          headers: { host },
        });
        expect(recovered.statusCode).toBe(200);
      }
    },
  );

  it.each([
    "/common%2Foauth2/v2.0/authorize",
    "/common/oauth2/v2.0%2Fauthorize",
    "/%2563ommon/oauth2/v2.0/authorize",
    "/common/oauth2/v2.0/authorize//",
  ])("does not reinterpret a different route or consume a fault: %s", async (url) => {
    context.store.set({
      scenario: "AUTH_500",
      mode: "LIMITED",
      failureCount: 1,
    });
    const response = await context.app.inject({
      method: "HEAD",
      url,
      headers: { host },
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(context.store.get()).toMatchObject({
      remainingFailures: 1,
      triggeredCount: 0,
    });
    context.store.reset();
  });
});
