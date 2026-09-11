import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyBaseLogger } from "fastify";
import {
  defaultDelayMs,
  defaultRetryAfterSeconds,
  defaultTokenError,
  scenarios,
  type HttpFaultEndpoint,
  type HttpFaultRouteTable,
} from "../scenario/registry.js";
import type { InMemoryScenarioStore } from "../scenario/store.js";
import {
  commonProbeContentType,
  matchesCommonProbePath,
} from "../oidc/common-probe.js";

function matchesPath(pathname: string, routePathname: string): boolean {
  return pathname === routePathname || pathname === `${routePathname}/`;
}

function endpointFor(
  method: string | undefined,
  pathname: string,
  routes: HttpFaultRouteTable,
): HttpFaultEndpoint | null {
  const normalizedMethod = method?.toUpperCase();
  return (
    (
      Object.entries(routes) as Array<
        [HttpFaultEndpoint, HttpFaultRouteTable[HttpFaultEndpoint]]
      >
    ).find(
      ([, route]) =>
        matchesPath(pathname, route.pathname) &&
        route.method === normalizedMethod,
    )?.[0] ?? null
  );
}

/**
 * CORS and preflight cover a wider set of paths than fault injection: the
 * tenant Authorization endpoint keeps its browser-facing behavior even though
 * its HTTP faults moved to the `common` connectivity probe.
 */
function isCorsPath(
  pathname: string,
  corsPathnames: readonly string[],
): boolean {
  return corsPathnames.some((corsPathname) =>
    matchesPath(pathname, corsPathname),
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

/**
 * `routes` and `corsPathnames` are required: the fault-injection paths depend
 * on the configured issuer (see resolveHttpFaultEndpoints), so there is no
 * route table that is correct by default.
 */
export function createHttpFaultMiddleware(
  store: InMemoryScenarioStore,
  logger: FastifyBaseLogger,
  routes: HttpFaultRouteTable,
  corsPathnames: readonly string[],
) {
  return (
    req: IncomingMessage,
    res: ServerResponse,
    next: (error?: Error) => void,
  ): void => {
    try {
      const ticket = store.startRequest(req);
      const rawPathname = new URL(req.url ?? "/", "http://local").pathname;
      const probePath = routes["authorization-http"].pathname;
      const pathname = matchesCommonProbePath(rawPathname, probePath)
        ? probePath
        : rawPathname;

      if (!isCorsPath(pathname, corsPathnames)) {
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

      const endpoint = endpointFor(req.method, pathname, routes);
      if (!endpoint) {
        safelyNext(next);
        return;
      }

      const decision = store.consumeForRequest(endpoint, ticket);
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

      /**
       * The `common` connectivity probe is a HEAD request, which cannot carry a
       * body, so its faults are status and headers only and reuse the healthy
       * probe's content type.
       */
      const bodyless = req.method?.toUpperCase() === "HEAD";
      setNoStoreHeaders(res);
      res.setHeader(
        "content-type",
        bodyless ? commonProbeContentType : "application/json; charset=utf-8",
      );
      const respond = (statusCode: number, body: object): void => {
        res.statusCode = statusCode;
        res.end(bodyless ? undefined : JSON.stringify(body));
      };

      switch (effect) {
        case "http-400":
          respond(400, {
            error: decision.parameters.error ?? defaultTokenError,
            ...(decision.parameters.errorDescription
              ? { error_description: decision.parameters.errorDescription }
              : {}),
          });
          return;
        case "http-429":
          setRetryAfterHeaders(
            res,
            decision.parameters.retryAfterSeconds ?? defaultRetryAfterSeconds,
          );
          respond(429, {
            error: "temporarily_unavailable",
            error_description: `Injected ${decision.scenario} fault`,
          });
          return;
        case "http-500":
          if (decision.parameters.retryAfterSeconds !== undefined) {
            setRetryAfterHeaders(res, decision.parameters.retryAfterSeconds);
          }
          respond(500, {
            error: "server_error",
            error_description: `Injected ${decision.scenario} fault`,
          });
          return;
        case "jwks-invalid":
          respond(200, { keys: [{ kty: "RSA", kid: "mock-invalid-jwk" }] });
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
