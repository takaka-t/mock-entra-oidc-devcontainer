export const scenarioNames = [
  "NORMAL",
  "ACCESS_DENIED",
  "NO_GROUPS",
  "UNKNOWN_GROUPS",
  "WRONG_AUDIENCE",
  "WRONG_ISSUER",
  "EXPIRED_TOKEN",
  "FUTURE_NBF",
  "INVALID_SIGNATURE",
  "UNKNOWN_KID",
  "TOKEN_400",
  "TOKEN_500",
  "TOKEN_TIMEOUT",
  "JWKS_500",
  "JWKS_TIMEOUT",
  "DISCOVERY_500",
  "DISCOVERY_TIMEOUT",
] as const;

export type ScenarioName = (typeof scenarioNames)[number];
export type FaultScenarioName = Exclude<ScenarioName, "NORMAL">;
export type ScenarioMode = "CONTINUOUS" | "LIMITED";
export type FaultEndpoint =
  "authorization" | "claims" | "token-jwt" | "token" | "jwks" | "discovery";

export interface ScenarioParameters {
  delayMs?: number;
  error?: string;
  errorDescription?: string;
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
  "TOKEN_TIMEOUT" | "JWKS_TIMEOUT" | "DISCOVERY_TIMEOUT";
type ParameterlessScenarioName = Exclude<
  FaultScenarioName,
  TimeoutScenarioName | "TOKEN_400"
>;

interface NoScenarioParameters {
  delayMs?: never;
  error?: never;
  errorDescription?: never;
}

interface TimeoutScenarioParameters {
  delayMs?: number;
  error?: never;
  errorDescription?: never;
}

interface Token400ScenarioParameters {
  delayMs?: never;
  error?: string;
  errorDescription?: string;
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
