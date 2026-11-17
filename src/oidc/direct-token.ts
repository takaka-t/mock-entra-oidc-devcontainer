import { randomUUID } from "node:crypto";
import { SignJWT, type JWTPayload } from "jose";
import type { OidcClientConfig } from "../clients/types.js";
import { mockTokenTtlSeconds, type AppConfig } from "../config.js";
import type { ApiResourceConfig } from "../resources/types.js";
import { mutateToken } from "../faults/token-generator.js";
import { scenarios } from "../scenario/registry.js";
import type { InMemoryScenarioStore } from "../scenario/store.js";
import type { FaultDecision, ScenarioRequestTicket } from "../scenario/types.js";
import type { MockUser } from "../users/types.js";
import { applyAccessTokenClaims } from "./claims.js";
import type { SigningKeys } from "./keys.js";
export interface DirectTokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
  fault: FaultDecision | null;
}
export async function signAccessToken(
  config: AppConfig,
  keys: SigningKeys,
  client: OidcClientConfig,
  resource: ApiResourceConfig,
  scopes: string[],
  user: MockUser,
  fault?: FaultDecision | null,
  sid?: string,
  includeProfile = true,
  resourceIdentifier = resource.identifierUri,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = { iat: now, exp: now + mockTokenTtlSeconds, jti: randomUUID() };
  applyAccessTokenClaims(
    payload,
    config,
    client,
    resource,
    scopes,
    user,
    fault,
    sid,
    includeProfile,
    resourceIdentifier,
  );
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: String(keys.normal.publicJwk.kid) })
    .sign(keys.normal.privateKey);
}
export async function issueAccessToken(
  config: AppConfig,
  keys: SigningKeys,
  store: InMemoryScenarioStore,
  client: OidcClientConfig,
  resource: ApiResourceConfig,
  scopes: string[],
  user: MockUser,
  ticket: ScenarioRequestTicket | undefined,
): Promise<DirectTokenResponse> {
  const claimFault =
    user.groups.length > 0 && resource.groupMembershipClaims === "SecurityGroup"
      ? store.consumeForRequest("claims", ticket)
      : null;
  const active = store.get().scenario;
  const jwtFault =
    active !== "NORMAL" &&
    scenarios[active].endpoint === "token-jwt" &&
    !["NONCE_MISSING", "NONCE_MISMATCH", "TOKEN_NO_ID_TOKEN"].includes(active)
      ? store.consumeForRequest("token-jwt", ticket)
      : null;
  let token = await signAccessToken(config, keys, client, resource, scopes, user, claimFault);
  if (jwtFault) token = await mutateToken(token, jwtFault, keys);
  return {
    access_token: token,
    token_type: "Bearer",
    expires_in: mockTokenTtlSeconds,
    scope: scopes.map((name) => `${resource.identifierUri}/${name}`).join(" "),
    fault: claimFault ?? jwtFault,
  };
}
