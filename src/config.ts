export const mockTenantId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
export const mockOrigin = "https://mock-idp.test:9000";
export const mockPort = 9000;
export const mockIssuerPath = `/${mockTenantId}/v2.0`;
export const mockIssuer = `${mockOrigin}${mockIssuerPath}`;

export interface AppConfig {
  tenantId: string;
  issuer: string;
  issuerOrigin: string;
  issuerPath: string;
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
