import formbody from "@fastify/formbody";
import middie from "@fastify/middie";
import Fastify, { type FastifyInstance } from "fastify";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerOptions as HttpsServerOptions } from "node:https";
import type { AppConfig } from "./config.js";
import { OidcClientStore } from "./clients/store.js";
import { registerRoutes } from "./admin/routes.js";
import { createHttpFaultMiddleware } from "./faults/http-fault.js";
import { decodeRoutingPath, rawPathname, routedPathname } from "./http-path.js";
import { loadSigningKeys } from "./oidc/keys.js";
import { SigningKeyRolloverState } from "./oidc/key-rollover.js";
import {
  applyProviderClient,
  createProvider,
  removeProviderClient,
  validateProviderClient,
} from "./oidc/provider.js";
import { oidcInternalRoutes } from "./oidc/routes.js";
import { resolveHttpFaultEndpoints } from "./scenario/registry.js";
import { InMemoryScenarioStore } from "./scenario/store.js";

export interface AppContext {
  app: FastifyInstance;
  store: InMemoryScenarioStore;
  clientStore: OidcClientStore;
}

export interface BuildAppOptions {
  /** Use false only for in-process tests that do not open a network listener. */
  https: HttpsServerOptions | false;
}

function managementPath(pathname: string): boolean {
  return pathname === "/health" || adminPath(pathname);
}

function adminPath(pathname: string): boolean {
  return pathname === "/__mock" || pathname.startsWith("/__mock/");
}

/**
 * authorize/token/jwks used to be mounted directly below issuerPath
 * (`{issuerPath}/authorize`, etc.). Now that their Entra-compliant homes are
 * sibling paths (see oidcMounts below), a request for one of those legacy
 * relative paths must not silently keep resolving to the same internal
 * route — otherwise the non-compliant shape this change was meant to retire
 * would still work.
 */
const legacyOidcRouteNames: readonly string[] =
  Object.values(oidcInternalRoutes);

function isLegacyOidcRoutePath(remainder: string): boolean {
  return legacyOidcRouteNames.some(
    (route) => remainder === route || remainder.startsWith(`${route}/`),
  );
}

function issuerScopedPath(pathname: string, issuerPath: string): boolean {
  const remainder = issuerPath
    ? pathname === issuerPath
      ? ""
      : pathname.startsWith(`${issuerPath}/`)
        ? pathname.slice(issuerPath.length)
        : null
    : pathname;
  if (remainder === null) return false;
  return !isLegacyOidcRoutePath(remainder);
}

interface OidcMount {
  readonly external: string;
  readonly internal: string;
}

/**
 * authorize/token/jwks/logout are Entra-compliant sibling paths of
 * issuerPath (not nested under it), so each needs its own
 * external-to-internal mapping. authorize and logout additionally accept
 * sub-paths because oidc-provider registers internal resume/confirmation
 * routes below them (`/authorize/:uid` for the interaction-complete and
 * authorization fault flows; `/session/end/confirm` and `/session/end/success`
 * for RP-initiated logout).
 */
function oidcMounts(config: AppConfig): readonly OidcMount[] {
  return [
    {
      external: config.authorizePath,
      internal: oidcInternalRoutes.authorization,
    },
    { external: config.tokenPath, internal: oidcInternalRoutes.token },
    { external: config.jwksPath, internal: oidcInternalRoutes.jwks },
    { external: config.logoutPath, internal: oidcInternalRoutes.end_session },
  ];
}

function matchOidcMount(pathname: string, config: AppConfig): OidcMount | null {
  for (const mount of oidcMounts(config)) {
    if (
      pathname === mount.external ||
      pathname.startsWith(`${mount.external}/`)
    )
      return mount;
  }
  return null;
}

function oidcPath(pathname: string, config: AppConfig): boolean {
  return (
    matchOidcMount(pathname, config) !== null ||
    issuerScopedPath(pathname, config.issuerPath)
  );
}

function interactionPath(pathname: string, issuerPath: string): boolean {
  return pathname.startsWith(`${issuerPath}/interaction/`);
}

function interactionRequestPath(
  pathname: string,
  routedPath: string,
  issuerPath: string,
  routedIssuerPath: string,
): boolean {
  return (
    interactionPath(pathname, issuerPath) ||
    interactionPath(routedPath, routedIssuerPath)
  );
}

const forbiddenAuthorityCharacters = new Set(["@", "/", "\\", "?", "#", ","]);

type OriginHeaderName = "host" | "x-forwarded-host" | "x-forwarded-proto";

function singleHeaderValue(
  request: IncomingMessage,
  name: OriginHeaderName,
): string | null | undefined {
  let occurrences = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() !== name) continue;
    occurrences++;
    if (occurrences > 1) return null;
  }
  const value = request.headers[name];
  return Array.isArray(value) ? null : value;
}

