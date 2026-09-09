import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppConfig } from "../config.js";

/**
 * Entra answers the `common` connectivity probe with an HTML content type even
 * though `HEAD` carries no body. Fault responses reuse the same value so a
 * client cannot tell a healthy probe from a failing one by content type alone.
 */
export const commonProbeContentType = "text/html; charset=utf-8";

/**
 * `HEAD {origin}/common/oauth2/v2.0/authorize` is the reachability probe client
 * libraries send before starting a sign-in. It is not part of the tenant OIDC
 * surface, so it is served here rather than by oidc-provider, and only `HEAD`
 * is registered: every other method stays a 404.
 *
 * The HTTP fault middleware runs ahead of this route, so AUTH_429 / AUTH_500 /
 * AUTH_TIMEOUT answer first and this handler is reached only when the probe is
 * healthy (AUTH_TIMEOUT reaches it after its delay).
 */
export function registerCommonProbeRoute(
  app: FastifyInstance,
  config: AppConfig,
): void {
  const handler = async (_request: unknown, reply: FastifyReply) =>
    reply
      .code(200)
      .type(commonProbeContentType)
      .header("cache-control", "no-store")
      .send();
  // The fault middleware treats one trailing slash as the same path, so both
  // spellings must exist here or a probe would 404 while healthy and 429 while
  // faulted.
  app.head(config.commonAuthorizePath, handler);
  app.head(`${config.commonAuthorizePath}/`, handler);
}
