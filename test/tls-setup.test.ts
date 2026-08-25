import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const executeFile = promisify(execFile);
const setupScript = fileURLToPath(
  new URL("../scripts/setup-tls.mjs", import.meta.url),
);
const expectedPublicFiles = ["ca.crt", "server.crt"];
const expectedPrivateFiles = ["ca.key.pem", "server.key.pem"];
const millisecondsPerDay = 24 * 60 * 60 * 1000;
const temporaryDirectories: string[] = [];

function privateDirectoryFor(outputDirectory: string): string {
  return `${outputDirectory}-private`;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mock-entra-tls-setup-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function run(
  executable: string,
  arguments_: string[],
  workingDirectory?: string,
): Promise<{ stdout: string; stderr: string }> {
  const result = await executeFile(executable, arguments_, {
    ...(workingDirectory ? { cwd: workingDirectory } : {}),
    encoding: "utf8",
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

async function runSetup(
  outputDirectory: string,
  ...additionalArguments: string[]
): Promise<{ stdout: string; stderr: string }> {
  return run(process.execPath, [
    setupScript,
    "--output-dir",
    outputDirectory,
    "--private-dir",
    privateDirectoryFor(outputDirectory),
    ...additionalArguments,
  ]);
}

async function rejectedMessage(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    if (!(error instanceof Error)) return String(error);
    const standardError = (error as Error & { stderr?: string }).stderr;
    return standardError?.trim() || error.message;
  }
  throw new Error("Expected operation to fail");
}

async function readBundle(
  outputDirectory: string,
): Promise<Map<string, Buffer>> {
  const privateDirectory = privateDirectoryFor(outputDirectory);
  return new Map(
    await Promise.all([
      ...expectedPublicFiles.map(
        async (fileName) =>
          [fileName, await readFile(join(outputDirectory, fileName))] as const,
      ),
      ...expectedPrivateFiles.map(
        async (fileName) =>
          [
            fileName,
            await readFile(join(privateDirectory, fileName)),
          ] as const,
      ),
    ]),
  );
}

function validityDays(certificate: X509Certificate): number {
  return (
    (certificate.validToDate.getTime() - certificate.validFromDate.getTime()) /
    millisecondsPerDay
  );
}

async function expectValidBundle(outputDirectory: string): Promise<void> {
  const privateDirectory = privateDirectoryFor(outputDirectory);
  expect((await readdir(outputDirectory)).sort()).toEqual(expectedPublicFiles);
  expect((await readdir(privateDirectory)).sort()).toEqual(
    expectedPrivateFiles,
  );

  const caCertificate = new X509Certificate(
    await readFile(join(outputDirectory, "ca.crt")),
  );
  const serverCertificate = new X509Certificate(
    await readFile(join(outputDirectory, "server.crt")),
  );
  expect(caCertificate.ca).toBe(true);
  expect(serverCertificate.ca).toBe(false);
  expect(caCertificate.publicKey.asymmetricKeyType).toBe("rsa");
  expect(serverCertificate.publicKey.asymmetricKeyType).toBe("rsa");
  expect(caCertificate.publicKey.asymmetricKeyDetails?.modulusLength).toBe(
    2048,
  );
  expect(serverCertificate.publicKey.asymmetricKeyDetails?.modulusLength).toBe(
    2048,
  );
  expect(validityDays(caCertificate)).toBe(3650);
  expect(validityDays(serverCertificate)).toBe(397);
  expect(serverCertificate.subjectAltName).toBe("DNS:mock-idp.test");
  expect(serverCertificate.checkHost("mock-idp.test")).toBe("mock-idp.test");
  expect(serverCertificate.verify(caCertificate.publicKey)).toBe(true);

  const [caText, serverText, verification] = await Promise.all([
    run("openssl", [
      "x509",
      "-in",
      join(outputDirectory, "ca.crt"),
      "-noout",
      "-text",
    ]),
    run("openssl", [
      "x509",
      "-in",
      join(outputDirectory, "server.crt"),
      "-noout",
      "-text",
    ]),
    run("openssl", [
      "verify",
      "-CAfile",
      join(outputDirectory, "ca.crt"),
      "-purpose",
      "sslserver",
      "-verify_hostname",
      "mock-idp.test",
      join(outputDirectory, "server.crt"),
    ]),
  ]);
  expect(caText.stdout).toMatch(
    /Signature Algorithm:\s*sha256WithRSAEncryption/,
  );
  expect(serverText.stdout).toMatch(
    /Signature Algorithm:\s*sha256WithRSAEncryption/,
  );
  expect(verification.stdout).toContain("server.crt: OK");

  if (process.platform !== "win32") {
    expect((await stat(privateDirectory)).mode & 0o777).toBe(0o700);
    expect(
      (await stat(join(privateDirectory, "ca.key.pem"))).mode & 0o777,
    ).toBe(0o600);
    expect(
      (await stat(join(privateDirectory, "server.key.pem"))).mode & 0o777,
    ).toBe(0o600);
  }
}

async function replaceServerCertificate(
  rootDirectory: string,
  outputDirectory: string,
  days: number,
): Promise<void> {
  const privateDirectory = privateDirectoryFor(outputDirectory);
  const workingDirectory = join(rootDirectory, `replacement-server-${days}`);
  await mkdir(workingDirectory);
  const extensionFile = join(workingDirectory, "server-extensions.cnf");
  await writeFile(
    extensionFile,
    `subjectKeyIdentifier = hash\n` +
      `authorityKeyIdentifier = keyid,issuer\n` +
      `basicConstraints = critical,CA:false\n` +
      `keyUsage = critical,digitalSignature,keyEncipherment\n` +
      `extendedKeyUsage = serverAuth\n` +
      `subjectAltName = DNS:mock-idp.test\n`,
  );
  await run("openssl", [
    "genpkey",
    "-algorithm",
    "RSA",
    "-pkeyopt",
    "rsa_keygen_bits:2048",
    "-out",
    join(workingDirectory, "server.key.pem"),
  ]);
  await run("openssl", [
    "req",
    "-new",
    "-key",
    join(workingDirectory, "server.key.pem"),
    "-out",
    join(workingDirectory, "server.csr.pem"),
    "-sha256",
    "-subj",
    "/CN=mock-idp.test",
  ]);
  await run("openssl", [
    "x509",
    "-req",
    "-in",
    join(workingDirectory, "server.csr.pem"),
    "-CA",
    join(outputDirectory, "ca.crt"),
    "-CAkey",
    join(privateDirectory, "ca.key.pem"),
    "-set_serial",
    "0x1234",
    "-out",
    join(workingDirectory, "server.crt"),
    "-days",
    String(days),
    "-sha256",
    "-extfile",
    extensionFile,
  ]);
  await Promise.all([
    copyFile(
      join(workingDirectory, "server.crt"),
      join(outputDirectory, "server.crt"),
    ),
    copyFile(
      join(workingDirectory, "server.key.pem"),
      join(privateDirectory, "server.key.pem"),
    ),
  ]);
  await Promise.all([
    chmod(join(outputDirectory, "server.crt"), 0o644),
    chmod(join(privateDirectory, "server.key.pem"), 0o600),
  ]);
}

async function replaceWithExpiringCa(
  rootDirectory: string,
  outputDirectory: string,
): Promise<void> {
  const privateDirectory = privateDirectoryFor(outputDirectory);
  const workingDirectory = join(rootDirectory, "replacement-ca");
  await mkdir(workingDirectory);
  const caConfiguration = join(workingDirectory, "ca.cnf");
  await writeFile(
    caConfiguration,
    `[req]\n` +
      `prompt = no\n` +
      `distinguished_name = distinguished_name\n` +
      `x509_extensions = ca_extensions\n` +
      `default_md = sha256\n` +
      `\n[distinguished_name]\n` +
      `CN = Expiring Mock Entra OIDC Root CA\n` +
      `\n[ca_extensions]\n` +
      `subjectKeyIdentifier = hash\n` +
      `authorityKeyIdentifier = keyid:always,issuer\n` +
      `basicConstraints = critical,CA:true,pathlen:0\n` +
      `keyUsage = critical,keyCertSign,cRLSign\n`,
  );
  await run("openssl", [
    "genpkey",
    "-algorithm",
    "RSA",
    "-pkeyopt",
    "rsa_keygen_bits:2048",
    "-out",
    join(workingDirectory, "ca.key.pem"),
  ]);
  await run("openssl", [
    "req",
    "-new",
    "-x509",
    "-key",
    join(workingDirectory, "ca.key.pem"),
    "-out",
    join(workingDirectory, "ca.crt"),
    "-days",
    "396",
    "-sha256",
    "-config",
    caConfiguration,
  ]);
  await Promise.all([
    copyFile(join(workingDirectory, "ca.crt"), join(outputDirectory, "ca.crt")),
    copyFile(
      join(workingDirectory, "ca.key.pem"),
      join(privateDirectory, "ca.key.pem"),
    ),
  ]);
  await Promise.all([
    chmod(join(outputDirectory, "ca.crt"), 0o644),
    chmod(join(privateDirectory, "ca.key.pem"), 0o600),
  ]);
  await replaceServerCertificate(rootDirectory, outputDirectory, 397);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("TLS setup script", () => {
  it("creates the public/private bundle in the default directories and is idempotent", async () => {
    const workingDirectory = await temporaryDirectory();
    const outputDirectory = join(workingDirectory, ".data", "tls");

    const created = await run(
      process.execPath,
      [setupScript],
      workingDirectory,
    );
    expect(created.stdout).toContain("Created local TLS CA");
    await expectValidBundle(outputDirectory);
    const caCertificate = new X509Certificate(
      await readFile(join(outputDirectory, "ca.crt")),
    );
    expect(created.stdout).toContain(
      `CA SHA-256 fingerprint: ${caCertificate.fingerprint256}`,
    );

    const before = await readBundle(outputDirectory);
    const repeated = await run(
      process.execPath,
      [setupScript],
      workingDirectory,
    );
    expect(repeated.stdout).toContain("no changes were made");
    expect(repeated.stdout).toContain(
      `CA SHA-256 fingerprint: ${caCertificate.fingerprint256}`,
    );
    expect(await readBundle(outputDirectory)).toEqual(before);
  });

  it("renews only the server certificate pair when fewer than 30 days remain", async () => {
    const rootDirectory = await temporaryDirectory();
    const outputDirectory = join(rootDirectory, "tls");
    await runSetup(outputDirectory);
    await replaceServerCertificate(rootDirectory, outputDirectory, 29);
    const before = await readBundle(outputDirectory);

    const renewed = await runSetup(outputDirectory);

    expect(renewed.stdout).toContain("Renewed the server certificate");
    const after = await readBundle(outputDirectory);
    expect(after.get("ca.crt")).toEqual(before.get("ca.crt"));
    expect(after.get("ca.key.pem")).toEqual(before.get("ca.key.pem"));
    expect(after.get("server.crt")).not.toEqual(before.get("server.crt"));
    expect(after.get("server.key.pem")).not.toEqual(
      before.get("server.key.pem"),
    );
    const renewedCaCertificate = new X509Certificate(after.get("ca.crt")!);
    expect(renewed.stdout).toContain(
      `CA SHA-256 fingerprint: ${renewedCaCertificate.fingerprint256}`,
    );
    await expectValidBundle(outputDirectory);
  });

  it("recovers an expired server certificate using the still-valid CA", async () => {
    const rootDirectory = await temporaryDirectory();
    const outputDirectory = join(rootDirectory, "tls");
    await runSetup(outputDirectory);
    await replaceServerCertificate(rootDirectory, outputDirectory, 0);
    const before = await readBundle(outputDirectory);

    const renewed = await runSetup(outputDirectory);

    expect(renewed.stdout).toContain("Renewed the server certificate");
    const after = await readBundle(outputDirectory);
    expect(after.get("ca.crt")).toEqual(before.get("ca.crt"));
    expect(after.get("ca.key.pem")).toEqual(before.get("ca.key.pem"));
    expect(after.get("server.crt")).not.toEqual(before.get("server.crt"));
    expect(after.get("server.key.pem")).not.toEqual(
      before.get("server.key.pem"),
    );
    await expectValidBundle(outputDirectory);
  });

  it("requires CA rotation before the CA has 397 days or less remaining", async () => {
    const rootDirectory = await temporaryDirectory();
    const outputDirectory = join(rootDirectory, "tls");
    await runSetup(outputDirectory);
    await replaceWithExpiringCa(rootDirectory, outputDirectory);
    const before = await readBundle(outputDirectory);

    const message = await rejectedMessage(runSetup(outputDirectory));

    expect(message).toContain("CA expires too soon");
    expect(message).toContain("--rotate-ca");
    expect(await readBundle(outputDirectory)).toEqual(before);

    const rotated = await runSetup(outputDirectory, "--rotate-ca");
    expect(rotated.stdout).toContain("Rotated the local TLS CA");
    await expectValidBundle(outputDirectory);
  });

  it("rotates a complete valid CA only when explicitly requested", async () => {
    const rootDirectory = await temporaryDirectory();
    const outputDirectory = join(rootDirectory, "tls");
    await runSetup(outputDirectory);
    const before = await readBundle(outputDirectory);
    const oldCaCertificate = new X509Certificate(before.get("ca.crt")!);

    const rotated = await runSetup(outputDirectory, "--rotate-ca");

    expect(rotated.stdout).toContain("Rotated the local TLS CA");
    const after = await readBundle(outputDirectory);
    const newCaCertificate = new X509Certificate(after.get("ca.crt")!);
    expect(rotated.stdout).toContain(
      `Old CA SHA-256 fingerprint: ${oldCaCertificate.fingerprint256}`,
    );
    expect(rotated.stdout).toContain(
      `New CA SHA-256 fingerprint: ${newCaCertificate.fingerprint256}`,
    );
    expect(newCaCertificate.fingerprint256).not.toBe(
      oldCaCertificate.fingerprint256,
    );
    for (const fileName of [...expectedPublicFiles, ...expectedPrivateFiles])
      expect(after.get(fileName)).not.toEqual(before.get(fileName));
    await expectValidBundle(outputDirectory);
  });

  it("fails without changing a partial setup", async () => {
    const rootDirectory = await temporaryDirectory();
    const outputDirectory = join(rootDirectory, "tls");
    await mkdir(outputDirectory);
    await writeFile(join(outputDirectory, "ca.crt"), "partial setup\n");

    const message = await rejectedMessage(runSetup(outputDirectory));

    expect(message).toContain("partial");
    expect(await readdir(outputDirectory)).toEqual(["ca.crt"]);
    expect(await readFile(join(outputDirectory, "ca.crt"), "utf8")).toBe(
      "partial setup\n",
    );
  });

  it("fails without changing an invalid setup, including with --rotate-ca", async () => {
    const rootDirectory = await temporaryDirectory();
    const outputDirectory = join(rootDirectory, "tls");
    await runSetup(outputDirectory);
    await writeFile(
      join(outputDirectory, "server.crt"),
      "invalid certificate\n",
    );
    const invalidBundle = await readBundle(outputDirectory);

    const normalMessage = await rejectedMessage(runSetup(outputDirectory));
    expect(normalMessage).toContain("TLS setup is invalid");
    expect(await readBundle(outputDirectory)).toEqual(invalidBundle);

    const rotationMessage = await rejectedMessage(
      runSetup(outputDirectory, "--rotate-ca"),
    );
    expect(rotationMessage).toContain("TLS setup is invalid");
    expect(await readBundle(outputDirectory)).toEqual(invalidBundle);
  });

  it("fails without changing an inconsistent public/private state", async () => {
    const rootDirectory = await temporaryDirectory();
    const outputDirectory = join(rootDirectory, "tls");
    const privateDirectory = privateDirectoryFor(outputDirectory);
    await runSetup(outputDirectory);
    await rm(privateDirectory, { recursive: true, force: true });
    const remainingPublicFiles = await readdir(outputDirectory);

    const message = await rejectedMessage(runSetup(outputDirectory));

    expect(message).toContain("inconsistent");
    expect(await readdir(outputDirectory)).toEqual(remainingPublicFiles);
    await expect(stat(privateDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails without changes when the sibling setup lock already exists", async () => {
    const rootDirectory = await temporaryDirectory();
    const outputDirectory = join(rootDirectory, "tls");
    const lockDirectory = `${outputDirectory}.setup.lock`;
    await runSetup(outputDirectory);
    const before = await readBundle(outputDirectory);
    await mkdir(lockDirectory);

    const normalMessage = await rejectedMessage(runSetup(outputDirectory));
    expect(normalMessage).toContain("setup lock already exists");
    expect(normalMessage).toContain("sibling backup/staging artifacts");
    expect(normalMessage).toContain("removing the stale lock manually");
    expect(await readBundle(outputDirectory)).toEqual(before);

    const rotationMessage = await rejectedMessage(
      runSetup(outputDirectory, "--rotate-ca"),
    );
    expect(rotationMessage).toContain("setup lock already exists");
    expect(await readBundle(outputDirectory)).toEqual(before);
    expect(await stat(lockDirectory)).toBeDefined();
  });

  it("refuses to generate a new CA while interrupted-install artifacts exist", async () => {
    const rootDirectory = await temporaryDirectory();
    const outputDirectory = join(rootDirectory, "tls");
    const backupDirectory = `${outputDirectory}.backup-123-recovery`;
    await mkdir(backupDirectory);
    await writeFile(join(backupDirectory, "marker"), "preserve me\n");

    const message = await rejectedMessage(runSetup(outputDirectory));

    expect(message).toContain("recovery artifacts exist");
    expect(message).toContain("Refusing to generate a new CA");
    expect(message).toContain(backupDirectory);
    expect(await readFile(join(backupDirectory, "marker"), "utf8")).toBe(
      "preserve me\n",
    );
    await expect(stat(outputDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
