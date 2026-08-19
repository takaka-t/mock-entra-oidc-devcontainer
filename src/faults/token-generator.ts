import { decodeJwt, decodeProtectedHeader, SignJWT } from "jose";
import type { SigningKeys } from "../oidc/keys.js";
import type { FaultDecision } from "../scenario/types.js";

export async function mutateToken(
  token: string,
  decision: FaultDecision,
  keys: SigningKeys,
): Promise<string> {
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
      const expiredAt = now - 60;
      payload.iat = expiredAt - 3600;
      payload.nbf = payload.iat;
      payload.exp = expiredAt;
      break;
    }
    case "FUTURE_NBF": {
      if (typeof payload.exp !== "number" || payload.exp <= now + 2)
        throw new Error(
          "FUTURE_NBF requires a token that expires in the future",
        );
      payload.nbf = Math.min(now + 300, payload.exp - 1);
      break;
    }
  }
  const signingKey =
    decision.scenario === "INVALID_SIGNATURE" ? keys.invalid : keys.normal;
  const kid =
    decision.scenario === "UNKNOWN_KID"
      ? "unknown-kid"
      : String(keys.normal.publicJwk.kid);
  const header = {
    ...oldHeader,
    alg: "RS256",
    kid,
    typ: oldHeader.typ ?? "JWT",
  };
  return new SignJWT(payload)
    .setProtectedHeader(header)
    .sign(signingKey.privateKey);
}

export async function mutateTokenResponse(
  body: unknown,
  decision: FaultDecision,
  keys: SigningKeys,
): Promise<unknown> {
  if (!body || typeof body !== "object") return body;
  const response = { ...(body as Record<string, unknown>) };
  if (typeof response.id_token === "string")
    response.id_token = await mutateToken(response.id_token, decision, keys);
  if (
    typeof response.access_token === "string" &&
    response.access_token.split(".").length === 3
  )
    response.access_token = await mutateToken(
      response.access_token,
      decision,
      keys,
    );
  return response;
}
