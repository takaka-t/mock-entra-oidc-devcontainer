import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  classifyAccessLogEndpoint,
  createAccessLogMiddleware,
  resolveAccessLogEndpoints,
  type AccessLogEndpointTable,
} from "../../src/access-log/middleware.js";
import { InMemoryAccessLog } from "../../src/access-log/store.js";
import {
  mockAuthorizePath,
  mockCommonAuthorizePath,
  mockIssuerPath,
  mockJwksPath,
  mockLogoutPath,
  mockTokenPath,
} from "../../src/config.js";
import { InMemoryScenarioStore } from "../../src/scenario/store.js";

const table: AccessLogEndpointTable = resolveAccessLogEndpoints({
  issuerPath: mockIssuerPath,
  authorizePath: mockAuthorizePath,
  tokenPath: mockTokenPath,
  jwksPath: mockJwksPath,
  logoutPath: mockLogoutPath,
  commonAuthorizePath: mockCommonAuthorizePath,
});

function request(method: string, url: string): IncomingMessage {
  return Object.assign(new EventEmitter(), { method, url }) as IncomingMessage;
}

interface ResponseHarness {
  response: ServerResponse;
  finish(statusCode: number): void;
  abort(): void;
}

function response(): ResponseHarness {
  const target = Object.assign(new EventEmitter(), {
    statusCode: 200,
    writableFinished: false,
  });
  return {
    response: target as unknown as ServerResponse,
    finish(statusCode) {
      target.statusCode = statusCode;
      target.writableFinished = true;
      target.emit("finish");
      target.emit("close");
    },
    abort() {
      target.emit("close");
    },
  };
}

function harness(store = new InMemoryScenarioStore()) {
  const accessLog = new InMemoryAccessLog();
  return {
    store,
    accessLog,
    middleware: createAccessLogMiddleware(accessLog, store, table),
  };
}

describe("classifyAccessLogEndpoint", () => {
  it.each([
    ["GET", `${mockIssuerPath}/.well-known/openid-configuration`, "discovery"],
    ["GET", `${mockIssuerPath}/.well-known/openid-configuration/`, "discovery"],
    ["GET", mockAuthorizePath, "authorization"],
    ["GET", `${mockAuthorizePath}/abc123`, "authorization"],
    ["GET", `${mockIssuerPath}/interaction/abc123`, "interaction"],
    ["POST", `${mockIssuerPath}/interaction/abc123`, "interaction"],
    ["POST", mockTokenPath, "token"],
    ["POST", `${mockTokenPath}/`, "token"],
    ["OPTIONS", mockTokenPath, "token"],
    ["GET", mockJwksPath, "jwks"],
    ["GET", mockLogoutPath, "logout"],
    ["POST", `${mockLogoutPath}/confirm`, "logout"],
    ["GET", `${mockLogoutPath}/success`, "logout"],
    ["HEAD", mockCommonAuthorizePath, "connectivity-probe"],
    ["HEAD", `${mockCommonAuthorizePath}/`, "connectivity-probe"],
    ["HEAD", "/common/oauth2/v2%2E0/authorize", "connectivity-probe"],
    // Only HEAD is the probe; a sign-in attempt through the common alias is not.
    ["GET", mockCommonAuthorizePath, "other"],
    ["POST", mockCommonAuthorizePath, "other"],
    ["GET", "/common/v2.0/.well-known/openid-configuration", "other"],
    ["POST", "/common/oauth2/v2.0/token", "other"],
    ["GET", `${mockIssuerPath}/authorize`, "other"],
    ["POST", `${mockTokenPath}extra`, "other"],
    ["GET", "/organizations/oauth2/v2.0/authorize", "other"],
  ])("classifies %s %s as %s", (method, pathname, endpoint) => {
    expect(classifyAccessLogEndpoint(method, pathname, table)).toBe(endpoint);
  });
});

