import type { FaultDecision, ScenarioName } from "../scenario/types.js";

/**
 * Which Mock IdP surface a request hit. `interaction` is the sign-in page the
 * Authorization endpoint redirects to; `connectivity-probe` is the bodyless
 * `HEAD` on the `common` alias. Anything else (legacy paths, typos) is
 * `other` so an unexpected 404 still shows up in the log.
 */
export type AccessLogEndpoint =
  "discovery" | "authorization" | "interaction" | "token" | "jwks" | "logout" | "connectivity-probe" | "other";

export interface AccessLogEntry {
  /** Monotonic across the process lifetime; clearing the log does not reset it. */
  id: number;
  receivedAt: string;
  method: string;
  /** Pathname only. Query, body and headers are never recorded. */
  path: string;
  endpoint: AccessLogEndpoint;
  /** `null` when the client disconnected before a response was sent. */
  statusCode: number | null;
  durationMs: number;
  /** The scenario that was armed when the request arrived, including NORMAL. */
  scenario: ScenarioName;
  /** The fault this request actually consumed, or `null` when none applied. */
  fault: FaultDecision | null;
}
