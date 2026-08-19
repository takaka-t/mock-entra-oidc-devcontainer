import type { FaultEndpoint, ScenarioName } from "./types.js";

export type ScenarioParameterKind = "none" | "timeout" | "token400";

export interface ScenarioDefinition {
  endpoint: FaultEndpoint | null;
  parameterKind: ScenarioParameterKind;
  effect:
    | "normal"
    | "authorization-denied"
    | "claims-mutation"
    | "token-mutation"
    | "http-400"
    | "http-500"
    | "http-timeout";
}

export const scenarios: Record<ScenarioName, ScenarioDefinition> = {
  NORMAL: { endpoint: null, parameterKind: "none", effect: "normal" },
  ACCESS_DENIED: {
    endpoint: "authorization",
    parameterKind: "none",
    effect: "authorization-denied",
  },
  NO_GROUPS: {
    endpoint: "claims",
    parameterKind: "none",
    effect: "claims-mutation",
  },
  UNKNOWN_GROUPS: {
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
    parameterKind: "none",
    effect: "token-mutation",
  },
  FUTURE_NBF: {
    endpoint: "token-jwt",
    parameterKind: "none",
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
  TOKEN_400: {
    endpoint: "token",
    parameterKind: "token400",
    effect: "http-400",
  },
  TOKEN_500: {
    endpoint: "token",
    parameterKind: "none",
    effect: "http-500",
  },
  TOKEN_TIMEOUT: {
    endpoint: "token",
    parameterKind: "timeout",
    effect: "http-timeout",
  },
  JWKS_500: {
    endpoint: "jwks",
    parameterKind: "none",
    effect: "http-500",
  },
  JWKS_TIMEOUT: {
    endpoint: "jwks",
    parameterKind: "timeout",
    effect: "http-timeout",
  },
  DISCOVERY_500: {
    endpoint: "discovery",
    parameterKind: "none",
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

export interface ScenarioUiMetadata {
  label: ScenarioName;
  supportsMode: boolean;
  parameterKind: ScenarioParameterKind;
}

export const scenarioUiMetadata = Object.fromEntries(
  (Object.entries(scenarios) as Array<[ScenarioName, ScenarioDefinition]>).map(
    ([name, definition]) => [
      name,
      {
        label: name,
        supportsMode: name !== "NORMAL",
        parameterKind: definition.parameterKind,
      },
    ],
  ),
) as Record<ScenarioName, ScenarioUiMetadata>;

export const scenarioUiDefaults = {
  delayMs: defaultDelayMs,
  maxDelayMs,
  tokenError: defaultTokenError,
} as const;

export const httpFaultEndpoints = {
  token: { method: "POST", pathname: "/token" },
  jwks: { method: "GET", pathname: "/jwks" },
  discovery: {
    method: "GET",
    pathname: "/.well-known/openid-configuration",
  },
} as const satisfies Record<
  Extract<FaultEndpoint, "token" | "jwks" | "discovery">,
  { method: "GET" | "POST"; pathname: string }
>;
