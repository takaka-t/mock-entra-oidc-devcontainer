export const mockTenantId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
export const mockOrigin = "https://mock-idp.test:9000";
export const mockPort = 9000;
export const mockTenantBasePath = `/${mockTenantId}`;
export const mockIssuerPath = `${mockTenantBasePath}/v2.0`;
export const mockIssuer = `${mockOrigin}${mockIssuerPath}`;
export const mockAuthorizePath = `${mockTenantBasePath}/oauth2/v2.0/authorize`;
export const mockTokenPath = `${mockTenantBasePath}/oauth2/v2.0/token`;
export const mockJwksPath = `${mockTenantBasePath}/discovery/v2.0/keys`;
export const mockLogoutPath = `${mockTenantBasePath}/oauth2/v2.0/logout`;

/**
 * `common` is Entra's multi-tenant alias. Clients probe reachability with a
 * bodyless `HEAD` against its Authorization endpoint before starting a real
 * sign-in, so this Mock serves that path for `HEAD` only and keeps it out of
 * the tenant-scoped OIDC surface.
 */
export const mockCommonTenantId = "common";
export const mockCommonAuthorizePath = `/${mockCommonTenantId}/oauth2/v2.0/authorize`;

export interface AppConfig {
  tenantId: string;
  issuer: string;
  issuerOrigin: string;
  issuerPath: string;
  authorizePath: string;
  tokenPath: string;
  jwksPath: string;
  logoutPath: string;
  commonAuthorizePath: string;
  port: number;
  host: string;
  logger: boolean;
  trustProxy: boolean;
  keyDirectory: string;
  clientConfigFile: string;
  tlsCaCertificateFile: string;
  tlsCertificateFile: string;
  tlsPrivateKeyFile: string;
}

export function loadConfig(): AppConfig {
  return {
    tenantId: mockTenantId,
    issuer: mockIssuer,
    issuerOrigin: mockOrigin,
    issuerPath: mockIssuerPath,
    authorizePath: mockAuthorizePath,
    tokenPath: mockTokenPath,
    jwksPath: mockJwksPath,
    logoutPath: mockLogoutPath,
    commonAuthorizePath: mockCommonAuthorizePath,
    port: mockPort,
    host: "0.0.0.0",
    logger: true,
    trustProxy: false,
    keyDirectory: ".data/keys",
    clientConfigFile: ".data/clients.json",
    tlsCaCertificateFile: ".data/tls/ca.crt",
    tlsCertificateFile: ".data/tls/server.crt",
    tlsPrivateKeyFile: ".data/tls-private/server.key.pem",
  };
}
