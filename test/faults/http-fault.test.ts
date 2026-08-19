import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpFaultMiddleware } from "../../src/faults/http-fault.js";
import { InMemoryScenarioStore } from "../../src/scenario/store.js";

interface ResponseHarness {
  response: ServerResponse;
  headers: Map<string, string>;
  end: ReturnType<typeof vi.fn>;
}

function request(method: string, url: string): IncomingMessage {
  return { method, url, destroyed: false, headers: {} } as IncomingMessage;
}

function response(): ResponseHarness {
  const headers = new Map<string, string>();
  const target = {
    statusCode: 200,
    destroyed: false,
    writableEnded: false,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    end: vi.fn(function (this: { writableEnded: boolean }) {
      this.writableEnded = true;
    }),
  };
  return {
    response: target as unknown as ServerResponse,
    headers,
    end: target.end,
  };
}

function logger(): FastifyBaseLogger {
  return { warn: vi.fn() } as unknown as FastifyBaseLogger;
}

describe("HTTP fault middleware", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    ["TOKEN_500", "GET", "/token"],
    ["TOKEN_500", "HEAD", "/token"],
    ["JWKS_500", "POST", "/jwks"],
    ["JWKS_500", "HEAD", "/jwks"],
    ["DISCOVERY_500", "POST", "/.well-known/openid-configuration"],
    ["DISCOVERY_500", "HEAD", "/.well-known/openid-configuration"],
  ] as const)("does not consume %s for %s %s", (scenario, method, url) => {
    const store = new InMemoryScenarioStore();
    store.set({ scenario, mode: "LIMITED", failureCount: 1 });
    const res = response();
    const next = vi.fn();

    createHttpFaultMiddleware(store, logger())(
      request(method, url),
      res.response,
      next,
    );

    expect(next).toHaveBeenCalledOnce();
    expect(store.get().remainingFailures).toBe(1);
  });

  it("answers preflight with CORS headers without consuming", () => {
    const store = new InMemoryScenarioStore();
    store.set({ scenario: "TOKEN_500", mode: "LIMITED", failureCount: 1 });
    const res = response();
    const next = vi.fn();

    createHttpFaultMiddleware(store, logger())(
      request("OPTIONS", "/token"),
      res.response,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.response.statusCode).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(store.get().remainingFailures).toBe(1);
  });

  it("adds CORS and no-store headers to injected errors", () => {
    const store = new InMemoryScenarioStore();
    store.set({ scenario: "TOKEN_400", mode: "CONTINUOUS" });
    const res = response();
    const log = logger();

    createHttpFaultMiddleware(store, log)(
      {
        ...request("POST", "/token"),
        headers: { origin: "https://rp.example.test" },
      } as IncomingMessage,
      res.response,
      vi.fn(),
    );

    expect(res.response.statusCode).toBe(400);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://rp.example.test",
    );
    expect(res.headers.get("vary")).toBe("Origin");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
    expect(res.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        scenario: "TOKEN_400",
        endpoint: "token",
        mode: "CONTINUOUS",
        faultInjected: true,
      }),
      "[MOCK-IDP] fault injected",
    );
  });

  it("matches exact routes below the configured issuer path", () => {
    const store = new InMemoryScenarioStore();
    store.set({ scenario: "JWKS_500", mode: "LIMITED", failureCount: 1 });
    const middleware = createHttpFaultMiddleware(
      store,
      logger(),
      "/tenant/v2.0",
    );
    const outside = response();
    const outsideNext = vi.fn();

    middleware(request("GET", "/jwks"), outside.response, outsideNext);
    expect(outsideNext).toHaveBeenCalledOnce();
    expect(store.get().remainingFailures).toBe(1);

    const matched = response();
    middleware(request("GET", "/tenant/v2.0/jwks"), matched.response, vi.fn());
    expect(matched.response.statusCode).toBe(500);
    expect(store.get().scenario).toBe("NORMAL");
  });

  it("does not continue a delayed request after its socket is destroyed", () => {
    vi.useFakeTimers();
    const store = new InMemoryScenarioStore();
    store.set({
      scenario: "DISCOVERY_TIMEOUT",
      mode: "LIMITED",
      failureCount: 1,
      parameters: { delayMs: 100 },
    });
    const req = request("GET", "/.well-known/openid-configuration");
    const res = response();
    const next = vi.fn();

    createHttpFaultMiddleware(store, logger())(req, res.response, next);
    Object.defineProperty(req, "destroyed", { value: true });
    vi.advanceTimersByTime(100);

    expect(next).not.toHaveBeenCalled();
    expect(store.get().scenario).toBe("NORMAL");
  });

  it("passes synchronous middleware errors to next", () => {
    const store = new InMemoryScenarioStore();
    const next = vi.fn();

    createHttpFaultMiddleware(store, logger())(
      request("GET", "http://["),
      response().response,
      next,
    );

    expect(next).toHaveBeenCalledOnce();
    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});
