export const scenarioNames = [
  "NORMAL",
  "ACCESS_DENIED",
  "AUTH_LOGIN_REQUIRED",
  "AUTH_INTERACTION_REQUIRED",
  "AUTH_TEMPORARILY_UNAVAILABLE",
  "AUTH_SERVER_ERROR",
  "AUTH_429",
  "AUTH_500",
  "AUTH_TIMEOUT",
  "NO_GROUPS",
  "WRONG_AUDIENCE",
  "WRONG_ISSUER",
  "EXPIRED_TOKEN",
  "FUTURE_NBF",
  "INVALID_SIGNATURE",
  "UNKNOWN_KID",
  "SIGNING_KEY_ROLLOVER",
  "TOKEN_400",
  "TOKEN_429",
  "TOKEN_500",
  "TOKEN_TIMEOUT",
  "JWKS_INVALID",
  "JWKS_429",
  "JWKS_500",
  "JWKS_TIMEOUT",
  "DISCOVERY_429",
  "DISCOVERY_500",
  "DISCOVERY_TIMEOUT",
] as const;

export type ScenarioName = (typeof scenarioNames)[number];
export type FaultScenarioName = Exclude<ScenarioName, "NORMAL">;
export type ScenarioMode = "CONTINUOUS" | "LIMITED";
export type FaultEndpoint =
  | "authorization"
  | "authorization-http"
  | "claims"
  | "token-jwt"
  | "token"
  | "jwks"
  | "discovery";

export interface ScenarioParameters {
  delayMs?: number;
  error?: string;
  errorDescription?: string;
  retryAfterSeconds?: number;
}

export interface ScenarioConfig {
  scenario: ScenarioName;
  mode: ScenarioMode | null;
  initialFailureCount: number | null;
  remainingFailures: number | null;
  triggeredCount: number;
  parameters: ScenarioParameters;
}

export interface ScenarioHistory extends ScenarioConfig {
  completed: true;
  completedAt: string;
}

export interface ScenarioView extends ScenarioConfig {
  status: "NORMAL" | "ACTIVE";
  lastCompleted: ScenarioHistory | null;
}

export interface FaultDecision {
  scenario: FaultScenarioName;
  endpoint: FaultEndpoint;
  mode: ScenarioMode;
  parameters: ScenarioParameters;
  remainingBefore: number | null;
  remainingAfter: number | null;
}

export interface NormalScenarioInput {
  scenario: "NORMAL";
  mode?: never;
  failureCount?: never;
  parameters?: never;
}

type TimeoutScenarioName =
  "AUTH_TIMEOUT" | "TOKEN_TIMEOUT" | "JWKS_TIMEOUT" | "DISCOVERY_TIMEOUT";
type RetryAfterRequiredScenarioName =
  "AUTH_429" | "TOKEN_429" | "JWKS_429" | "DISCOVERY_429";
type RetryAfterOptionalScenarioName =
  "AUTH_500" | "TOKEN_500" | "JWKS_500" | "DISCOVERY_500";
type ParameterlessScenarioName = Exclude<
  FaultScenarioName,
  | TimeoutScenarioName
  | "TOKEN_400"
  | RetryAfterRequiredScenarioName
  | RetryAfterOptionalScenarioName
>;

interface NoScenarioParameters {
  delayMs?: never;
  error?: never;
  errorDescription?: never;
  retryAfterSeconds?: never;
}

interface TimeoutScenarioParameters {
  delayMs?: number;
  error?: never;
  errorDescription?: never;
  retryAfterSeconds?: never;
}

interface Token400ScenarioParameters {
  delayMs?: never;
  error?: string;
  errorDescription?: string;
  retryAfterSeconds?: never;
}

interface RetryAfterScenarioParameters {
  delayMs?: never;
  error?: never;
  errorDescription?: never;
  retryAfterSeconds?: number;
}

type ScenarioSpecificInput =
  | {
      scenario: ParameterlessScenarioName;
      parameters?: NoScenarioParameters;
    }
  | {
      scenario: TimeoutScenarioName;
      parameters?: TimeoutScenarioParameters;
    }
  | {
      scenario: "TOKEN_400";
      parameters?: Token400ScenarioParameters;
    }
  | {
      scenario: RetryAfterRequiredScenarioName | RetryAfterOptionalScenarioName;
      parameters?: RetryAfterScenarioParameters;
    };

export type ContinuousScenarioInput = ScenarioSpecificInput & {
  mode: "CONTINUOUS";
  failureCount?: never;
};

export type LimitedScenarioInput = ScenarioSpecificInput & {
  mode: "LIMITED";
  failureCount: number;
};

export type SetScenarioInput =
  NormalScenarioInput | ContinuousScenarioInput | LimitedScenarioInput;

/**
 * Captures which scenario activation was current when an HTTP request entered
 * the application. Tickets are opaque to callers and can be consumed at most
 * once by the store.
 */
export interface ScenarioRequestTicket {
  readonly activationId: number | null;
}
