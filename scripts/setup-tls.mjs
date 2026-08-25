#!/usr/bin/env node

import { Buffer } from "node:buffer";
import {
  randomBytes,
  randomUUID,
  X509Certificate,
  createPrivateKey,
} from "node:crypto";
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

process.umask(0o077);

const serverName = "mock-idp.test";
const caValidityDays = 3650;
const serverValidityDays = 397;
const renewalThresholdDays = 30;
const millisecondsPerDay = 24 * 60 * 60 * 1000;

const fileNames = Object.freeze({
  caCertificate: "ca.crt",
  caPrivateKey: "ca.key.pem",
  serverCertificate: "server.crt",
  serverPrivateKey: "server.key.pem",
});
const expectedFileNames = Object.freeze(Object.values(fileNames).sort());

function writeStandardOutput(message) {
  writeSync(process.stdout.fd, message);
}

function writeStandardError(message) {
  writeSync(process.stderr.fd, message);
}

function fingerprintLine(certificate, prefix = "CA SHA-256 fingerprint") {
  return `${prefix}: ${certificate.fingerprint256}\n`;
}

function usage() {
  return [
    "Usage: node scripts/setup-tls.mjs [--output-dir <directory>] [--rotate-ca]",
    "",
    "Options:",
    "  --output-dir <directory>  Output directory (default: .data/tls)",
    "  --rotate-ca               Replace an existing valid CA and server certificate",
    "  --help                    Show this help",
  ].join("\n");
}

function parseArguments(arguments_) {
  let outputDirectory = resolve(".data/tls");
  let rotateCa = false;
  let outputDirectorySeen = false;

  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === "--help") return { help: true, outputDirectory, rotateCa };
    if (argument === "--rotate-ca") {
      if (rotateCa) throw new Error("--rotate-ca may only be specified once");
      rotateCa = true;
      continue;
    }
    if (argument === "--output-dir") {
      if (outputDirectorySeen)
        throw new Error("--output-dir may only be specified once");
      const value = arguments_[++index];
      if (!value || value.startsWith("--"))
        throw new Error("--output-dir requires a directory");
      outputDirectory = resolve(value);
      outputDirectorySeen = true;
      continue;
    }
    if (argument?.startsWith("--output-dir=")) {
      if (outputDirectorySeen)
        throw new Error("--output-dir may only be specified once");
      const value = argument.slice("--output-dir=".length);
      if (!value) throw new Error("--output-dir requires a directory");
      outputDirectory = resolve(value);
      outputDirectorySeen = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return { help: false, outputDirectory, rotateCa };
}

function runOpenSsl(arguments_, workingDirectory) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("openssl", arguments_, {
      cwd: workingDirectory,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const standardOutput = [];
    const standardError = [];
    child.stdout.on("data", (chunk) => standardOutput.push(chunk));
    child.stderr.on("data", (chunk) => standardError.push(chunk));
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        rejectPromise(
          new Error(
            "OpenSSL was not found. Install OpenSSL and retry TLS setup.",
          ),
        );
        return;
      }
      rejectPromise(error);
    });
    child.on("close", (code) => {
      const output = Buffer.concat(standardOutput).toString("utf8").trim();
      const errorOutput = Buffer.concat(standardError).toString("utf8").trim();
      if (code === 0) {
        resolvePromise(output);
        return;
      }
      rejectPromise(
        new Error(
          `OpenSSL failed (${arguments_[0] ?? "command"}, exit ${String(code)}): ${
            errorOutput || output || "no diagnostic output"
          }`,
        ),
      );
    });
  });
}

