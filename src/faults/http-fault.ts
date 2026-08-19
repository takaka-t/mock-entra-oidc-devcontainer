import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyBaseLogger } from "fastify";
import {
  defaultDelayMs,
  defaultTokenError,
  httpFaultEndpoints,
  scenarios,
} from "../scenario/registry.js";
import type { InMemoryScenarioStore } from "../scenario/store.js";
import type { FaultEndpoint } from "../scenario/types.js";

type HttpFaultEndpoint = Extract<FaultEndpoint, "token" | "jwks" | "discovery">;

const endpointEntries = Object.entries(httpFaultEndpoints) as Array<
  [HttpFaultEndpoint, (typeof httpFaultEndpoints)[HttpFaultEndpoint]]
>;

function externalPath(pathname: string, issuerPath: string): string {
  return `${issuerPath}${pathname}`;
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
        externalPath(route.pathname, issuerPath) === pathname &&
        route.method === normalizedMethod,
    )?.[0] ?? null
  );
}

function isKnownPath(pathname: string, issuerPath: string): boolean {
  return endpointEntries.some(
    ([, route]) => externalPath(route.pathname, issuerPath) === pathname,
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
        const timer = setTimeout(() => {
          if (responseUnavailable(req, res)) return;
          try {
            safelyNext(next);
          } catch (error) {
            safelyNext(next, error);
          }
        }, decision.parameters.delayMs ?? defaultDelayMs);
        timer.unref?.();
        return;
      }

      setNoStoreHeaders(res);
      res.setHeader("content-type", "application/json; charset=utf-8");
      if (effect === "http-400") {
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
      }

      res.statusCode = 500;
      res.end(
        JSON.stringify({
          error: "server_error",
          error_description: `Injected ${decision.scenario} fault`,
        }),
      );
    } catch (error) {
      safelyNext(next, error);
    }
  };
}
