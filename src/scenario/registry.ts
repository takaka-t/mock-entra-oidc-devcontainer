import { mockTokenTtlSeconds, type AppConfig } from "../config.js";
import { missingClaimNames, type FaultEndpoint, type ScenarioName } from "./types.js";

export type ScenarioParameterKind =
  "none" | "timeout" | "token400" | "retryAfter" | "claim" | "expiredToken" | "futureNbf";

export interface ScenarioDefinition {
  endpoint: FaultEndpoint | null;
  parameterKind: ScenarioParameterKind;
  effect:
    | "normal"
    | "authorization-denied"
    | "authorization-error"
    | "authorization-response-mutation"
    | "claims-mutation"
    | "token-mutation"
    | "token-response-mutation"
    | "signing-key-rollover"
    | "http-400"
    | "http-429"
    | "http-500"
    | "jwks-invalid"
    | "http-timeout";
}

export const scenarios: Record<ScenarioName, ScenarioDefinition> = {
  NORMAL: { endpoint: null, parameterKind: "none", effect: "normal" },
  ACCESS_DENIED: {
    endpoint: "authorization",
    parameterKind: "none",
    effect: "authorization-denied",
  },
  AUTH_LOGIN_REQUIRED: {
    endpoint: "authorization",
    parameterKind: "none",
    effect: "authorization-error",
  },
  AUTH_INTERACTION_REQUIRED: {
    endpoint: "authorization",
    parameterKind: "none",
    effect: "authorization-error",
  },
  AUTH_TEMPORARILY_UNAVAILABLE: {
    endpoint: "authorization",
    parameterKind: "none",
    effect: "authorization-error",
  },
  AUTH_SERVER_ERROR: {
    endpoint: "authorization",
    parameterKind: "none",
    effect: "authorization-error",
  },
  AUTH_STATE_MISMATCH: {
    endpoint: "authorization-response",
    parameterKind: "none",
    effect: "authorization-response-mutation",
  },
  AUTH_STATE_MISSING: {
    endpoint: "authorization-response",
    parameterKind: "none",
    effect: "authorization-response-mutation",
  },
  AUTH_CODE_INVALID: {
    endpoint: "authorization-response",
    parameterKind: "none",
    effect: "authorization-response-mutation",
  },
  AUTH_CODE_MISSING: {
    endpoint: "authorization-response",
    parameterKind: "none",
    effect: "authorization-response-mutation",
  },
  AUTH_CODE_WITH_ERROR: {
    endpoint: "authorization-response",
    parameterKind: "none",
    effect: "authorization-response-mutation",
  },
  AUTH_400: {
    endpoint: "authorization-http",
    parameterKind: "none",
    effect: "http-400",
  },
  AUTH_429: {
    endpoint: "authorization-http",
    parameterKind: "retryAfter",
    effect: "http-429",
  },
  AUTH_500: {
    endpoint: "authorization-http",
    parameterKind: "retryAfter",
    effect: "http-500",
  },
  AUTH_TIMEOUT: {
    endpoint: "authorization-http",
    parameterKind: "timeout",
    effect: "http-timeout",
  },
  NO_GROUPS: {
    endpoint: "claims",
    parameterKind: "none",
    effect: "claims-mutation",
  },
  WRONG_AUDIENCE: {
    endpoint: "token-jwt",
    parameterKind: "none",
    effect: "token-mutation",
  },
  WRONG_ISSUER: {
    endpoint: "token-jwt",
    parameterKind: "none",
    effect: "token-mutation",
  },
  EXPIRED_TOKEN: {
    endpoint: "token-jwt",
    parameterKind: "expiredToken",
    effect: "token-mutation",
  },
  FUTURE_NBF: {
    endpoint: "token-jwt",
    parameterKind: "futureNbf",
    effect: "token-mutation",
  },
  INVALID_SIGNATURE: {
    endpoint: "token-jwt",
    parameterKind: "none",
    effect: "token-mutation",
  },
  UNKNOWN_KID: {
    endpoint: "token-jwt",
    parameterKind: "none",
    effect: "token-mutation",
  },
  SIGNING_KEY_ROLLOVER: {
    endpoint: "token-jwt",
    parameterKind: "none",
    effect: "signing-key-rollover",
  },
  NONCE_MISMATCH: {
    endpoint: "token-jwt",
    parameterKind: "none",
    effect: "token-mutation",
  },
  NONCE_MISSING: {
    endpoint: "token-jwt",
    parameterKind: "none",
    effect: "token-mutation",
  },
  ALG_NONE: {
    endpoint: "token-jwt",
    parameterKind: "none",
    effect: "token-mutation",
  },
  WRONG_TENANT: {
    endpoint: "token-jwt",
    parameterKind: "none",
    effect: "token-mutation",
  },
  MISSING_CLAIM: {
    endpoint: "token-jwt",
    parameterKind: "claim",
    effect: "token-mutation",
  },
  TOKEN_NO_ID_TOKEN: {
    endpoint: "token-jwt",
    parameterKind: "none",
    effect: "token-response-mutation",
  },
  TOKEN_400: {
    endpoint: "token",
    parameterKind: "token400",
    effect: "http-400",
  },
  TOKEN_429: {
    endpoint: "token",
    parameterKind: "retryAfter",
    effect: "http-429",
  },
  TOKEN_500: {
    endpoint: "token",
    parameterKind: "retryAfter",
    effect: "http-500",
  },
  TOKEN_TIMEOUT: {
    endpoint: "token",
    parameterKind: "timeout",
    effect: "http-timeout",
  },
  JWKS_INVALID: {
    endpoint: "jwks",
    parameterKind: "none",
    effect: "jwks-invalid",
  },
  JWKS_429: {
    endpoint: "jwks",
    parameterKind: "retryAfter",
    effect: "http-429",
  },
  JWKS_500: {
    endpoint: "jwks",
    parameterKind: "retryAfter",
    effect: "http-500",
  },
  JWKS_TIMEOUT: {
    endpoint: "jwks",
    parameterKind: "timeout",
    effect: "http-timeout",
  },
  DISCOVERY_429: {
    endpoint: "discovery",
    parameterKind: "retryAfter",
    effect: "http-429",
  },
  DISCOVERY_500: {
    endpoint: "discovery",
    parameterKind: "retryAfter",
    effect: "http-500",
  },
  DISCOVERY_TIMEOUT: {
    endpoint: "discovery",
    parameterKind: "timeout",
    effect: "http-timeout",
  },
};

