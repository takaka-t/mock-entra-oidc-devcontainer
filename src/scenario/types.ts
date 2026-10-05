export const scenarioNames = [
  "NORMAL",
  "ACCESS_DENIED",
  "AUTH_LOGIN_REQUIRED",
  "AUTH_INTERACTION_REQUIRED",
  "AUTH_TEMPORARILY_UNAVAILABLE",
  "AUTH_SERVER_ERROR",
  "AUTH_STATE_MISMATCH",
  "AUTH_STATE_MISSING",
  "AUTH_CODE_INVALID",
  "AUTH_CODE_MISSING",
  "AUTH_CODE_WITH_ERROR",
  "AUTH_400",
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
  "NONCE_MISMATCH",
  "NONCE_MISSING",
  "ALG_NONE",
  "WRONG_TENANT",
  "MISSING_CLAIM",
  "TOKEN_NO_ID_TOKEN",
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
/**
 * `authorization` is the OAuth redirect fault on a real Authorization request.
 * `authorization-response` rewrites the parameters of a successful
 * Authorization response (`code`/`state`) before they reach the client.
 * `authorization-http` is the `common` connectivity probe (`HEAD`), which is a
 * separate failure from a sign-in and never affects one.
 */
export type FaultEndpoint =
  | "authorization"
  | "authorization-response"
  | "authorization-http"
  | "claims"
  | "token-jwt"
  | "token"
  | "jwks"
  | "discovery";

export const missingClaimNames = ["sub", "oid", "tid", "iss", "aud", "exp", "iat"] as const;
export type MissingClaimName = (typeof missingClaimNames)[number];

export interface ScenarioParameters {
  claim?: MissingClaimName;
  delayMs?: number;
  error?: string;
  errorDescription?: string;
  expiredAgoSeconds?: number;
  nbfAheadSeconds?: number;
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

type TimeoutScenarioName = "AUTH_TIMEOUT" | "TOKEN_TIMEOUT" | "JWKS_TIMEOUT" | "DISCOVERY_TIMEOUT";
type RetryAfterScenarioName =
  "AUTH_429" | "TOKEN_429" | "JWKS_429" | "DISCOVERY_429" | "AUTH_500" | "TOKEN_500" | "JWKS_500" | "DISCOVERY_500";
type ParameterlessScenarioName = Exclude<
  FaultScenarioName,
  TimeoutScenarioName | "TOKEN_400" | "MISSING_CLAIM" | "EXPIRED_TOKEN" | "FUTURE_NBF" | RetryAfterScenarioName
>;

interface NoScenarioParameters {
  claim?: never;
  delayMs?: never;
  error?: never;
  errorDescription?: never;
  expiredAgoSeconds?: never;
  nbfAheadSeconds?: never;
  retryAfterSeconds?: never;
}

interface TimeoutScenarioParameters {
  claim?: never;
  delayMs?: number;
  error?: never;
  errorDescription?: never;
  expiredAgoSeconds?: never;
  nbfAheadSeconds?: never;
  retryAfterSeconds?: never;
}

interface Token400ScenarioParameters {
  claim?: never;
  delayMs?: never;
  error?: string;
  errorDescription?: string;
  expiredAgoSeconds?: never;
  nbfAheadSeconds?: never;
  retryAfterSeconds?: never;
}

interface RetryAfterScenarioParameters {
  claim?: never;
  delayMs?: never;
  error?: never;
  errorDescription?: never;
  expiredAgoSeconds?: never;
  nbfAheadSeconds?: never;
  retryAfterSeconds?: number;
}

interface MissingClaimScenarioParameters {
  claim?: MissingClaimName;
  delayMs?: never;
  error?: never;
  errorDescription?: never;
  expiredAgoSeconds?: never;
  nbfAheadSeconds?: never;
  retryAfterSeconds?: never;
}

interface ExpiredTokenScenarioParameters {
  claim?: never;
  delayMs?: never;
  error?: never;
  errorDescription?: never;
  expiredAgoSeconds?: number;
  nbfAheadSeconds?: never;
  retryAfterSeconds?: never;
}

interface FutureNbfScenarioParameters {
  claim?: never;
  delayMs?: never;
  error?: never;
  errorDescription?: never;
  expiredAgoSeconds?: never;
  nbfAheadSeconds?: number;
  retryAfterSeconds?: never;
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
      scenario: RetryAfterScenarioName;
      parameters?: RetryAfterScenarioParameters;
    }
  | {
      scenario: "MISSING_CLAIM";
      parameters?: MissingClaimScenarioParameters;
    }
  | {
      scenario: "EXPIRED_TOKEN";
      parameters?: ExpiredTokenScenarioParameters;
    }
  | {
      scenario: "FUTURE_NBF";
      parameters?: FutureNbfScenarioParameters;
    };

export type ContinuousScenarioInput = ScenarioSpecificInput & {
  mode: "CONTINUOUS";
  failureCount?: never;
};

export type LimitedScenarioInput = ScenarioSpecificInput & {
  mode: "LIMITED";
  failureCount: number;
};

export type SetScenarioInput = NormalScenarioInput | ContinuousScenarioInput | LimitedScenarioInput;

/**
 * Captures which scenario activation was current when an HTTP request entered
 * the application. Tickets are opaque to callers and can be consumed at most
 * once by the store.
 */
export interface ScenarioRequestTicket {
  readonly activationId: number | null;
}
