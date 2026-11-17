export const clientTypes = ["PUBLIC", "CONFIDENTIAL"] as const;
export type ClientType = (typeof clientTypes)[number];
export const tokenEndpointAuthMethods = ["none", "client_secret_basic", "client_secret_post"] as const;
export type TokenEndpointAuthMethod = (typeof tokenEndpointAuthMethods)[number];
export interface RedirectUri {
  uri: string;
  type: "spa" | "web" | "native";
}
export interface ApiPermission {
  resourceAppId: string;
  scopes: string[];
}
export interface OidcClientConfig {
  clientId: string;
  clientType: ClientType;
  clientSecret?: string | undefined;
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  redirectUris: RedirectUri[];
  requiredResourceAccess: ApiPermission[];
  emailOptionalClaim: boolean;
  groupMembershipClaims: "None" | "SecurityGroup";
}
export type CreateOidcClientInput = OidcClientConfig;
export type UpdateOidcClientInput = Omit<OidcClientConfig, "clientId">;
export const publicClientId = "00000000-0000-4000-8000-000000000001";
export const confidentialClientId = "00000000-0000-4000-8000-000000000002";
export const spaClientId = "00000000-0000-4000-8000-000000000003";
