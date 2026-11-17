import { createHash } from "node:crypto";
import type { JWTPayload } from "jose";
import type { OidcClientConfig } from "../clients/types.js";
import type { AppConfig } from "../config.js";
import type { ApiResourceConfig } from "../resources/types.js";
import type { FaultDecision } from "../scenario/types.js";
import type { MockUser } from "../users/types.js";
import { v1TokenValidationPaths } from "./access-token-version.js";

/** Independent of signing keys, stable for the same tenant/user/recipient. */
export function pairwiseSubject(tenant: string, user: MockUser, recipient: string): string {
  return createHash("sha256")
    .update(JSON.stringify([tenant, user.oid, recipient]))
    .digest("base64url");
}
export function sessionGuid(uid: string): string {
  const hash = createHash("sha256").update(uid).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export function userClaims(
  user: MockUser,
  tenantId: string,
  decision: FaultDecision | null | undefined,
  includeEmail: boolean,
  recipient = "",
  includeProfile = true,
  includeGroups = true,
): JWTPayload {
  const claims: JWTPayload = { sub: pairwiseSubject(tenantId, user, recipient), tid: tenantId };
  if (includeProfile)
    Object.assign(claims, { oid: user.oid, name: user.name, preferred_username: user.preferred_username });
  if (includeEmail && user.mail) claims.email = user.mail;
  if (includeGroups && user.groups.length && decision?.scenario !== "NO_GROUPS") {
    if (user.groups.length <= 200) claims.groups = [...user.groups];
    else {
      claims._claim_names = { groups: "src1" };
      claims._claim_sources = {
        src1: { endpoint: `https://graph.microsoft.com/v1.0/users/${user.oid}/getMemberObjects` },
      };
    }
  }
  return claims;
}
export function applyAccessTokenClaims(
  payload: JWTPayload,
  config: AppConfig,
  client: OidcClientConfig,
  resource: ApiResourceConfig,
  scopes: string[],
  user: MockUser,
  decision: FaultDecision | null | undefined,
  sid?: string,
  includeProfile = true,
  resourceIdentifier = resource.identifierUri,
): void {
  const v1 = resource.requestedAccessTokenVersion !== 2;
  Object.assign(
    payload,
    userClaims(
      user,
      config.tenantId,
      decision,
      resource.emailOptionalClaim,
      resource.resourceAppId,
      includeProfile,
      resource.groupMembershipClaims === "SecurityGroup",
    ),
  );
  delete payload.scope;
  payload.ver = v1 ? "1.0" : "2.0";
  payload.iss = v1 ? `${config.issuerOrigin}${v1TokenValidationPaths(config.issuerPath).issuerPath}` : config.issuer;
  payload.aud = v1 ? resourceIdentifier : resource.resourceAppId;
  if (v1) {
    if (includeProfile) payload.unique_name = user.preferred_username;
    delete payload.preferred_username;
  }
  payload[v1 ? "appid" : "azp"] = client.clientId;
  payload[v1 ? "appidacr" : "azpacr"] = client.tokenEndpointAuthMethod === "none" ? "0" : "1";
  payload.scp = scopes.join(" ");
  if (sid) payload.sid = sid;
  if (typeof payload.iat === "number") payload.nbf = payload.iat;
}
