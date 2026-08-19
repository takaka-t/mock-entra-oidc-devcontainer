import formbody from "@fastify/formbody";
import middie from "@fastify/middie";
import Fastify, { type FastifyInstance } from "fastify";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "./config.js";
import { registerRoutes } from "./admin/routes.js";
import { createHttpFaultMiddleware } from "./faults/http-fault.js";
import { loadSigningKeys } from "./oidc/keys.js";
import { createProvider } from "./oidc/provider.js";
import { InMemoryScenarioStore } from "./scenario/store.js";

export interface AppContext {
  app: FastifyInstance;
  store: InMemoryScenarioStore;
}

function managementPath(pathname: string): boolean {
  return (
    pathname === "/health" ||
    pathname === "/__mock" ||
    pathname === "/__mock/api/scenario" ||
    pathname === "/__mock/api/reset"
  );
}

function oidcPath(pathname: string, issuerPath: string): boolean {
  if (managementPath(pathname)) return false;
  if (!issuerPath) return true;
  return pathname === issuerPath || pathname.startsWith(`${issuerPath}/`);
}

function interactionPath(pathname: string, issuerPath: string): boolean {
  return pathname.startsWith(`${issuerPath}/interaction/`);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value?.split(",", 1)[0];
  return first?.trim() || undefined;
}

function requestOrigin(
  request: IncomingMessage,
  trustProxy: boolean,
): string | null {
  const host =
    (trustProxy
      ? firstHeader(request.headers["x-forwarded-host"])
      : undefined) ?? firstHeader(request.headers.host);
  const forwardedProtocol = trustProxy
    ? firstHeader(request.headers["x-forwarded-proto"])?.toLowerCase()
    : undefined;
  const protocol =
    forwardedProtocol ??
    ((request.socket as { encrypted?: boolean }).encrypted ? "https" : "http");
  if (!host || !["http", "https"].includes(protocol)) return null;
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
      error_description: "Request origin does not match OIDC_ISSUER",
    }),
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("OIDC middleware failed");
}

export async function buildApp(config: AppConfig): Promise<AppContext> {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    trustProxy: config.trustProxy,
  });
  const store = new InMemoryScenarioStore();
  const keys = await loadSigningKeys(config.keyDirectory);
  const provider = createProvider(config, store, keys, app.log);
  const providerHandler = provider.callback();
  await app.register(middie);
  await app.register(formbody);
  app.use((request, response, next) => {
    const pathname = new URL(request.url ?? "/", "http://local").pathname;
    if (!oidcPath(pathname, config.issuerPath)) return next();
    if (requestOrigin(request, config.trustProxy) !== config.issuerOrigin) {
      sendOriginError(response);
      return;
    }
    next();
  });
  app.use(createHttpFaultMiddleware(store, app.log, config.issuerPath));
  app.use((req, res, next) => {
    const pathname = new URL(req.url ?? "/", "http://local").pathname;
    if (
      !oidcPath(pathname, config.issuerPath) ||
      interactionPath(pathname, config.issuerPath)
    )
      return next();
    const originalUrl = req.url ?? "/";
    const mountedUrl = config.issuerPath
      ? originalUrl.slice(config.issuerPath.length)
      : originalUrl;
    (req as IncomingMessage & { originalUrl?: string }).originalUrl =
      originalUrl;
    req.url =
      !mountedUrl || mountedUrl.startsWith("?") ? `/${mountedUrl}` : mountedUrl;
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
  await registerRoutes(app, provider, store, config);
  return { app, store };
}
