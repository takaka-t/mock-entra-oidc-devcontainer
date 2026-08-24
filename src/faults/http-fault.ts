import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyBaseLogger } from "fastify";
import {
  defaultDelayMs,
  defaultRetryAfterSeconds,
  defaultTokenError,
  httpFaultEndpoints,
  scenarios,
} from "../scenario/registry.js";
import type { InMemoryScenarioStore } from "../scenario/store.js";
import type { FaultEndpoint } from "../scenario/types.js";

type HttpFaultEndpoint = Extract<
  FaultEndpoint,
  "authorization-http" | "token" | "jwks" | "discovery"
>;

const endpointEntries = Object.entries(httpFaultEndpoints) as Array<
  [HttpFaultEndpoint, (typeof httpFaultEndpoints)[HttpFaultEndpoint]]
>;

function externalPath(pathname: string, issuerPath: string): string {
  return `${issuerPath}${pathname}`;
}

function matchesExternalPath(
  pathname: string,
  routePathname: string,
  issuerPath: string,
): boolean {
  const canonicalPath = externalPath(routePathname, issuerPath);
  return pathname === canonicalPath || pathname === `${canonicalPath}/`;
}

function endpointFor(
  method: string | undefined,
  pathname: string,
  issuerPath: string,
): HttpFaultEndpoint | null {
  const normalizedMethod = method?.toUpperCase();
  return (
    endpointEntries.find(
      ([, route]) =>
        matchesExternalPath(pathname, route.pathname, issuerPath) &&
        route.method === normalizedMethod,
    )?.[0] ?? null
  );
}

function isKnownPath(pathname: string, issuerPath: string): boolean {
  return endpointEntries.some(([, route]) =>
    matchesExternalPath(pathname, route.pathname, issuerPath),
  );
}

function setCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  res.setHeader("access-control-allow-origin", origin ?? "*");
  if (origin) {
    const current = res.getHeader("vary");
    const values = String(current ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!values.some((value) => value.toLowerCase() === "origin"))
      values.push("Origin");
    res.setHeader("vary", values.join(", "));
  }
  res.setHeader("access-control-allow-methods", "GET, HEAD, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization, content-type");
}

function setNoStoreHeaders(res: ServerResponse): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader("pragma", "no-cache");
}

function setRetryAfterHeaders(
  res: ServerResponse,
  retryAfterSeconds: number,
): void {
  res.setHeader("retry-after", String(retryAfterSeconds));
  const current = res.getHeader("access-control-expose-headers");
  const values = String(current ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.some((value) => value.toLowerCase() === "retry-after"))
    values.push("Retry-After");
  res.setHeader("access-control-expose-headers", values.join(", "));
}

function responseUnavailable(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  return req.destroyed || res.destroyed || res.writableEnded;
}

function safelyNext(next: (error?: Error) => void, error?: unknown): void {
  if (error === undefined) {
    next();
    return;
  }
  next(
    error instanceof Error
      ? error
      : new Error("Unknown HTTP fault middleware error"),
  );
}

function delayThenContinue(
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: Error) => void,
  delayMs: number,
): void {
  let settled = false;

  const removeListeners = (): void => {
    req.off("aborted", cancel);
    res.off("close", cancel);
  };
  const cancel = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    removeListeners();
  };
  const resume = (): void => {
    if (settled) return;
    settled = true;
    removeListeners();
    if (responseUnavailable(req, res)) return;
    try {
      safelyNext(next);
    } catch (error) {
      safelyNext(next, error);
    }
  };

  const timer = setTimeout(resume, delayMs);
  timer.unref?.();
  req.once("aborted", cancel);
  res.once("close", cancel);
  if (responseUnavailable(req, res)) cancel();
}

export function createHttpFaultMiddleware(
  store: InMemoryScenarioStore,
  logger: FastifyBaseLogger,
  issuerPath = "",
) {
  return (
    req: IncomingMessage,
    res: ServerResponse,
    next: (error?: Error) => void,
  ): void => {
    try {
      const ticket = store.startRequest(req);
      const pathname = new URL(req.url ?? "/", "http://local").pathname;

      if (!isKnownPath(pathname, issuerPath)) {
        safelyNext(next);
        return;
      }

      setCorsHeaders(req, res);
      if (req.method?.toUpperCase() === "OPTIONS") {
        setNoStoreHeaders(res);
        res.statusCode = 204;
        res.end();
        return;
      }

      const endpoint = endpointFor(req.method, pathname, issuerPath);
      if (!endpoint) {
        safelyNext(next);
        return;
      }

      const decision = store.consume(endpoint, ticket);
      if (!decision) {
        safelyNext(next);
        return;
      }

      logger.warn(
        {
          scenario: decision.scenario,
          endpoint,
          mode: decision.mode,
          faultInjected: true,
          remainingBefore: decision.remainingBefore,
          remainingAfter: decision.remainingAfter,
        },
        "[MOCK-IDP] fault injected",
      );

      const effect = scenarios[decision.scenario].effect;
      if (effect === "http-timeout") {
        delayThenContinue(
          req,
          res,
          next,
          decision.parameters.delayMs ?? defaultDelayMs,
        );
        return;
      }

      setNoStoreHeaders(res);
      res.setHeader("content-type", "application/json; charset=utf-8");
      switch (effect) {
        case "http-400":
          res.statusCode = 400;
          res.end(
            JSON.stringify({
              error: decision.parameters.error ?? defaultTokenError,
              ...(decision.parameters.errorDescription
                ? { error_description: decision.parameters.errorDescription }
                : {}),
            }),
          );
          return;
        case "http-429":
          setRetryAfterHeaders(
            res,
            decision.parameters.retryAfterSeconds ?? defaultRetryAfterSeconds,
          );
          res.statusCode = 429;
          res.end(
            JSON.stringify({
              error: "temporarily_unavailable",
              error_description: `Injected ${decision.scenario} fault`,
            }),
          );
          return;
        case "http-500":
          if (decision.parameters.retryAfterSeconds !== undefined) {
            setRetryAfterHeaders(res, decision.parameters.retryAfterSeconds);
          }
          res.statusCode = 500;
          res.end(
            JSON.stringify({
              error: "server_error",
              error_description: `Injected ${decision.scenario} fault`,
            }),
          );
          return;
        case "jwks-invalid":
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              keys: [{ kty: "RSA", kid: "mock-invalid-jwk" }],
            }),
          );
          return;
        default:
          throw new Error(
            `Unexpected HTTP fault effect for ${decision.scenario}: ${effect}`,
          );
      }
    } catch (error) {
      safelyNext(next, error);
    }
  };
}
