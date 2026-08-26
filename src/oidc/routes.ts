/**
 * oidc-provider mounts `.well-known/openid-configuration` at a fixed path it
 * does not expose via `routes`, so authorization/token/jwks must stay
 * relative to that same internal mount root. The Entra-compliant external
 * paths (sibling paths under the tenant, not nested under issuerPath) are
 * mapped onto these internal routes in app.ts.
 */
export const oidcInternalRoutes = {
  authorization: "/authorize",
  token: "/token",
  jwks: "/jwks",
  end_session: "/session/end",
} as const;
