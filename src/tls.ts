import { createPrivateKey, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ServerOptions } from "node:https";
import type { AppConfig } from "./config.js";

type TlsFileConfig = Pick<
  AppConfig,
  "issuer" | "tlsCaCertificateFile" | "tlsCertificateFile" | "tlsPrivateKeyFile"
>;

const setupHint =
  "Run `npm run setup:tls` and follow the CA trust instructions.";
const tlsServerAuthOid = "1.3.6.1.5.5.7.3.1";

export class TlsSetupError extends Error {
  constructor(message: string, cause?: unknown) {
    super(`TLS setup is incomplete or invalid: ${message}. ${setupHint}`, {
      cause,
    });
    this.name = "TlsSetupError";
  }
}

async function readTlsFile(label: string, path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (error) {
    throw new TlsSetupError(`could not read ${label} at ${path}`, error);
  }
}

function parseCertificate(
  label: string,
  path: string,
  pem: Buffer,
): X509Certificate {
  try {
    return new X509Certificate(pem);
  } catch (error) {
    throw new TlsSetupError(
      `${label} is not a valid X.509 certificate at ${path}`,
      error,
    );
  }
}

function assertCurrentlyValid(
  label: string,
  path: string,
  certificate: X509Certificate,
  now: Date,
): void {
  if (now < certificate.validFromDate)
    throw new TlsSetupError(
      `${label} is not valid before ${certificate.validFromDate.toISOString()} at ${path}`,
    );
  if (now >= certificate.validToDate)
    throw new TlsSetupError(
      `${label} expired at ${certificate.validToDate.toISOString()} (${path})`,
    );
}

function issuerHostname(issuer: string): string {
  try {
    const url = new URL(issuer);
    if (url.protocol !== "https:")
      throw new Error("the configured issuer must use https");
    return url.hostname;
  } catch (error) {
    throw new TlsSetupError(
      `configured issuer is not a valid HTTPS URL: ${issuer}`,
      error,
    );
  }
}

export async function loadTlsServerOptions(
  config: TlsFileConfig,
): Promise<ServerOptions> {
  const hostname = issuerHostname(config.issuer);
  const [caPem, certificatePem, privateKeyPem] = await Promise.all([
    readTlsFile("CA certificate", config.tlsCaCertificateFile),
    readTlsFile("server certificate", config.tlsCertificateFile),
    readTlsFile("server private key", config.tlsPrivateKeyFile),
  ]);
  const caCertificate = parseCertificate(
    "CA certificate",
    config.tlsCaCertificateFile,
    caPem,
  );
  const certificate = parseCertificate(
    "server certificate",
    config.tlsCertificateFile,
    certificatePem,
  );
  const now = new Date();
  assertCurrentlyValid(
    "CA certificate",
    config.tlsCaCertificateFile,
    caCertificate,
    now,
  );
  assertCurrentlyValid(
    "server certificate",
    config.tlsCertificateFile,
    certificate,
    now,
  );

  if (!caCertificate.ca)
    throw new TlsSetupError(
      `CA certificate is not marked as a certificate authority at ${config.tlsCaCertificateFile}`,
    );
  if (
    caCertificate.subject !== caCertificate.issuer ||
    !caCertificate.checkIssued(caCertificate) ||
    !caCertificate.verify(caCertificate.publicKey)
  )
    throw new TlsSetupError(
      `CA certificate is not self-signed at ${config.tlsCaCertificateFile}`,
    );
  if (certificate.ca)
    throw new TlsSetupError(
      `server certificate is marked as a certificate authority at ${config.tlsCertificateFile}`,
    );
  if (
    !certificate.checkIssued(caCertificate) ||
    !certificate.verify(caCertificate.publicKey)
  )
    throw new TlsSetupError(
      `server certificate was not signed by the configured CA (CA: ${config.tlsCaCertificateFile}, server: ${config.tlsCertificateFile})`,
    );
  if (
    certificate.subjectAltName !== `DNS:${hostname}` ||
    !certificate.checkHost(hostname, { subject: "never" })
  )
    throw new TlsSetupError(
      `server certificate subjectAltName must contain only DNS:${hostname} at ${config.tlsCertificateFile}`,
    );
  if (!certificate.keyUsage?.includes(tlsServerAuthOid))
    throw new TlsSetupError(
      `server certificate extendedKeyUsage does not allow TLS server authentication at ${config.tlsCertificateFile}`,
    );

  let privateKey;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch (error) {
    throw new TlsSetupError(
      `server private key is not valid PEM at ${config.tlsPrivateKeyFile}`,
      error,
    );
  }
  if (!certificate.checkPrivateKey(privateKey))
    throw new TlsSetupError(
      `server private key does not match the server certificate (certificate: ${config.tlsCertificateFile}, key: ${config.tlsPrivateKeyFile})`,
    );

  return {
    cert: certificatePem,
    key: privateKeyPem,
    minVersion: "TLSv1.2",
  };
}
