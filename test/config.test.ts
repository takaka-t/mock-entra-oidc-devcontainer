import { describe, expect, it } from "vitest";
import {
  loadConfig,
  mockAuthorizePath,
  mockIssuer,
  mockIssuerPath,
  mockJwksPath,
  mockLogoutPath,
  mockOrigin,
  mockPort,
  mockTenantId,
  mockTokenPath,
} from "../src/config.js";

describe("fixed OIDC configuration", () => {
  it("uses the shared tenant, origin, issuer path, issuer, and port", () => {
    expect(loadConfig()).toEqual({
      tenantId: mockTenantId,
      issuer: mockIssuer,
      issuerOrigin: mockOrigin,
      issuerPath: mockIssuerPath,
      authorizePath: mockAuthorizePath,
      tokenPath: mockTokenPath,
      jwksPath: mockJwksPath,
      logoutPath: mockLogoutPath,
      port: mockPort,
      host: "0.0.0.0",
      logger: true,
      trustProxy: false,
      keyDirectory: ".data/keys",
      clientConfigFile: ".data/clients.json",
      tlsCaCertificateFile: ".data/tls/ca.crt",
      tlsCertificateFile: ".data/tls/server.crt",
      tlsPrivateKeyFile: ".data/tls-private/server.key.pem",
    });
    expect(mockTenantId).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    expect(mockIssuer).toBe(
      "https://mock-idp.test:9000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2.0",
    );
  });
});
