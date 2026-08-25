import { EventEmitter } from "node:events";
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
  return Object.assign(new EventEmitter(), {
    method,
    url,
    destroyed: false,
    headers: {},
  }) as IncomingMessage;
}

function response(): ResponseHarness {
  const headers = new Map<string, string>();
  const target = Object.assign(new EventEmitter(), {
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
  });
  return {
    response: target as unknown as ServerResponse,
    headers,
    end: target.end,
  };
}

function logger(): FastifyBaseLogger {
  return { warn: vi.fn() } as unknown as FastifyBaseLogger;
}

const endpointCases = [
  {
    endpoint: "authorization-http",
    method: "GET",
    url: "/authorize",
    throttle: "AUTH_429",
    serverError: "AUTH_500",
    timeout: "AUTH_TIMEOUT",
  },
  {
    endpoint: "token",
    method: "POST",
    url: "/token",
    throttle: "TOKEN_429",
    serverError: "TOKEN_500",
    timeout: "TOKEN_TIMEOUT",
  },
  {
    endpoint: "jwks",
    method: "GET",
    url: "/jwks",
    throttle: "JWKS_429",
    serverError: "JWKS_500",
    timeout: "JWKS_TIMEOUT",
  },
  {
    endpoint: "discovery",
    method: "GET",
    url: "/.well-known/openid-configuration",
    throttle: "DISCOVERY_429",
    serverError: "DISCOVERY_500",
    timeout: "DISCOVERY_TIMEOUT",
  },
] as const;

