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
    ["TOKEN_429", "GET", "/token"],
    ["TOKEN_429", "HEAD", "/token"],
    ["JWKS_500", "POST", "/jwks"],
    ["JWKS_500", "HEAD", "/jwks"],
    ["JWKS_INVALID", "POST", "/jwks"],
    ["DISCOVERY_500", "POST", "/.well-known/openid-configuration"],
    ["DISCOVERY_500", "HEAD", "/.well-known/openid-configuration"],
    ["DISCOVERY_INVALID", "POST", "/.well-known/openid-configuration"],
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

  it("returns TOKEN_429 with Retry-After exposed to browser clients", () => {
    const store = new InMemoryScenarioStore();
    store.set({
      scenario: "TOKEN_429",
      mode: "CONTINUOUS",
      parameters: { retryAfterSeconds: 17 },
    });
    const res = response();

    createHttpFaultMiddleware(store, logger())(
      {
        ...request("POST", "/token"),
        headers: { origin: "https://rp.example.test" },
      } as IncomingMessage,
      res.response,
      vi.fn(),
    );

    expect(res.response.statusCode).toBe(429);
    expect(res.headers.get("retry-after")).toBe("17");
    expect(res.headers.get("access-control-expose-headers")).toBe(
      "Retry-After",
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(String(res.end.mock.calls[0]?.[0]))).toEqual({
      error: "temporarily_unavailable",
      error_description: "Injected TOKEN_429 fault",
    });
  });

  it("defaults TOKEN_429 Retry-After to 60 seconds", () => {
    const store = new InMemoryScenarioStore();
    store.set({ scenario: "TOKEN_429", mode: "CONTINUOUS" });
    const res = response();

    createHttpFaultMiddleware(store, logger())(
      request("POST", "/token"),
      res.response,
      vi.fn(),
    );

    expect(res.headers.get("retry-after")).toBe("60");
  });

  it("adds Retry-After to TOKEN_500 only when configured", () => {
    const store = new InMemoryScenarioStore();
    const middleware = createHttpFaultMiddleware(store, logger());

    store.set({ scenario: "TOKEN_500", mode: "CONTINUOUS" });
    const withoutRetryAfter = response();
    middleware(request("POST", "/token"), withoutRetryAfter.response, vi.fn());
    expect(withoutRetryAfter.response.statusCode).toBe(500);
    expect(withoutRetryAfter.headers.has("retry-after")).toBe(false);
    expect(withoutRetryAfter.headers.has("access-control-expose-headers")).toBe(
      false,
    );

    store.set({
      scenario: "TOKEN_500",
      mode: "CONTINUOUS",
      parameters: { retryAfterSeconds: 5 },
    });
    const withRetryAfter = response();
    middleware(request("POST", "/token"), withRetryAfter.response, vi.fn());
    expect(withRetryAfter.response.statusCode).toBe(500);
    expect(withRetryAfter.headers.get("retry-after")).toBe("5");
    expect(withRetryAfter.headers.get("access-control-expose-headers")).toBe(
      "Retry-After",
    );
  });

  it.each([
    ["DISCOVERY_INVALID", "/.well-known/openid-configuration", {}],
    [
      "JWKS_INVALID",
      "/jwks",
      { keys: [{ kty: "RSA", kid: "mock-invalid-jwk" }] },
    ],
  ] as const)(
    "returns malformed successful data for %s",
    (scenario, url, body) => {
      const store = new InMemoryScenarioStore();
      store.set({ scenario, mode: "CONTINUOUS" });
      const res = response();

      createHttpFaultMiddleware(store, logger())(
        request("GET", url),
        res.response,
        vi.fn(),
      );

      expect(res.response.statusCode).toBe(200);
      expect(res.headers.get("content-type")).toBe(
        "application/json; charset=utf-8",
      );
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(JSON.parse(String(res.end.mock.calls[0]?.[0]))).toEqual(body);
    },
  );

  it.each([
    ["TOKEN_429", "POST", "/token", 429],
    ["JWKS_INVALID", "GET", "/jwks", 200],
    ["DISCOVERY_INVALID", "GET", "/.well-known/openid-configuration", 200],
  ] as const)(
    "consumes a LIMITED %s fault only once",
    (scenario, method, url, statusCode) => {
      const store = new InMemoryScenarioStore();
      store.set({ scenario, mode: "LIMITED", failureCount: 1 });
      const middleware = createHttpFaultMiddleware(store, logger());
      const injected = response();
      const normal = response();
      const normalNext = vi.fn();

      middleware(request(method, url), injected.response, vi.fn());
      middleware(request(method, url), normal.response, normalNext);

      expect(injected.response.statusCode).toBe(statusCode);
      expect(store.get().scenario).toBe("NORMAL");
      expect(normalNext).toHaveBeenCalledOnce();
      expect(normal.end).not.toHaveBeenCalled();
    },
  );

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