function authorityHeader(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const authority = value.trim();
  if (!authority) return null;
  if (
    [...authority].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint === undefined ||
        codePoint <= 0x20 ||
        codePoint === 0x7f ||
        forbiddenAuthorityCharacters.has(character)
      );
    })
  )
    return null;
  try {
    const parsed = new URL(`http://${authority}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    )
      return null;
  } catch {
    return null;
  }
  return authority;
}

function protocolHeader(
  value: string | null | undefined,
): "http" | "https" | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const protocol = value.trim().toLowerCase();
  return protocol === "http" || protocol === "https" ? protocol : null;
}

function requestOrigin(
  request: IncomingMessage,
  trustProxy: boolean,
): string | null {
  const directHost = authorityHeader(singleHeaderValue(request, "host"));
  if (directHost === null) return null;
  const forwardedHost = trustProxy
    ? authorityHeader(singleHeaderValue(request, "x-forwarded-host"))
    : undefined;
  if (forwardedHost === null) return null;
  const host = forwardedHost ?? directHost;
  const forwardedProtocol = trustProxy
    ? protocolHeader(singleHeaderValue(request, "x-forwarded-proto"))
    : undefined;
  if (forwardedProtocol === null) return null;
  const protocol =
    forwardedProtocol ??
    ((request.socket as { encrypted?: boolean }).encrypted ? "https" : "http");
  if (!host) return null;
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return null;
  }
}

function sendOriginError(response: ServerResponse): void {
  response.statusCode = 400;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(
    JSON.stringify({
      error: "invalid_request_origin",
      error_description: "Request origin does not match the configured issuer",
    }),
  );
}

function setSensitiveResponseHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "frame-ancestors 'none'");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("OIDC middleware failed");
}

export async function buildApp(
  config: AppConfig,
  options: BuildAppOptions,
): Promise<AppContext> {
  const commonOptions = {
    logger: config.logger,
    trustProxy: config.trustProxy,
  };
  const app: FastifyInstance = options.https
    ? Fastify({ ...commonOptions, https: options.https })
    : Fastify(commonOptions);
  const rolloverState = new SigningKeyRolloverState();
  const store = new InMemoryScenarioStore({
    onActivate: (scenario) => {
      if (scenario === "SIGNING_KEY_ROLLOVER") rolloverState.publish();
    },
    onReset: () => rolloverState.reset(),
  });
  const keys = await loadSigningKeys(config.keyDirectory);
  const provider = createProvider(config, store, keys, rolloverState, app.log);
  const clientStore = new OidcClientStore(
    config.clientConfigFile,
    (client) => applyProviderClient(provider, client),
    (clientId) => removeProviderClient(provider, clientId),
    (client) => validateProviderClient(provider, client),
  );
  await clientStore.initialize();
  const providerHandler = provider.callback();
  const routedIssuerPath = decodeRoutingPath(config.issuerPath);
  await app.register(middie);
  await app.register(formbody);
  app.use((request, response, next) => {
    const url = request.url ?? "/";
    const pathname = rawPathname(url);
    const routedPath = routedPathname(url);
    const isAdmin = adminPath(routedPath);
    const isOidc = !managementPath(routedPath) && oidcPath(pathname, config);
    const isInteraction = interactionRequestPath(
      pathname,
      routedPath,
      config.issuerPath,
      routedIssuerPath,
    );
    if (isAdmin || isInteraction) setSensitiveResponseHeaders(response);
    if (!isAdmin && !isOidc && !isInteraction) return next();
    if (requestOrigin(request, config.trustProxy) !== config.issuerOrigin) {
      sendOriginError(response);
      return;
    }
    next();
  });
  app.use(
    createHttpFaultMiddleware(
      store,
      app.log,
      resolveHttpFaultEndpoints(config),
    ),
  );
  app.use((req, res, next) => {
    const url = req.url ?? "/";
    const pathname = rawPathname(url);
    const routedPath = routedPathname(url);
    const isOidc = !managementPath(routedPath) && oidcPath(pathname, config);
    const isInteraction = interactionRequestPath(
      pathname,
      routedPath,
      config.issuerPath,
      routedIssuerPath,
    );
    if (!isOidc || isInteraction) return next();
    const originalUrl = req.url ?? "/";
    const mount = matchOidcMount(pathname, config);
    let mountedUrl: string;
    if (mount) {
      mountedUrl = `${mount.internal}${originalUrl.slice(mount.external.length)}`;
    } else {
      const stripped = config.issuerPath
        ? originalUrl.slice(config.issuerPath.length)
        : originalUrl;
      mountedUrl =
        !stripped || stripped.startsWith("?") ? `/${stripped}` : stripped;
    }
    (req as IncomingMessage & { originalUrl?: string }).originalUrl =
      originalUrl;
    req.url = mountedUrl;
    try {
      const result: unknown = providerHandler(req, res);
      if (
        typeof result === "object" &&
        result !== null &&
        "then" in result &&
        typeof result.then === "function"
      )
        void Promise.resolve(result).catch((error: unknown) =>
          next(asError(error)),
        );
    } catch (error) {
      next(asError(error));
    }
  });
  await registerRoutes(app, provider, store, clientStore, config);
  return { app, store, clientStore };
}