describe("HTTP fault middleware", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    ["AUTH_500", "POST", "/authorize"],
    ["AUTH_500", "HEAD", "/authorize"],
    ["TOKEN_500", "GET", "/token"],
    ["TOKEN_500", "HEAD", "/token"],
    ["TOKEN_429", "GET", "/token"],
    ["TOKEN_429", "HEAD", "/token"],
    ["JWKS_500", "POST", "/jwks"],
    ["JWKS_500", "HEAD", "/jwks"],
    ["JWKS_INVALID", "POST", "/jwks"],
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

  it.each(endpointCases)(
    "answers OPTIONS for $endpoint with CORS headers without consuming",
    ({ serverError, url }) => {
      const store = new InMemoryScenarioStore();
      store.set({
        scenario: serverError,
        mode: "LIMITED",
        failureCount: 1,
      });
      const res = response();
      const next = vi.fn();

      createHttpFaultMiddleware(store, logger())(
        request("OPTIONS", url),
        res.response,
        next,
      );

      expect(next).not.toHaveBeenCalled();
      expect(res.response.statusCode).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-methods")).toBe(
        "GET, HEAD, POST, OPTIONS",
      );
      expect(store.get().remainingFailures).toBe(1);
    },
  );

  it.each(endpointCases)(
    "injects $serverError for one provider-compatible trailing slash at $endpoint",
    ({ serverError, method, url }) => {
      const store = new InMemoryScenarioStore();
      store.set({ scenario: serverError, mode: "LIMITED", failureCount: 1 });
      const res = response();

      createHttpFaultMiddleware(store, logger())(
        request(method, `${url}/?ignored=query`),
        res.response,
        vi.fn(),
      );

      expect(res.response.statusCode).toBe(500);
      expect(store.get()).toMatchObject({
        scenario: "NORMAL",
        lastCompleted: { scenario: serverError, triggeredCount: 1 },
      });
    },
  );

  it.each(endpointCases)(
    "does not match two trailing slashes at $endpoint",
    ({ serverError, method, url }) => {
      const store = new InMemoryScenarioStore();
      store.set({ scenario: serverError, mode: "LIMITED", failureCount: 1 });
      const res = response();
      const next = vi.fn();

      createHttpFaultMiddleware(store, logger())(
        request(method, `${url}//?ignored=query`),
        res.response,
        next,
      );

      expect(next).toHaveBeenCalledOnce();
      expect(res.end).not.toHaveBeenCalled();
      expect(store.get()).toMatchObject({
        scenario: serverError,
        remainingFailures: 1,
        triggeredCount: 0,
      });
    },
  );

  it.each(endpointCases)(
    "does not consume $serverError for OPTIONS or HEAD with a trailing slash",
    ({ serverError, url }) => {
      const store = new InMemoryScenarioStore();
      store.set({ scenario: serverError, mode: "LIMITED", failureCount: 1 });
      const middleware = createHttpFaultMiddleware(store, logger());
      const options = response();
      const optionsNext = vi.fn();

      middleware(request("OPTIONS", `${url}/`), options.response, optionsNext);
      expect(options.response.statusCode).toBe(204);
      expect(optionsNext).not.toHaveBeenCalled();

      const head = response();
      const headNext = vi.fn();
      middleware(request("HEAD", `${url}/`), head.response, headNext);
      expect(headNext).toHaveBeenCalledOnce();
      expect(head.end).not.toHaveBeenCalled();
      expect(store.get()).toMatchObject({
        scenario: serverError,
        remainingFailures: 1,
        triggeredCount: 0,
      });
    },
  );

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

  it.each(endpointCases)(
    "returns $throttle at $endpoint with the common Retry-After/body contract",
    ({ throttle, endpoint, method, url }) => {
      const store = new InMemoryScenarioStore();
      store.set({
        scenario: throttle,
        mode: "CONTINUOUS",
        parameters: { retryAfterSeconds: 17 },
      });
      const res = response();
      const log = logger();

      createHttpFaultMiddleware(store, log)(
        {
          ...request(method, `${url}?ignored=query`),
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
      expect(res.headers.get("pragma")).toBe("no-cache");
      expect(res.headers.get("content-type")).toBe(
        "application/json; charset=utf-8",
      );
      expect(res.headers.has("location")).toBe(false);
      expect(JSON.parse(String(res.end.mock.calls[0]?.[0]))).toEqual({
        error: "temporarily_unavailable",
        error_description: `Injected ${throttle} fault`,
      });
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ scenario: throttle, endpoint }),
        "[MOCK-IDP] fault injected",
      );
    },
  );

  it.each(endpointCases)(
    "defaults $throttle Retry-After to 60 seconds",
    ({ throttle, method, url }) => {
      const store = new InMemoryScenarioStore();
      store.set({ scenario: throttle, mode: "CONTINUOUS" });
      const res = response();

      createHttpFaultMiddleware(store, logger())(
        request(method, url),
        res.response,
        vi.fn(),
      );

      expect(res.headers.get("retry-after")).toBe("60");
    },
  );

  it.each(endpointCases)(
    "adds Retry-After to $serverError only when configured",
    ({ serverError, method, url }) => {
      const store = new InMemoryScenarioStore();
      const middleware = createHttpFaultMiddleware(store, logger());

      store.set({ scenario: serverError, mode: "CONTINUOUS" });
      const withoutRetryAfter = response();
      middleware(request(method, url), withoutRetryAfter.response, vi.fn());
      expect(withoutRetryAfter.response.statusCode).toBe(500);
      expect(withoutRetryAfter.headers.has("retry-after")).toBe(false);
      expect(
        withoutRetryAfter.headers.has("access-control-expose-headers"),
      ).toBe(false);
      expect(withoutRetryAfter.headers.has("location")).toBe(false);
      expect(
        JSON.parse(String(withoutRetryAfter.end.mock.calls[0]?.[0])),
      ).toEqual({
        error: "server_error",
        error_description: `Injected ${serverError} fault`,
      });

      store.set({
        scenario: serverError,
        mode: "CONTINUOUS",
        parameters: { retryAfterSeconds: 5 },
      });
      const withRetryAfter = response();
      middleware(request(method, url), withRetryAfter.response, vi.fn());
      expect(withRetryAfter.response.statusCode).toBe(500);
      expect(withRetryAfter.headers.get("retry-after")).toBe("5");
      expect(withRetryAfter.headers.get("access-control-expose-headers")).toBe(
        "Retry-After",
      );
    },
  );

  it("returns malformed successful data for JWKS_INVALID", () => {
    const store = new InMemoryScenarioStore();
    store.set({ scenario: "JWKS_INVALID", mode: "CONTINUOUS" });
    const res = response();

    createHttpFaultMiddleware(store, logger())(
      request("GET", "/jwks"),
      res.response,
      vi.fn(),
    );

    expect(res.response.statusCode).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(String(res.end.mock.calls[0]?.[0]))).toEqual({
      keys: [{ kty: "RSA", kid: "mock-invalid-jwk" }],
    });
  });

  it.each(endpointCases)(
    "consumes a LIMITED $throttle fault only once",
    ({ throttle, method, url }) => {
      const store = new InMemoryScenarioStore();
      store.set({ scenario: throttle, mode: "LIMITED", failureCount: 1 });
      const middleware = createHttpFaultMiddleware(store, logger());
      const injected = response();
      const normal = response();
      const normalNext = vi.fn();

      middleware(request(method, url), injected.response, vi.fn());
      middleware(request(method, url), normal.response, normalNext);

      expect(injected.response.statusCode).toBe(429);
      expect(store.get().scenario).toBe("NORMAL");
      expect(normalNext).toHaveBeenCalledOnce();
      expect(normal.end).not.toHaveBeenCalled();
    },
  );

  it.each([
    "ACCESS_DENIED",
    "AUTH_LOGIN_REQUIRED",
    "AUTH_INTERACTION_REQUIRED",
    "AUTH_TEMPORARILY_UNAVAILABLE",
    "AUTH_SERVER_ERROR",
  ] as const)(
    "does not preempt the %s authorization protocol fault",
    (scenario) => {
      const store = new InMemoryScenarioStore();
      store.set({ scenario, mode: "LIMITED", failureCount: 1 });
      const req = request("GET", "/authorize");
      const next = vi.fn();

      createHttpFaultMiddleware(store, logger())(
        req,
        response().response,
        next,
      );

      expect(next).toHaveBeenCalledOnce();
      expect(store.get()).toMatchObject({
        scenario,
        remainingFailures: 1,
        triggeredCount: 0,
      });
      expect(
        store.consumeForRequest("authorization", store.getRequestTicket(req)),
      ).toMatchObject({ scenario, endpoint: "authorization" });
    },
  );

  it("isolates AUTH_500 and preserves LIMITED 2 until two GET /authorize requests", () => {
    const store = new InMemoryScenarioStore();
    store.set({ scenario: "AUTH_500", mode: "LIMITED", failureCount: 2 });
    const middleware = createHttpFaultMiddleware(store, logger());
    for (const [method, url] of [
      ["POST", "/token"],
      ["GET", "/jwks"],
      ["GET", "/.well-known/openid-configuration"],
      ["POST", "/authorize"],
    ] as const) {
      const next = vi.fn();
      middleware(request(method, url), response().response, next);
      expect(next).toHaveBeenCalledOnce();
      expect(store.get().remainingFailures).toBe(2);
    }

    for (const remaining of [1, 0]) {
      const injected = response();
      middleware(request("GET", "/authorize"), injected.response, vi.fn());
      expect(injected.response.statusCode).toBe(500);
      expect(
        remaining === 0
          ? store.get().lastCompleted?.remainingFailures
          : store.get().remainingFailures,
      ).toBe(remaining);
    }
    const recovered = response();
    const recoveredNext = vi.fn();
    middleware(request("GET", "/authorize"), recovered.response, recoveredNext);
    expect(recoveredNext).toHaveBeenCalledOnce();
    expect(recovered.end).not.toHaveBeenCalled();
    expect(store.get()).toMatchObject({
      scenario: "NORMAL",
      lastCompleted: { scenario: "AUTH_500", triggeredCount: 2 },
    });
  });

  it.each(endpointCases)(
    "matches the $endpoint route with a trailing slash below the configured issuer path",
    ({ serverError, method, url }) => {
      const store = new InMemoryScenarioStore();
      store.set({
        scenario: serverError,
        mode: "LIMITED",
        failureCount: 1,
      });
      const middleware = createHttpFaultMiddleware(
        store,
        logger(),
        "/tenant/v2.0",
      );
      const outside = response();
      const outsideNext = vi.fn();

      middleware(request(method, url), outside.response, outsideNext);
      expect(outsideNext).toHaveBeenCalledOnce();
      expect(store.get().remainingFailures).toBe(1);

      const matched = response();
      middleware(
        request(method, `/tenant/v2.0${url}/`),
        matched.response,
        vi.fn(),
      );
      expect(matched.response.statusCode).toBe(500);
      expect(store.get().scenario).toBe("NORMAL");
    },
  );

  it.each(endpointCases)(
    "delays $timeout and then continues normal endpoint processing",
    ({ timeout, method, url }) => {
      vi.useFakeTimers();
      const store = new InMemoryScenarioStore();
      store.set({
        scenario: timeout,
        mode: "LIMITED",
        failureCount: 1,
        parameters: { delayMs: 100 },
      });
      const req = request(method, url);
      const res = response();
      const next = vi.fn();

      createHttpFaultMiddleware(store, logger())(req, res.response, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.end).not.toHaveBeenCalled();
      expect(store.get().scenario).toBe("NORMAL");
      expect(vi.getTimerCount()).toBe(1);
      expect(req.listenerCount("aborted")).toBe(1);
      expect(res.response.listenerCount("close")).toBe(1);
      vi.advanceTimersByTime(99);
      expect(next).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(next).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      expect(req.listenerCount("aborted")).toBe(0);
      expect(res.response.listenerCount("close")).toBe(0);

      req.emit("aborted");
      res.response.emit("close");
      expect(next).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["request aborted", "LIMITED", "request"],
    ["response close", "CONTINUOUS", "response"],
  ] as const)(
    "cancels and cleans up a delayed request on %s without restoring the count",
    (_name, mode, eventTarget) => {
      vi.useFakeTimers();
      const store = new InMemoryScenarioStore();
      store.set(
        mode === "LIMITED"
          ? {
              scenario: "AUTH_TIMEOUT",
              mode,
              failureCount: 1,
              parameters: { delayMs: 100 },
            }
          : {
              scenario: "AUTH_TIMEOUT",
              mode,
              parameters: { delayMs: 100 },
            },
      );
      const req = request("GET", "/authorize");
      const res = response();
      const next = vi.fn();

      createHttpFaultMiddleware(store, logger())(req, res.response, next);
      expect(vi.getTimerCount()).toBe(1);
      expect(req.listenerCount("aborted")).toBe(1);
      expect(res.response.listenerCount("close")).toBe(1);

      if (eventTarget === "request") req.emit("aborted");
      else res.response.emit("close");

      expect(vi.getTimerCount()).toBe(0);
      expect(req.listenerCount("aborted")).toBe(0);
      expect(res.response.listenerCount("close")).toBe(0);
      vi.advanceTimersByTime(100);
      expect(next).not.toHaveBeenCalled();
      if (mode === "LIMITED") {
        expect(store.get()).toMatchObject({
          scenario: "NORMAL",
          lastCompleted: { scenario: "AUTH_TIMEOUT", triggeredCount: 1 },
        });
      } else {
        expect(store.get()).toMatchObject({
          scenario: "AUTH_TIMEOUT",
          status: "ACTIVE",
          triggeredCount: 1,
        });
      }
    },
  );

  it("immediately cleans up a timeout accepted after the request was destroyed", () => {
    vi.useFakeTimers();
    const store = new InMemoryScenarioStore();
    store.set({
      scenario: "AUTH_TIMEOUT",
      mode: "LIMITED",
      failureCount: 1,
      parameters: { delayMs: 100 },
    });
    const req = request("GET", "/authorize");
    Object.defineProperty(req, "destroyed", { value: true });
    const res = response();
    const next = vi.fn();

    createHttpFaultMiddleware(store, logger())(req, res.response, next);

    expect(vi.getTimerCount()).toBe(0);
    expect(req.listenerCount("aborted")).toBe(0);
    expect(res.response.listenerCount("close")).toBe(0);
    vi.advanceTimersByTime(100);
    expect(next).not.toHaveBeenCalled();
    expect(store.get()).toMatchObject({
      scenario: "NORMAL",
      lastCompleted: { scenario: "AUTH_TIMEOUT", triggeredCount: 1 },
    });
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