async function pathState(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function inspectOutputDirectory(outputDirectory) {
  const outputState = await pathState(outputDirectory);
  if (!outputState) return "empty";
  if (!outputState.isDirectory())
    throw new Error(`TLS output path is not a directory: ${outputDirectory}`);

  const entries = (await readdir(outputDirectory)).sort();
  if (entries.length === 0) return "empty-directory";
  if (
    entries.length !== expectedFileNames.length ||
    entries.some((entry, index) => entry !== expectedFileNames[index])
  ) {
    const expected = expectedFileNames.join(", ");
    const actual = entries.length === 0 ? "(empty)" : entries.join(", ");
    throw new Error(
      `TLS setup is partial or contains unexpected files. Expected exactly [${expected}], found [${actual}]. No files were changed.`,
    );
  }

  for (const fileName of expectedFileNames) {
    const fileState = await lstat(join(outputDirectory, fileName));
    if (!fileState.isFile())
      throw new Error(
        `TLS setup is invalid: ${fileName} must be a regular file. No files were changed.`,
      );
  }
  return "complete";
}

async function findRecoveryArtifacts(outputDirectory) {
  const parentDirectory = dirname(outputDirectory);
  const outputName = basename(outputDirectory);
  const backupPrefix = `${outputName}.backup-`;
  const stagingPrefix = `.${outputName}-setup-`;
  const entries = await readdir(parentDirectory);
  return entries
    .filter(
      (entry) =>
        entry.startsWith(backupPrefix) || entry.startsWith(stagingPrefix),
    )
    .sort()
    .map((entry) => join(parentDirectory, entry));
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function assertCertificateValidity(
  certificate,
  label,
  { allowExpired = false } = {},
) {
  const now = Date.now();
  assertCondition(
    certificate.validFromDate.getTime() <= now,
    `${label} is not valid yet`,
  );
  const expired = certificate.validToDate.getTime() <= now;
  assertCondition(allowExpired || !expired, `${label} has expired`);
  return expired;
}

function assertRsa2048(publicOrPrivateKey, label) {
  assertCondition(
    publicOrPrivateKey.asymmetricKeyType === "rsa",
    `${label} must use RSA`,
  );
  assertCondition(
    publicOrPrivateKey.asymmetricKeyDetails?.modulusLength === 2048,
    `${label} must use a 2048-bit RSA key`,
  );
}

async function assertPrivatePermissions(path, label) {
  if (process.platform === "win32") return;
  const mode = (await lstat(path)).mode & 0o777;
  assertCondition(mode === 0o600, `${label} permissions must be 0600`);
}

async function assertDirectoryPermissions(path) {
  if (process.platform === "win32") return;
  const mode = (await lstat(path)).mode & 0o777;
  assertCondition(
    mode === 0o700,
    "TLS output directory permissions must be 0700",
  );
}

async function assertPublicPermissions(path, label) {
  if (process.platform === "win32") return;
  const mode = (await lstat(path)).mode & 0o777;
  assertCondition(mode === 0o644, `${label} permissions must be 0644`);
}

function assertExpectedExtensions(caText, serverText) {
  assertCondition(
    /Signature Algorithm:\s*sha256WithRSAEncryption/.test(caText),
    "CA certificate must use an RSA SHA-256 signature",
  );
  assertCondition(
    /Signature Algorithm:\s*sha256WithRSAEncryption/.test(serverText),
    "Server certificate must use an RSA SHA-256 signature",
  );
  assertCondition(
    /X509v3 Basic Constraints: critical\s+CA:TRUE, pathlen:0/.test(caText),
    "CA certificate must have critical CA:TRUE, pathlen:0 constraints",
  );
  assertCondition(
    /X509v3 Key Usage: critical\s+Certificate Sign, CRL Sign/.test(caText),
    "CA certificate has invalid key usage",
  );
  assertCondition(
    /X509v3 Basic Constraints: critical\s+CA:FALSE/.test(serverText),
    "Server certificate must have critical CA:FALSE constraints",
  );
  assertCondition(
    /X509v3 Key Usage: critical\s+Digital Signature, Key Encipherment/.test(
      serverText,
    ),
    "Server certificate has invalid key usage",
  );
  assertCondition(
    /X509v3 Extended Key Usage:\s+TLS Web Server Authentication/.test(
      serverText,
    ),
    "Server certificate must be valid for TLS server authentication",
  );
}

async function validateBundle(directory, { allowExpiredServer = false } = {}) {
  const paths = {
    caCertificate: join(directory, fileNames.caCertificate),
    caPrivateKey: join(directory, fileNames.caPrivateKey),
    serverCertificate: join(directory, fileNames.serverCertificate),
    serverPrivateKey: join(directory, fileNames.serverPrivateKey),
  };
  const [
    caCertificatePem,
    caPrivateKeyPem,
    serverCertificatePem,
    serverPrivateKeyPem,
  ] = await Promise.all([
    readFile(paths.caCertificate),
    readFile(paths.caPrivateKey),
    readFile(paths.serverCertificate),
    readFile(paths.serverPrivateKey),
  ]);

  const caCertificate = new X509Certificate(caCertificatePem);
  const serverCertificate = new X509Certificate(serverCertificatePem);
  const caPrivateKey = createPrivateKey(caPrivateKeyPem);
  const serverPrivateKey = createPrivateKey(serverPrivateKeyPem);

  assertCertificateValidity(caCertificate, "CA certificate");
  const serverExpired = assertCertificateValidity(
    serverCertificate,
    "Server certificate",
    { allowExpired: allowExpiredServer },
  );
  assertCondition(caCertificate.ca, "CA certificate must be a CA");
  assertCondition(!serverCertificate.ca, "Server certificate must not be a CA");
  assertCondition(
    caCertificate.subject === caCertificate.issuer &&
      caCertificate.verify(caCertificate.publicKey),
    "CA certificate must be self-signed",
  );
  assertCondition(
    serverCertificate.checkIssued(caCertificate) &&
      serverCertificate.verify(caCertificate.publicKey),
    "Server certificate was not issued by the configured CA",
  );
  assertCondition(
    serverCertificate.subjectAltName === `DNS:${serverName}`,
    `Server certificate SAN must contain only DNS:${serverName}`,
  );
  assertCondition(
    serverCertificate.checkHost(serverName) === serverName,
    `Server certificate does not match ${serverName}`,
  );
  assertRsa2048(caCertificate.publicKey, "CA certificate public key");
  assertRsa2048(serverCertificate.publicKey, "Server certificate public key");
  assertRsa2048(caPrivateKey, "CA private key");
  assertRsa2048(serverPrivateKey, "Server private key");
  assertCondition(
    caCertificate.checkPrivateKey(caPrivateKey),
    "CA certificate and private key do not match",
  );
  assertCondition(
    serverCertificate.checkPrivateKey(serverPrivateKey),
    "Server certificate and private key do not match",
  );

  const [caText, serverText] = await Promise.all([
    runOpenSsl(["x509", "-in", paths.caCertificate, "-noout", "-text"]),
    runOpenSsl(["x509", "-in", paths.serverCertificate, "-noout", "-text"]),
  ]);
  assertExpectedExtensions(caText, serverText);
  const verificationArguments = [
    "verify",
    "-CAfile",
    paths.caCertificate,
    "-purpose",
    "sslserver",
    "-verify_hostname",
    serverName,
  ];
  if (serverExpired) verificationArguments.push("-no_check_time");
  verificationArguments.push(paths.serverCertificate);
  await runOpenSsl(verificationArguments);

  await Promise.all([
    assertDirectoryPermissions(directory),
    assertPrivatePermissions(paths.caPrivateKey, "CA private key"),
    assertPrivatePermissions(paths.serverPrivateKey, "Server private key"),
    assertPublicPermissions(paths.caCertificate, "CA certificate"),
    assertPublicPermissions(paths.serverCertificate, "Server certificate"),
  ]);

  return { caCertificate, serverCertificate };
}

async function writeGenerationConfiguration(directory) {
  await Promise.all([
    writeFile(
      join(directory, "ca.cnf"),
      `[req]\n` +
        `prompt = no\n` +
        `distinguished_name = distinguished_name\n` +
        `x509_extensions = ca_extensions\n` +
        `default_md = sha256\n` +
        `\n[distinguished_name]\n` +
        `CN = Mock Entra OIDC Local Development Root CA\n` +
        `\n[ca_extensions]\n` +
        `subjectKeyIdentifier = hash\n` +
        `authorityKeyIdentifier = keyid:always,issuer\n` +
        `basicConstraints = critical,CA:true,pathlen:0\n` +
        `keyUsage = critical,keyCertSign,cRLSign\n`,
      { mode: 0o600 },
    ),
    writeFile(
      join(directory, "server-request.cnf"),
      `[req]\n` +
        `prompt = no\n` +
        `distinguished_name = distinguished_name\n` +
        `default_md = sha256\n` +
        `\n[distinguished_name]\n` +
        `CN = ${serverName}\n`,
      { mode: 0o600 },
    ),
    writeFile(
      join(directory, "server-extensions.cnf"),
      `subjectKeyIdentifier = hash\n` +
        `authorityKeyIdentifier = keyid,issuer\n` +
        `basicConstraints = critical,CA:false\n` +
        `keyUsage = critical,digitalSignature,keyEncipherment\n` +
        `extendedKeyUsage = serverAuth\n` +
        `subjectAltName = DNS:${serverName}\n`,
      { mode: 0o600 },
    ),
  ]);
}

async function generateCa(directory) {
  await runOpenSsl(
    [
      "genpkey",
      "-algorithm",
      "RSA",
      "-pkeyopt",
      "rsa_keygen_bits:2048",
      "-out",
      fileNames.caPrivateKey,
    ],
    directory,
  );
  await runOpenSsl(
    [
      "req",
      "-new",
      "-x509",
      "-key",
      fileNames.caPrivateKey,
      "-out",
      fileNames.caCertificate,
      "-days",
      String(caValidityDays),
      "-sha256",
      "-config",
      "ca.cnf",
    ],
    directory,
  );
}

async function generateServerCertificate(directory) {
  await runOpenSsl(
    [
      "genpkey",
      "-algorithm",
      "RSA",
      "-pkeyopt",
      "rsa_keygen_bits:2048",
      "-out",
      fileNames.serverPrivateKey,
    ],
    directory,
  );
  await runOpenSsl(
    [
      "req",
      "-new",
      "-key",
      fileNames.serverPrivateKey,
      "-out",
      "server.csr.pem",
      "-sha256",
      "-config",
      "server-request.cnf",
    ],
    directory,
  );
  await runOpenSsl(
    [
      "x509",
      "-req",
      "-in",
      "server.csr.pem",
      "-CA",
      fileNames.caCertificate,
      "-CAkey",
      fileNames.caPrivateKey,
      "-set_serial",
      `0x${randomBytes(16).toString("hex")}`,
      "-out",
      fileNames.serverCertificate,
      "-days",
      String(serverValidityDays),
      "-sha256",
      "-extfile",
      "server-extensions.cnf",
    ],
    directory,
  );
}

async function prepareBundle(
  stagingDirectory,
  existingDirectory,
  includeNewCa,
) {
  await writeGenerationConfiguration(stagingDirectory);
  if (includeNewCa) {
    await generateCa(stagingDirectory);
  } else {
    await Promise.all([
      copyFile(
        join(existingDirectory, fileNames.caCertificate),
        join(stagingDirectory, fileNames.caCertificate),
      ),
      copyFile(
        join(existingDirectory, fileNames.caPrivateKey),
        join(stagingDirectory, fileNames.caPrivateKey),
      ),
    ]);
  }
  await generateServerCertificate(stagingDirectory);

  await Promise.all([
    chmod(join(stagingDirectory, fileNames.caCertificate), 0o644),
    chmod(join(stagingDirectory, fileNames.caPrivateKey), 0o600),
    chmod(join(stagingDirectory, fileNames.serverCertificate), 0o644),
    chmod(join(stagingDirectory, fileNames.serverPrivateKey), 0o600),
  ]);
  await Promise.all([
    rm(join(stagingDirectory, "ca.cnf"), { force: true }),
    rm(join(stagingDirectory, "server-request.cnf"), { force: true }),
    rm(join(stagingDirectory, "server-extensions.cnf"), { force: true }),
    rm(join(stagingDirectory, "server.csr.pem"), { force: true }),
  ]);
  await validateBundle(stagingDirectory);
}

async function installBundle(stagingDirectory, outputDirectory, outputExists) {
  if (!outputExists) {
    await rename(stagingDirectory, outputDirectory);
    return;
  }

  const backupDirectory = `${outputDirectory}.backup-${process.pid}-${randomUUID()}`;
  await rename(outputDirectory, backupDirectory);
  try {
    await rename(stagingDirectory, outputDirectory);
  } catch (error) {
    await rename(backupDirectory, outputDirectory);
    throw error;
  }
  try {
    await rm(backupDirectory, { recursive: true, force: true });
  } catch (error) {
    writeStandardError(
      `TLS setup succeeded, but the backup could not be removed (${backupDirectory}): ${error.message}\n`,
    );
  }
}

async function generateAndInstall(
  outputDirectory,
  existingDirectory,
  includeNewCa,
) {
  const parentDirectory = dirname(outputDirectory);
  await mkdir(parentDirectory, { recursive: true });
  const stagingDirectory = await mkdtemp(
    join(parentDirectory, `.${basename(outputDirectory)}-setup-`),
  );
  try {
    await chmod(stagingDirectory, 0o700);
    await prepareBundle(stagingDirectory, existingDirectory, includeNewCa);
    await installBundle(
      stagingDirectory,
      outputDirectory,
      Boolean(existingDirectory),
    );
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

async function acquireSetupLock(outputDirectory) {
  await mkdir(dirname(outputDirectory), { recursive: true });
  const lockDirectory = `${outputDirectory}.setup.lock`;
  try {
    await mkdir(lockDirectory, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        `TLS setup lock already exists at ${lockDirectory}. Another setup may be running, or a previous process may have stopped unexpectedly. Verify that no setup process is running and inspect ${outputDirectory} plus sibling backup/staging artifacts before removing the stale lock manually. Do not remove only the lock and rerun if the output directory is missing. No TLS files were changed.`,
      );
    throw error;
  }
  return lockDirectory;
}

async function performSetup(options) {
  let state;
  try {
    state = await inspectOutputDirectory(options.outputDirectory);
  } catch (error) {
    throw new Error(`TLS setup failed: ${error.message}`);
  }

  if (state === "empty" || state === "empty-directory") {
    const recoveryArtifacts = await findRecoveryArtifacts(
      options.outputDirectory,
    );
    if (recoveryArtifacts.length > 0)
      throw new Error(
        `TLS setup recovery artifacts exist: ${recoveryArtifacts.join(
          ", ",
        )}. Refusing to generate a new CA. Inspect the artifacts and restore a valid backup to ${options.outputDirectory}, or remove artifacts only after confirming that no established CA would be lost. No files were changed.`,
      );
    await generateAndInstall(
      options.outputDirectory,
      state === "empty-directory" ? options.outputDirectory : undefined,
      true,
    );
    const { caCertificate } = await validateBundle(options.outputDirectory);
    writeStandardOutput(
      `Created local TLS CA and server certificate in ${options.outputDirectory}.\n` +
        fingerprintLine(caCertificate) +
        `Trust ${join(options.outputDirectory, fileNames.caCertificate)} on each client; never share ${fileNames.caPrivateKey}.\n`,
    );
    return;
  }

  let certificates;
  try {
    certificates = await validateBundle(options.outputDirectory, {
      allowExpiredServer: true,
    });
  } catch (error) {
    throw new Error(
      `TLS setup is invalid: ${error.message}. No files were changed; move or remove the invalid directory explicitly before regenerating.`,
    );
  }

  if (options.rotateCa) {
    const oldFingerprint = certificates.caCertificate.fingerprint256;
    await generateAndInstall(
      options.outputDirectory,
      options.outputDirectory,
      true,
    );
    const { caCertificate } = await validateBundle(options.outputDirectory);
    writeStandardOutput(
      `Rotated the local TLS CA and server certificate in ${options.outputDirectory}.\n` +
        `Old CA SHA-256 fingerprint: ${oldFingerprint}\n` +
        fingerprintLine(caCertificate, "New CA SHA-256 fingerprint") +
        `Re-register ${fileNames.caCertificate} on every client.\n`,
    );
    return;
  }

  const caRemainingMilliseconds =
    certificates.caCertificate.validToDate.getTime() - Date.now();
  if (caRemainingMilliseconds <= serverValidityDays * millisecondsPerDay) {
    throw new Error(
      `The CA expires too soon to issue a ${serverValidityDays}-day server certificate. Run with --rotate-ca and re-register the new ${fileNames.caCertificate}.`,
    );
  }
  const remainingMilliseconds =
    certificates.serverCertificate.validToDate.getTime() - Date.now();
  if (remainingMilliseconds >= renewalThresholdDays * millisecondsPerDay) {
    writeStandardOutput(
      `TLS certificates in ${options.outputDirectory} are valid; no changes were made.\n` +
        fingerprintLine(certificates.caCertificate),
    );
    return;
  }

  await generateAndInstall(
    options.outputDirectory,
    options.outputDirectory,
    false,
  );
  const { caCertificate } = await validateBundle(options.outputDirectory);
  writeStandardOutput(
    `Renewed the server certificate in ${options.outputDirectory} using the existing local CA.\n` +
      fingerprintLine(caCertificate),
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    writeStandardOutput(`${usage()}\n`);
    return;
  }

  await runOpenSsl(["version"]);
  const lockDirectory = await acquireSetupLock(options.outputDirectory);
  try {
    await performSetup(options);
  } finally {
    await rmdir(lockDirectory);
  }
}

try {
  await main();
} catch (error) {
  writeStandardError(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
