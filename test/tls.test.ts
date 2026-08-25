import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadTlsServerOptions, TlsSetupError } from "../src/tls.js";

const execFileAsync = promisify(execFile);
const hostname = "mock-idp.test";

interface CertificateSet {
  caCertificate: string;
  certificate: string;
  privateKey: string;
}

async function generateCertificateSet(
  directory: string,
  certificateHostname: string,
  includeServerAuth = true,
): Promise<CertificateSet> {
  await mkdir(directory, { recursive: true });
  const caCertificate = join(directory, "ca.crt");
  const caPrivateKey = join(directory, "ca.key.pem");
  const certificate = join(directory, "server.crt");
  const privateKey = join(directory, "server.key.pem");
  const request = join(directory, "server.csr.pem");
  const extensions = join(directory, "server.ext");
  await execFileAsync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-days",
    "30",
    "-subj",
    `/CN=${certificateHostname} Test CA`,
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
    "-keyout",
    caPrivateKey,
    "-out",
    caCertificate,
  ]);
  await execFileAsync("openssl", [
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-subj",
    `/CN=${certificateHostname}`,
    "-keyout",
    privateKey,
    "-out",
    request,
  ]);
  await writeFile(
    extensions,
    [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      ...(includeServerAuth ? ["extendedKeyUsage=serverAuth"] : []),
      `subjectAltName=DNS:${certificateHostname}`,
      "",
    ].join("\n"),
  );
  await execFileAsync("openssl", [
    "x509",
    "-req",
    "-sha256",
    "-days",
    "1",
    "-in",
    request,
    "-CA",
    caCertificate,
    "-CAkey",
    caPrivateKey,
    "-CAcreateserial",
    "-extfile",
    extensions,
    "-out",
    certificate,
  ]);
  return { caCertificate, certificate, privateKey };
}

function tlsConfig(
  certificates: CertificateSet,
  issuer = `https://${hostname}:9000/tenant/v2.0`,
) {
  return {
    issuer,
    tlsCaCertificateFile: certificates.caCertificate,
    tlsCertificateFile: certificates.certificate,
    tlsPrivateKeyFile: certificates.privateKey,
  };
}

describe("TLS server options", () => {
  let stateDirectory: string;
  let valid: CertificateSet;
  let alternate: CertificateSet;
  let wrongHostname: CertificateSet;
  let wrongUsage: CertificateSet;

  beforeAll(async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), "mock-idp-tls-loader-"));
    [valid, alternate, wrongHostname, wrongUsage] = await Promise.all([
      generateCertificateSet(join(stateDirectory, "valid"), hostname),
      generateCertificateSet(join(stateDirectory, "alternate"), hostname),
      generateCertificateSet(
        join(stateDirectory, "wrong-hostname"),
        "unexpected.test",
      ),
      generateCertificateSet(
        join(stateDirectory, "wrong-usage"),
        hostname,
        false,
      ),
    ]);
  }, 20_000);

  afterAll(async () => {
    vi.useRealTimers();
    if (stateDirectory)
      await rm(stateDirectory, { recursive: true, force: true });
  });

  it("loads a matching CA, certificate, and private key with TLS 1.2 minimum", async () => {
    const options = await loadTlsServerOptions(tlsConfig(valid));
    expect(Buffer.isBuffer(options.cert)).toBe(true);
    expect(Buffer.isBuffer(options.key)).toBe(true);
    expect(options.minVersion).toBe("TLSv1.2");
  });

  it("fails clearly when a required file is missing", async () => {
    await expect(
      loadTlsServerOptions({
        ...tlsConfig(valid),
        tlsCertificateFile: join(stateDirectory, "missing.crt"),
      }),
    ).rejects.toThrow(/could not read server certificate.*npm run setup:tls/);
  });

  it("rejects malformed certificate PEM", async () => {
    const invalidCertificate = join(stateDirectory, "invalid.crt");
    await writeFile(invalidCertificate, "not a certificate\n");
    await expect(
      loadTlsServerOptions({
        ...tlsConfig(valid),
        tlsCertificateFile: invalidCertificate,
      }),
    ).rejects.toThrow(
      /server certificate is not a valid X.509 certificate.*npm run setup:tls/,
    );
  });

  it("rejects malformed private-key PEM", async () => {
    const invalidPrivateKey = join(stateDirectory, "invalid.key.pem");
    await writeFile(invalidPrivateKey, "not a private key\n");
    await expect(
      loadTlsServerOptions({
        ...tlsConfig(valid),
        tlsPrivateKeyFile: invalidPrivateKey,
      }),
    ).rejects.toThrow(/server private key is not valid PEM.*npm run setup:tls/);
  });

  it("rejects an expired server certificate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 2 * 24 * 60 * 60 * 1000);
    try {
      await expect(loadTlsServerOptions(tlsConfig(valid))).rejects.toThrow(
        /server certificate expired.*npm run setup:tls/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a certificate chain that is not valid yet", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() - 2 * 24 * 60 * 60 * 1000);
    try {
      await expect(loadTlsServerOptions(tlsConfig(valid))).rejects.toThrow(
        /CA certificate is not valid before.*npm run setup:tls/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires the issuer hostname in subjectAltName", async () => {
    await expect(
      loadTlsServerOptions(tlsConfig(wrongHostname)),
    ).rejects.toThrow(
      /subjectAltName must contain only DNS:mock-idp\.test.*npm run setup:tls/,
    );
  });

  it("requires the TLS server-authentication extended key usage", async () => {
    await expect(loadTlsServerOptions(tlsConfig(wrongUsage))).rejects.toThrow(
      /extendedKeyUsage does not allow TLS server authentication.*npm run setup:tls/,
    );
  });

  it("requires the configured CA to have signed the server certificate", async () => {
    await expect(
      loadTlsServerOptions({
        ...tlsConfig(valid),
        tlsCaCertificateFile: alternate.caCertificate,
      }),
    ).rejects.toThrow(/not signed by the configured CA.*npm run setup:tls/);
  });

  it("requires the private key to match the server certificate", async () => {
    await expect(
      loadTlsServerOptions({
        ...tlsConfig(valid),
        tlsPrivateKeyFile: alternate.privateKey,
      }),
    ).rejects.toThrow(
      /private key does not match the server certificate.*npm run setup:tls/,
    );
  });

  it("rejects a non-HTTPS issuer before loading credentials", async () => {
    await expect(
      loadTlsServerOptions(tlsConfig(valid, `http://${hostname}:9000`)),
    ).rejects.toBeInstanceOf(TlsSetupError);
    await expect(
      loadTlsServerOptions(tlsConfig(valid, `http://${hostname}:9000`)),
    ).rejects.toThrow(/valid HTTPS URL.*npm run setup:tls/);
  });
});
