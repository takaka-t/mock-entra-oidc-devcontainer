/**
 * The v1 issuer keeps Entra's tenant path and trailing slash, using the
 * mock's own origin instead of sts.windows.net. Root-mounted test providers
 * use /v1.0 so their v1 metadata cannot collide with the v2 discovery route.
 */
export function v1TokenValidationPaths(issuerPath: string) {
  const base = issuerPath.replace(/\/v2\.0$/, "") || "/v1.0";
  return {
    issuerPath: `${base}/`,
    discoveryPath: `${base}/.well-known/openid-configuration`,
    jwksPath: `${base}/discovery/keys`,
  };
}