export const maxDelayMs = 300_000;
export const defaultDelayMs = 30_000;
export const defaultTokenError = "invalid_grant";
export const defaultMissingClaim = "sub";
// Both defaults exceed common validator clock skews (Spring Security 60s,
// Microsoft.IdentityModel 300s), so the token is rejected without tuning.
export const defaultExpiredAgoSeconds = 600;
export const maxExpiredAgoSeconds = 31_536_000;
export const defaultNbfAheadSeconds = 600;
/** One second below the ID/Access Token TTL, so `nbf` stays before `exp`. */
export const maxNbfAheadSeconds = mockTokenTtlSeconds - 1;

export interface ScenarioUiMetadata {
  supportsMode: boolean;
  parameterKind: ScenarioParameterKind;
  effect: ScenarioDefinition["effect"];
}

export const scenarioUiMetadata = Object.fromEntries(
  (Object.entries(scenarios) as Array<[ScenarioName, ScenarioDefinition]>).map(([name, definition]) => [
    name,
    {
      supportsMode: name !== "NORMAL",
      parameterKind: definition.parameterKind,
      effect: definition.effect,
    },
  ]),
) as Record<ScenarioName, ScenarioUiMetadata>;

export const scenarioUiDefaults = {
  delayMs: defaultDelayMs,
  maxDelayMs,
  tokenError: defaultTokenError,
  missingClaim: defaultMissingClaim,
  missingClaims: missingClaimNames,
  expiredAgoSeconds: defaultExpiredAgoSeconds,
  maxExpiredAgoSeconds,
  nbfAheadSeconds: defaultNbfAheadSeconds,
  maxNbfAheadSeconds,
} as const;

export type HttpFaultEndpoint = Extract<FaultEndpoint, "authorization-http" | "token" | "jwks" | "discovery">;

export interface HttpFaultRoute {
  method: "GET" | "POST" | "HEAD";
  pathname: string;
}

export type HttpFaultRouteTable = Record<HttpFaultEndpoint, HttpFaultRoute>;

/**
 * token/jwks are Entra-compliant sibling paths of issuerPath (see src/app.ts),
 * so their fault-injection routes must be resolved from the server's actual
 * absolute paths rather than derived from a single shared prefix. The `common`
 * connectivity probe is tenant-independent, so it keeps the same root-level
 * pathname in every configuration.
 */
export function resolveHttpFaultEndpoints(
  config: Pick<AppConfig, "issuerPath" | "tokenPath" | "jwksPath" | "commonAuthorizePath">,
): HttpFaultRouteTable {
  return {
    "authorization-http": {
      method: "HEAD",
      pathname: config.commonAuthorizePath,
    },
    token: { method: "POST", pathname: config.tokenPath },
    jwks: { method: "GET", pathname: config.jwksPath },
    discovery: {
      method: "GET",
      pathname: `${config.issuerPath}/.well-known/openid-configuration`,
    },
  };
}

/**
 * The CORS surface is deliberately wider than the fault route table: the
 * tenant Authorization endpoint no longer carries an HTTP fault, but preflight
 * and CORS headers there must keep behaving as they did before the faults
 * moved to the `common` connectivity probe.
 */
export function resolveCorsPathnames(
  config: Pick<AppConfig, "issuerPath" | "authorizePath" | "tokenPath" | "jwksPath" | "commonAuthorizePath">,
): readonly string[] {
  return [
    config.authorizePath,
    config.tokenPath,
    config.jwksPath,
    `${config.issuerPath}/.well-known/openid-configuration`,
    config.commonAuthorizePath,
  ];
}
