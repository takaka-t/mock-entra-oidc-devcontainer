export const authorizationFaultDefinitions = [
  {
    scenario: "ACCESS_DENIED",
    promptName: "mock_access_denied",
    error: "access_denied",
    errorDescription: "Access denied by mock scenario",
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

export type AuthorizationFaultDefinition =
  (typeof authorizationFaultDefinitions)[number];

export function authorizationFaultForPrompt(
  promptName: string,
): AuthorizationFaultDefinition | undefined {
  return authorizationFaultDefinitions.find(
    (definition) => definition.promptName === promptName,
  );
}
