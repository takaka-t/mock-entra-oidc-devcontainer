import { base64url, decodeJwt, decodeProtectedHeader, SignJWT } from "jose";
import { mockTokenTtlSeconds } from "../config.js";
import type { SigningKeys } from "../oidc/keys.js";
import type { FaultDecision, FaultScenarioName } from "../scenario/types.js";
import { defaultExpiredAgoSeconds, defaultMissingClaim, defaultNbfAheadSeconds } from "../scenario/registry.js";

export const mismatchedNonce = "mock-mismatched-nonce";
export const wrongTenantId = "ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb";

/** `nonce` exists only on the ID Token, so these leave the Access Token untouched. */
const idTokenOnlyScenarios: ReadonlySet<FaultScenarioName> = new Set(["NONCE_MISMATCH", "NONCE_MISSING"]);

/**
 * Whether the fault would actually change this Token response. A fault that
 * cannot (no `id_token` to drop, or no `nonce` because the Authorization
 * request sent none) must not consume a LIMITED count, or the RP would pass a
 * rejection test against an unmodified response.
 */
export function tokenResponseFaultApplies(scenario: FaultScenarioName, body: unknown): boolean {
  if (scenario !== "TOKEN_NO_ID_TOKEN" && !idTokenOnlyScenarios.has(scenario)) return true;
  if (!body || typeof body !== "object") return false;
  const idToken = (body as Record<string, unknown>).id_token;
  if (typeof idToken !== "string") return false;
  return scenario === "TOKEN_NO_ID_TOKEN" || decodeJwt(idToken).nonce !== undefined;
}

function unsignedJwt(header: Record<string, unknown>, payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) => base64url.encode(JSON.stringify(value));
  return `${encode(header)}.${encode(payload)}.`;
}

export async function mutateToken(token: string, decision: FaultDecision, keys: SigningKeys): Promise<string> {
  const payload = { ...decodeJwt(token) };
  const oldHeader = decodeProtectedHeader(token);
  const now = Math.floor(Date.now() / 1000);
  switch (decision.scenario) {
    case "WRONG_AUDIENCE":
      payload.aud = "unexpected-audience";
      break;
    case "WRONG_ISSUER":
      payload.iss = "https://wrong-issuer.invalid";
      break;
    case "EXPIRED_TOKEN": {
      const expiredAt = now - (decision.parameters.expiredAgoSeconds ?? defaultExpiredAgoSeconds);
      payload.iat = expiredAt - mockTokenTtlSeconds;
      payload.nbf = payload.iat;
      payload.exp = expiredAt;
      break;
    }
    case "FUTURE_NBF": {
      if (typeof payload.exp !== "number" || payload.exp <= now + 2)
        throw new Error("FUTURE_NBF requires a token that expires in the future");
      payload.nbf = Math.min(now + (decision.parameters.nbfAheadSeconds ?? defaultNbfAheadSeconds), payload.exp - 1);
      break;
    }
    case "NONCE_MISMATCH":
      payload.nonce = mismatchedNonce;
      break;
    case "NONCE_MISSING":
      delete payload.nonce;
      break;
    case "WRONG_TENANT": {
      // Keep iss and tid consistent so the token looks validly issued by
      // another tenant; WRONG_ISSUER covers an iss that matches no tenant.
      const tenantId = typeof payload.tid === "string" ? payload.tid : undefined;
      if (tenantId && typeof payload.iss === "string") payload.iss = payload.iss.replaceAll(tenantId, wrongTenantId);
      payload.tid = wrongTenantId;
      break;
    }
    case "MISSING_CLAIM":
      delete payload[decision.parameters.claim ?? defaultMissingClaim];
      break;
    case "ALG_NONE": {
      const header: Record<string, unknown> = { ...oldHeader, alg: "none" };
      delete header.kid;
      return unsignedJwt(header, payload);
    }
  }
  const signingKey =
    decision.scenario === "INVALID_SIGNATURE"
      ? keys.invalid
      : decision.scenario === "SIGNING_KEY_ROLLOVER"
        ? keys.rollover
        : keys.normal;
  const kid =
    decision.scenario === "UNKNOWN_KID"
      ? "unknown-kid"
      : decision.scenario === "INVALID_SIGNATURE"
        ? String(keys.normal.publicJwk.kid)
        : String(signingKey.publicJwk.kid);
  const header = {
    ...oldHeader,
    alg: "RS256",
    kid,
  };
  return new SignJWT(payload).setProtectedHeader(header).sign(signingKey.privateKey);
}

export async function mutateTokenResponse(body: unknown, decision: FaultDecision, keys: SigningKeys): Promise<unknown> {
  if (!body || typeof body !== "object") return body;
  const response = { ...(body as Record<string, unknown>) };
  if (decision.scenario === "TOKEN_NO_ID_TOKEN") {
    delete response.id_token;
    return response;
  }
  if (typeof response.id_token === "string") response.id_token = await mutateToken(response.id_token, decision, keys);
  if (
    !idTokenOnlyScenarios.has(decision.scenario) &&
    typeof response.access_token === "string" &&
    response.access_token.split(".").length === 3
  )
    response.access_token = await mutateToken(response.access_token, decision, keys);
  return response;
}
