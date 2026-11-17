export const clientTypes = ["PUBLIC", "CONFIDENTIAL"] as const;
export type ClientType = (typeof clientTypes)[number];

export const tokenEndpointAuthMethods = ["none", "client_secret_basic", "client_secret_post"] as const;
export type TokenEndpointAuthMethod = (typeof tokenEndpointAuthMethods)[number];

export interface OidcClientConfig {
  clientId: string;
  clientType: ClientType;
  clientSecret?: string;
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  accessTokenAudience: string;
  accessTokenScope: string;
  accessTokenVersion: "1.0" | "2.0";
  emailOptionalClaim: boolean;
}

export type CreateOidcClientInput = Omit<OidcClientConfig, "accessTokenVersion"> & {
  accessTokenVersion?: OidcClientConfig["accessTokenVersion"];
};
export type UpdateOidcClientInput = Omit<CreateOidcClientInput, "clientId">;
