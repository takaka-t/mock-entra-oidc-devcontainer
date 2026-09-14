import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../config.js";
import { managementPath, rawPathname, routedPathname } from "../http-path.js";
import { matchesCommonProbePath } from "../oidc/common-probe.js";
import type { InMemoryScenarioStore } from "../scenario/store.js";
import type { InMemoryAccessLog } from "./store.js";
import type { AccessLogEndpoint } from "./types.js";

export interface AccessLogEndpointTable {
  discovery: string;
  authorization: string;
  interaction: string;
  token: string;
  jwks: string;
  logout: string;
  "connectivity-probe": string;
}

/**
 * Mirrors resolveHttpFaultEndpoints: authorize/token/jwks/logout are sibling
 * paths of issuerPath rather than nested under it, so each is taken from the
 * server's actual absolute path instead of derived from one shared prefix.
 */
export function resolveAccessLogEndpoints(
  config: Pick<
    AppConfig,
    "issuerPath" | "authorizePath" | "tokenPath" | "jwksPath" | "logoutPath" | "commonAuthorizePath"
  >,
): AccessLogEndpointTable {
  return {
    discovery: `${config.issuerPath}/.well-known/openid-configuration`,
    authorization: config.authorizePath,
    interaction: `${config.issuerPath}/interaction`,
    token: config.tokenPath,
    jwks: config.jwksPath,
    logout: config.logoutPath,
    "connectivity-probe": config.commonAuthorizePath,
  };
}

/**
 * Browsers fetch the site icon on their own whenever one of the mock's HTML
 * pages (Admin UI, sign-in, logout) is opened. That is page chrome, not an
 * OIDC request made by the application under test, so it stays out of the
 * log just like the management paths.
 */
function browserChromePath(pathname: string): boolean {
  return pathname === "/favicon.ico";
}

function matchesExact(pathname: string, routePathname: string): boolean {
  return pathname === routePathname || pathname === `${routePathname}/`;
}

function matchesPrefix(pathname: string, routePathname: string): boolean {
  return pathname === routePathname || pathname.startsWith(`${routePathname}/`);
}

/**
 * Authorization, logout and the sign-in interaction accept sub-paths because
 * oidc-provider mounts resume/confirmation routes below them (`/authorize/:uid`,
 * `/logout/confirm`, `/interaction/:uid`), so those are prefix matches; the
 * rest tolerate one trailing slash, matching the fault middleware.
 *
 * The connectivity probe is `HEAD` only (every other method on that path is a
 * 404, see registerCommonProbeRoute), so a `GET` there is an application
 * trying to sign in through the unsupported `common` alias and is left as
 * `other` rather than mislabelled as a probe.
 */
export function classifyAccessLogEndpoint(
  method: string,
  pathname: string,
  table: AccessLogEndpointTable,
): AccessLogEndpoint {
  if (method === "HEAD" && matchesCommonProbePath(pathname, table["connectivity-probe"])) return "connectivity-probe";
  if (matchesExact(pathname, table.discovery)) return "discovery";
  if (matchesExact(pathname, table.token)) return "token";
  if (matchesExact(pathname, table.jwks)) return "jwks";
  if (matchesPrefix(pathname, table.authorization)) return "authorization";
  if (matchesPrefix(pathname, table.logout)) return "logout";
  if (matchesPrefix(pathname, table.interaction)) return "interaction";
  return "other";
}

/**
 * Records every non-management request once it settles. This is a raw
 * middleware listening on the response rather than a Fastify `onResponse`
 * hook for two reasons. `onResponse` only fires on `finish`, so a client that
 * gives up mid-request (typical for the timeout scenarios) would never be
 * recorded; here a `close` without a preceding `finish` is captured with a
 * null status. And by the time Fastify hooks run, the OIDC middleware in
 * app.ts has already rewritten `req.url` to oidc-provider's internal route
 * (`/jwks`, `/token`, ...), whereas this runs first and still sees the
 * external path the client actually requested.
 */
export function createAccessLogMiddleware(
  accessLog: InMemoryAccessLog,
  store: InMemoryScenarioStore,
  table: AccessLogEndpointTable,
) {
  return (req: IncomingMessage, res: ServerResponse, next: (error?: Error) => void): void => {
    const url = req.url ?? "/";
    const routedPath = routedPathname(url);
    if (managementPath(routedPath) || browserChromePath(routedPath)) {
      next();
      return;
    }
    const pathname = rawPathname(url);
    const id = accessLog.nextId();
    const receivedAt = new Date().toISOString();
    const startedAt = performance.now();
    const scenario = store.get().scenario;
    let settled = false;
    const settle = (statusCode: number | null): void => {
      if (settled) return;
      settled = true;
      res.off("finish", onFinish);
      res.off("close", onClose);
      const method = (req.method ?? "GET").toUpperCase();
      accessLog.record(
        {
          receivedAt,
          method,
          path: pathname,
          endpoint: classifyAccessLogEndpoint(method, pathname, table),
          statusCode,
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
          scenario,
          fault: store.getRequestDecision(req),
        },
        id,
      );
    };
    const onFinish = (): void => settle(res.statusCode);
    const onClose = (): void => settle(res.writableFinished ? res.statusCode : null);
    res.once("finish", onFinish);
    res.once("close", onClose);
    next();
  };
}
