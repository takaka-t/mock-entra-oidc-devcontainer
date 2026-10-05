import { randomBytes } from "node:crypto";
import type { FaultDecision } from "../scenario/types.js";

export const authorizationFaultDefinitions = [
  {
    scenario: "ACCESS_DENIED",
    promptName: "mock_access_denied",
    error: "access_denied",
    errorDescription: "Access denied by mock scenario",
  },
  {
    scenario: "AUTH_LOGIN_REQUIRED",
    promptName: "mock_login_required",
    error: "login_required",
    errorDescription: "Login required by mock scenario",
  },
  {
    scenario: "AUTH_INTERACTION_REQUIRED",
    promptName: "mock_interaction_required",
    error: "interaction_required",
    errorDescription: "Interaction required by mock scenario",
  },
  {
    scenario: "AUTH_TEMPORARILY_UNAVAILABLE",
    promptName: "mock_temporarily_unavailable",
    error: "temporarily_unavailable",
    errorDescription: "Authorization temporarily unavailable by mock scenario",
  },
  {
    scenario: "AUTH_SERVER_ERROR",
    promptName: "mock_server_error",
    error: "server_error",
    errorDescription: "Authorization server error injected by mock scenario",
  },
] as const;

export type AuthorizationFaultDefinition = (typeof authorizationFaultDefinitions)[number];

export function authorizationFaultForPrompt(promptName: string): AuthorizationFaultDefinition | undefined {
  return authorizationFaultDefinitions.find((definition) => definition.promptName === promptName);
}

export const mismatchedState = "mock-mismatched-state";

/**
 * Rewrites the parameters of a successful Authorization response in place.
 * oidc-provider emits `authorization.success` with the very object it then
 * hands to the response mode, so this applies to `query` and `form_post` alike.
 */
export function mutateAuthorizationResponse(out: Record<string, unknown>, decision: FaultDecision): void {
  switch (decision.scenario) {
    case "AUTH_STATE_MISMATCH":
      out.state = mismatchedState;
      break;
    case "AUTH_STATE_MISSING":
      delete out.state;
      break;
    case "AUTH_CODE_INVALID":
      out.code = `mock-invalid-${randomBytes(16).toString("base64url")}`;
      break;
    case "AUTH_CODE_MISSING":
      delete out.code;
      break;
    case "AUTH_CODE_WITH_ERROR":
      out.error = "server_error";
      out.error_description = "Authorization error injected alongside a code by mock scenario";
      break;
  }
}
