import { randomUUID } from "node:crypto";
import { SignJWT, type JWTPayload } from "jose";
import type { OidcClientConfig } from "../clients/types.js";
import { mockTokenTtlSeconds, type AppConfig } from "../config.js";
import { mutateToken, tokenResponseFaultApplies } from "../faults/token-generator.js";
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

export async function issueAccessToken(
  config: AppConfig,
  keys: SigningKeys,
  store: InMemoryScenarioStore,
  client: OidcClientConfig,
  user: MockUser,
  ticket: ScenarioRequestTicket | undefined,
): Promise<DirectTokenResponse> {
  // Decide before signing yields, using the same request/activation guard as OIDC.
  const claimFault = store.consumeForRequest("claims", ticket);
  const active = store.get().scenario;
  const jwtFault =
    active !== "NORMAL" && scenarios[active].endpoint === "token-jwt" && tokenResponseFaultApplies(active, {})
      ? store.consumeForRequest("token-jwt", ticket)
      : null;
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = {
    iss: config.issuer,
    aud: client.accessTokenAudience,
    sub: user.sub,
    iat: now,
    exp: now + mockTokenTtlSeconds,
    jti: randomUUID(),
  };
  applyAccessTokenClaims(payload, config, client, user, client.emailOptionalClaim, claimFault);
  let token = await new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: String(keys.normal.publicJwk.kid) })
    .sign(keys.normal.privateKey);
  if (jwtFault) token = await mutateToken(token, jwtFault, keys);
  return {
    access_token: token,
    token_type: "Bearer",
    expires_in: mockTokenTtlSeconds,
    scope: client.accessTokenScope,
    fault: claimFault ?? jwtFault,
  };
}
