export interface ApiResourceConfig {
  resourceAppId: string;
  identifierUri: string;
  scopes: string[];
  requestedAccessTokenVersion: 1 | 2 | null;
  emailOptionalClaim: boolean;
  groupMembershipClaims: "None" | "SecurityGroup";
}
export type ResourceInput = ApiResourceConfig;
export const defaultResourceAppId = "55555555-5555-4555-8555-555555555555";
export const defaultResourceUri = `api://${defaultResourceAppId}`;
