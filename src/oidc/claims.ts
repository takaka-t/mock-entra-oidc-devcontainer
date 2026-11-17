import type { JWTPayload } from "jose";
import type { OidcClientConfig } from "../clients/types.js";
import type { AppConfig } from "../config.js";
import type { FaultDecision } from "../scenario/types.js";
import type { MockUser } from "../users/types.js";
import { v1TokenValidationPaths } from "./access-token-version.js";

type UserClaims = Omit<MockUser, "groups" | "mail"> & {
  tid: string;
  groups?: string[];
  email?: string;
};

export function userClaims(
  user: MockUser,
  tenantId: string,
  decision: FaultDecision | null | undefined,
  includeEmail: boolean,
): UserClaims {
  const { mail, groups, ...rest } = user;
  const claims: UserClaims = {
    ...rest,
    tid: tenantId,
    ...(includeEmail ? { email: mail } : {}),
    groups: [...groups],
  };
  if (decision?.scenario === "NO_GROUPS") delete claims.groups;
  return claims;
}

type AccessTokenClient = Pick<OidcClientConfig, "clientId" | "accessTokenScope" | "accessTokenVersion"> & {
  tokenEndpointAuthMethod: string | undefined;
};

/** Shared by the provider's JWT customizer and the direct development issuer. */
export function applyAccessTokenClaims(
  payload: JWTPayload,
  config: AppConfig,
  client: AccessTokenClient | undefined,
  user: MockUser | undefined,
  includeEmail: boolean,
  decision: FaultDecision | null | undefined,
  sid?: string,
): void {
  delete payload.scope;
  if (user) Object.assign(payload, userClaims(user, config.tenantId, decision, includeEmail));
  const v1 = client?.accessTokenVersion === "1.0";
  payload.ver = v1 ? "1.0" : "2.0";
  if (v1) {
    payload.iss = `${config.issuerOrigin}${v1TokenValidationPaths(config.issuerPath).issuerPath}`;
    if (user) payload.unique_name = user.preferred_username;
    delete payload.preferred_username;
  }
  if (client) {
    payload[v1 ? "appid" : "azp"] = client.clientId;
    payload[v1 ? "appidacr" : "azpacr"] = client.tokenEndpointAuthMethod === "none" ? "0" : "1";
    if (client.accessTokenScope) payload.scp = client.accessTokenScope;
  }
  if (sid) payload.sid = sid;
  if (typeof payload.iat === "number") payload.nbf = payload.iat;
}