describe("createAccessLogMiddleware", () => {
  it("records a delivered response with its status and endpoint", () => {
    const { accessLog, middleware } = harness();
    const next = vi.fn();
    const res = response();
    middleware(request("post", `${mockTokenPath}?grant_type=x`), res.response, next);
    expect(next).toHaveBeenCalledOnce();
    expect(accessLog.list()).toEqual([]);
    res.finish(500);
    expect(accessLog.list()).toMatchObject([
      {
        id: 1,
        method: "POST",
        path: mockTokenPath,
        endpoint: "token",
        statusCode: 500,
        scenario: "NORMAL",
        fault: null,
      },
    ]);
    const [entry] = accessLog.list();
    expect(entry?.durationMs).toBeGreaterThanOrEqual(0);
    expect(() => new Date(entry!.receivedAt).toISOString()).not.toThrow();
  });

  it("numbers entries by arrival even when a slow request settles last", () => {
    const { accessLog, middleware } = harness();
    const slow = response();
    middleware(request("POST", mockTokenPath), slow.response, vi.fn());
    const quick = response();
    middleware(request("GET", mockJwksPath), quick.response, vi.fn());
    quick.finish(200);
    slow.finish(200);
    expect(accessLog.list().map((entry) => [entry.id, entry.endpoint])).toEqual([
      [2, "jwks"],
      [1, "token"],
    ]);
  });

  it("records a client disconnect before the response as a null status", () => {
    const { accessLog, middleware } = harness();
    const res = response();
    middleware(request("GET", mockJwksPath), res.response, vi.fn());
    res.abort();
    expect(accessLog.list()).toMatchObject([{ endpoint: "jwks", statusCode: null }]);
  });

  it("records each request exactly once even when close follows finish", () => {
    const { accessLog, middleware } = harness();
    const res = response();
    middleware(request("GET", mockJwksPath), res.response, vi.fn());
    res.finish(200);
    res.abort();
    expect(accessLog.list()).toHaveLength(1);
    expect(accessLog.list()[0]?.statusCode).toBe(200);
  });

  it.each([
    "/__mock",
    "/__mock/api/scenario",
    "/__mock/api/access-log",
    "/health",
    "/%5F%5Fmock/api/scenario",
    "/favicon.ico",
    "/favicon.ico?v=2",
  ])("does not record the management or browser chrome path %s", (url) => {
    const { accessLog, middleware } = harness();
    const next = vi.fn();
    const res = response();
    middleware(request("GET", url), res.response, next);
    res.finish(200);
    expect(next).toHaveBeenCalledOnce();
    expect(accessLog.list()).toEqual([]);
  });

  it("snapshots the armed scenario and links the consumed fault", () => {
    const store = new InMemoryScenarioStore();
    store.set({ scenario: "TOKEN_500", mode: "LIMITED", failureCount: 1 });
    const { accessLog, middleware } = harness(store);
    const req = request("POST", mockTokenPath);
    const res = response();
    middleware(req, res.response, vi.fn());
    const decision = store.consumeForRequest("token", store.startRequest(req));
    expect(decision?.scenario).toBe("TOKEN_500");
    res.finish(500);

    const untouched = request("GET", mockJwksPath);
    const untouchedRes = response();
    middleware(untouched, untouchedRes.response, vi.fn());
    untouchedRes.finish(200);

    expect(accessLog.list()).toMatchObject([
      { endpoint: "jwks", scenario: "NORMAL", fault: null },
      {
        endpoint: "token",
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
  });

  it("marks a request that did not consume the armed scenario as not applied", () => {
    const store = new InMemoryScenarioStore();
    store.set({ scenario: "TOKEN_500", mode: "CONTINUOUS" });
    const { accessLog, middleware } = harness(store);
    const req = request("GET", mockJwksPath);
    const res = response();
    middleware(req, res.response, vi.fn());
    expect(store.consumeForRequest("jwks", store.startRequest(req))).toBeNull();
    res.finish(200);
    expect(accessLog.list()).toMatchObject([{ scenario: "TOKEN_500", fault: null }]);
  });
});
