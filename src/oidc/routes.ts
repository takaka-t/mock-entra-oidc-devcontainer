/**
 * oidc-provider mounts `.well-known/openid-configuration` at a fixed path it
 * does not expose via `routes`, so authorization/token/jwks must stay
 * relative to that same internal mount root. The Entra-compliant external
 * paths (sibling paths under the tenant, not nested under issuerPath) are
 * mapped onto these internal routes in app.ts.
 *
 * Any route that makes oidc-provider generate absolute URLs must be named
 * after the last segment of its external path. oidc-provider derives the
 * mount prefix by locating the rewritten `req.url` inside `req.originalUrl`
 * (`urlFor()` in oidc-provider's `helpers/oidc_context.js`); when the
 * internal name is not a suffix of the external path that lookup fails and
 * the prefix silently becomes empty, emitting tenant-less URLs.
 *
 * That is why end_session is `/logout` (matching the external
 * `{tenant}/oauth2/v2.0/logout`) instead of oidc-provider's `/session/end`
 * default: its confirmation form and success redirect would otherwise point
 * at origin-level paths this app does not route, so RP-initiated logout could
 * never complete. See test/logout.test.ts.
 *
 * jwks is the one route that does not follow the rule -- its external path
 * ends in `/keys` -- which is harmless only because it generates no URLs.
 */
export const oidcInternalRoutes = {
  authorization: "/authorize",
  token: "/token",
  jwks: "/jwks",
  end_session: "/logout",
} as const;

/**
 * Whether a path is a route's own path, i.e. the route itself or one of the
 * sub-paths oidc-provider mounts below it (`/authorize/:uid`,
 * `/logout/confirm`, `/logout/success`). Used for the internal route names
 * below and, in app.ts, for their external counterparts, which end in the
 * same segment and so have the same sub-path shape.
 */
export function matchesRouteOrSubPath(path: string, route: string): boolean {
  return path === route || path.startsWith(`${route}/`);
}

/**
 * Error responses on these routes are rendered for a browser; every other
 * internal route belongs to a machine client. See renderError in provider.ts.
 */
const browserFacingRoutes: readonly string[] = [oidcInternalRoutes.authorization, oidcInternalRoutes.end_session];

export function browserFacingRoutePath(path: string): boolean {
  return browserFacingRoutes.some((route) => matchesRouteOrSubPath(path, route));
}
