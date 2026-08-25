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

// Public certificates are written to --output-dir, which is typically
// bind-mounted from the host so browsers/tools can trust `ca.crt` directly.
// Windows Docker Desktop bind mounts cannot reliably preserve POSIX
// permissions, so private keys are written to the independent --private-dir
// instead, backed by a Docker named volume where strict 0700/0600
// permissions can be enforced.
const publicFileNames = Object.freeze({
  caCertificate: "ca.crt",
  serverCertificate: "server.crt",
});
const privateFileNames = Object.freeze({
  caPrivateKey: "ca.key.pem",
  serverPrivateKey: "server.key.pem",
});
const expectedPublicFileNames = Object.freeze(
  Object.values(publicFileNames).sort(),
);
const expectedPrivateFileNames = Object.freeze(
  Object.values(privateFileNames).sort(),
);

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
    "Usage: node scripts/setup-tls.mjs [--output-dir <directory>] [--private-dir <directory>] [--rotate-ca]",
    "",
    "Options:",
    "  --output-dir <directory>   Public certificate directory (default: .data/tls)",
    "  --private-dir <directory>  Private key directory (default: .data/tls-private)",
    "  --rotate-ca                Replace an existing valid CA and server certificate",
    "  --help                     Show this help",
  ].join("\n");
}

function parseDirectoryOption(
  arguments_,
  index,
  flagName,
  seenFlags,
  currentValue,
) {
  const argument = arguments_[index];
  if (argument === flagName) {
    if (seenFlags.has(flagName))
      throw new Error(`${flagName} may only be specified once`);
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`${flagName} requires a directory`);
    seenFlags.add(flagName);
    return { value: resolve(value), consumed: 2 };
  }
  if (argument?.startsWith(`${flagName}=`)) {
    if (seenFlags.has(flagName))
      throw new Error(`${flagName} may only be specified once`);
    const value = argument.slice(`${flagName}=`.length);
    if (!value) throw new Error(`${flagName} requires a directory`);
    seenFlags.add(flagName);
    return { value: resolve(value), consumed: 1 };
  }
  return { value: currentValue, consumed: 0 };
}

function parseArguments(arguments_) {
  let outputDirectory = resolve(".data/tls");
  let privateDirectory = resolve(".data/tls-private");
  let rotateCa = false;
  const seenFlags = new Set();

  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === "--help")
      return { help: true, outputDirectory, privateDirectory, rotateCa };
    if (argument === "--rotate-ca") {
      if (rotateCa) throw new Error("--rotate-ca may only be specified once");
      rotateCa = true;
      continue;
    }

    const outputResult = parseDirectoryOption(
      arguments_,
      index,
      "--output-dir",
      seenFlags,
      outputDirectory,
    );
    if (outputResult.consumed > 0) {
      outputDirectory = outputResult.value;
      index += outputResult.consumed - 1;
      continue;
    }

    const privateResult = parseDirectoryOption(
      arguments_,
      index,
      "--private-dir",
      seenFlags,
      privateDirectory,
    );
    if (privateResult.consumed > 0) {
      privateDirectory = privateResult.value;
      index += privateResult.consumed - 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return { help: false, outputDirectory, privateDirectory, rotateCa };
}

function runOpenSsl(arguments_) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("openssl", arguments_, {
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

async function inspectDirectory(directory, expectedNames) {
  const state = await pathState(directory);
  if (!state) return "empty";
  if (!state.isDirectory())
    throw new Error(`TLS output path is not a directory: ${directory}`);

  const entries = (await readdir(directory)).sort();
  if (entries.length === 0) return "empty-directory";
  if (
    entries.length !== expectedNames.length ||
    entries.some((entry, index) => entry !== expectedNames[index])
  ) {
    const expected = expectedNames.join(", ");
    const actual = entries.join(", ");
    throw new Error(
      `TLS setup is partial or contains unexpected files in ${directory}. Expected exactly [${expected}], found [${actual}]. No files were changed.`,
    );
  }

  for (const fileName of expectedNames) {
    const fileState = await lstat(join(directory, fileName));
    if (!fileState.isFile())
      throw new Error(
        `TLS setup is invalid: ${fileName} in ${directory} must be a regular file. No files were changed.`,
      );
  }
  return "complete";
}

async function inspectBundleDirectories(publicDirectory, privateDirectory) {
  const [publicState, privateState] = await Promise.all([
    inspectDirectory(publicDirectory, expectedPublicFileNames),
    inspectDirectory(privateDirectory, expectedPrivateFileNames),
  ]);
  if (publicState === privateState) return publicState;
  throw new Error(
    `TLS setup is inconsistent: ${publicDirectory} is ${publicState} but ${privateDirectory} is ${privateState}. No files were changed; resolve manually before regenerating.`,
  );
}

async function findRecoveryArtifacts(publicDirectory, privateDirectory) {
  const roots = [publicDirectory, privateDirectory];
  const parents = new Map();
  for (const root of roots) {
    const parentDirectory = dirname(root);
    const names = parents.get(parentDirectory) ?? [];
    names.push(basename(root));
    parents.set(parentDirectory, names);
  }

  const artifacts = [];
  for (const [parentDirectory, names] of parents) {
    const entries = await readdir(parentDirectory).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const name of names) {
      const backupPrefix = `${name}.backup-`;
      const stagingPrefix = `.${name}-setup-`;
      for (const entry of entries) {
        if (entry.startsWith(backupPrefix) || entry.startsWith(stagingPrefix))
          artifacts.push(join(parentDirectory, entry));
      }
    }
  }
  return [...new Set(artifacts)].sort();
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

async function assertPrivateDirectoryPermissions(path) {
  if (process.platform === "win32") return;
  const mode = (await lstat(path)).mode & 0o777;
  assertCondition(
    mode === 0o700,
    "TLS private key directory permissions must be 0700",
  );
}

async function assertPrivateFilePermissions(path, label) {
  if (process.platform === "win32") return;
  const mode = (await lstat(path)).mode & 0o777;
  assertCondition(mode === 0o600, `${label} permissions must be 0600`);
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

async function validateBundle(
  publicDirectory,
  privateDirectory,
  { allowExpiredServer = false } = {},
) {
  const paths = {
    caCertificate: join(publicDirectory, publicFileNames.caCertificate),
    serverCertificate: join(publicDirectory, publicFileNames.serverCertificate),
    caPrivateKey: join(privateDirectory, privateFileNames.caPrivateKey),
    serverPrivateKey: join(privateDirectory, privateFileNames.serverPrivateKey),
  };
  const [
    caCertificatePem,
    serverCertificatePem,
    caPrivateKeyPem,
    serverPrivateKeyPem,
  ] = await Promise.all([
    readFile(paths.caCertificate),
    readFile(paths.serverCertificate),
    readFile(paths.caPrivateKey),
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

  // Public certificates are non-sensitive (world-readable by design), and
  // often live on a Windows Docker Desktop bind mount that cannot reliably
  // preserve exact POSIX modes, so only the private key directory/files are
  // asserted here. Private keys are always kept on a Docker named volume,
  // where permissions are enforced correctly.
  await Promise.all([
    assertPrivateDirectoryPermissions(privateDirectory),
    assertPrivateFilePermissions(paths.caPrivateKey, "CA private key"),
    assertPrivateFilePermissions(paths.serverPrivateKey, "Server private key"),
  ]);

  return { caCertificate, serverCertificate };
}

async function writeGenerationConfiguration(scratchDirectory) {
  await Promise.all([
    writeFile(
      join(scratchDirectory, "ca.cnf"),
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
      join(scratchDirectory, "server-request.cnf"),
      `[req]\n` +
        `prompt = no\n` +
        `distinguished_name = distinguished_name\n` +
        `default_md = sha256\n` +
        `\n[distinguished_name]\n` +
        `CN = ${serverName}\n`,
      { mode: 0o600 },
    ),
    writeFile(
      join(scratchDirectory, "server-extensions.cnf"),
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

async function generateCa(
  privateStagingDirectory,
  publicStagingDirectory,
  scratchDirectory,
) {
  const caPrivateKeyPath = join(
    privateStagingDirectory,
    privateFileNames.caPrivateKey,
  );
  const caCertificatePath = join(
    publicStagingDirectory,
    publicFileNames.caCertificate,
  );
  await runOpenSsl([
    "genpkey",
    "-algorithm",
    "RSA",
    "-pkeyopt",
    "rsa_keygen_bits:2048",
    "-out",
    caPrivateKeyPath,
  ]);
  await runOpenSsl([
    "req",
    "-new",
    "-x509",
    "-key",
    caPrivateKeyPath,
    "-out",
    caCertificatePath,
    "-days",
    String(caValidityDays),
    "-sha256",
    "-config",
    join(scratchDirectory, "ca.cnf"),
  ]);
}

async function generateServerCertificate(
  privateStagingDirectory,
  publicStagingDirectory,
  scratchDirectory,
  caCertificatePath,
  caPrivateKeyPath,
) {
  const serverPrivateKeyPath = join(
    privateStagingDirectory,
    privateFileNames.serverPrivateKey,
  );
  const serverCertificatePath = join(
    publicStagingDirectory,
    publicFileNames.serverCertificate,
  );
  const csrPath = join(scratchDirectory, "server.csr.pem");
  await runOpenSsl([
    "genpkey",
    "-algorithm",
    "RSA",
    "-pkeyopt",
    "rsa_keygen_bits:2048",
    "-out",
    serverPrivateKeyPath,
  ]);
  await runOpenSsl([
    "req",
    "-new",
    "-key",
    serverPrivateKeyPath,
    "-out",
    csrPath,
    "-sha256",
    "-config",
    join(scratchDirectory, "server-request.cnf"),
  ]);
  await runOpenSsl([
    "x509",
    "-req",
    "-in",
    csrPath,
    "-CA",
    caCertificatePath,
    "-CAkey",
    caPrivateKeyPath,
    "-set_serial",
    `0x${randomBytes(16).toString("hex")}`,
    "-out",
    serverCertificatePath,
    "-days",
    String(serverValidityDays),
    "-sha256",
    "-extfile",
    join(scratchDirectory, "server-extensions.cnf"),
  ]);
}

async function prepareBundle(
  publicStagingDirectory,
  privateStagingDirectory,
  scratchDirectory,
  existingPublicDirectory,
  existingPrivateDirectory,
  includeNewCa,
) {
  await writeGenerationConfiguration(scratchDirectory);
  const caCertificatePath = join(
    publicStagingDirectory,
    publicFileNames.caCertificate,
  );
  const caPrivateKeyPath = join(
    privateStagingDirectory,
    privateFileNames.caPrivateKey,
  );
  if (includeNewCa) {
    await generateCa(
      privateStagingDirectory,
      publicStagingDirectory,
      scratchDirectory,
    );
  } else {
    await Promise.all([
      copyFile(
        join(existingPublicDirectory, publicFileNames.caCertificate),
        caCertificatePath,
      ),
      copyFile(
        join(existingPrivateDirectory, privateFileNames.caPrivateKey),
        caPrivateKeyPath,
      ),
    ]);
  }
  await generateServerCertificate(
    privateStagingDirectory,
    publicStagingDirectory,
    scratchDirectory,
    caCertificatePath,
    caPrivateKeyPath,
  );

  await Promise.all([
    chmod(caCertificatePath, 0o644),
    chmod(caPrivateKeyPath, 0o600),
    chmod(
      join(publicStagingDirectory, publicFileNames.serverCertificate),
      0o644,
    ),
    chmod(
      join(privateStagingDirectory, privateFileNames.serverPrivateKey),
      0o600,
    ),
  ]);

  await validateBundle(publicStagingDirectory, privateStagingDirectory);
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
  publicDirectory,
  privateDirectory,
  outputExists,
  includeNewCa,
) {
  const publicParentDirectory = dirname(publicDirectory);
  const privateParentDirectory = dirname(privateDirectory);
  await Promise.all([
    mkdir(publicParentDirectory, { recursive: true }),
    mkdir(privateParentDirectory, { recursive: true }),
  ]);
  const publicStagingDirectory = await mkdtemp(
    join(publicParentDirectory, `.${basename(publicDirectory)}-setup-`),
  );
  const privateStagingDirectory = await mkdtemp(
    join(privateParentDirectory, `.${basename(privateDirectory)}-setup-`),
  );
  const scratchDirectory = await mkdtemp(
    join(publicParentDirectory, ".tls-setup-scratch-"),
  );
  try {
    await chmod(privateStagingDirectory, 0o700);
    await prepareBundle(
      publicStagingDirectory,
      privateStagingDirectory,
      scratchDirectory,
      includeNewCa ? undefined : publicDirectory,
      includeNewCa ? undefined : privateDirectory,
      includeNewCa,
    );
    await installBundle(publicStagingDirectory, publicDirectory, outputExists);
    await installBundle(
      privateStagingDirectory,
      privateDirectory,
      outputExists,
    );
  } finally {
    await Promise.all([
      rm(publicStagingDirectory, { recursive: true, force: true }),
      rm(privateStagingDirectory, { recursive: true, force: true }),
      rm(scratchDirectory, { recursive: true, force: true }),
    ]);
  }
}

async function acquireSetupLock(publicDirectory, privateDirectory) {
  await mkdir(dirname(publicDirectory), { recursive: true });
  const lockDirectory = `${publicDirectory}.setup.lock`;
  try {
    await mkdir(lockDirectory, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        `TLS setup lock already exists at ${lockDirectory}. Another setup may be running, or a previous process may have stopped unexpectedly. Verify that no setup process is running and inspect ${publicDirectory}, ${privateDirectory}, plus sibling backup/staging artifacts before removing the stale lock manually. Do not remove only the lock and rerun if the output directories are missing. No TLS files were changed.`,
      );
    throw error;
  }
  return lockDirectory;
}

async function performSetup(options) {
  const publicDirectory = options.outputDirectory;
  const privateDirectory = options.privateDirectory;

  let state;
  try {
    state = await inspectBundleDirectories(publicDirectory, privateDirectory);
  } catch (error) {
    throw new Error(`TLS setup failed: ${error.message}`);
  }

  if (state === "empty" || state === "empty-directory") {
    const recoveryArtifacts = await findRecoveryArtifacts(
      publicDirectory,
      privateDirectory,
    );
    if (recoveryArtifacts.length > 0)
      throw new Error(
        `TLS setup recovery artifacts exist: ${recoveryArtifacts.join(
          ", ",
        )}. Refusing to generate a new CA. Inspect the artifacts and restore a valid backup to ${publicDirectory} and ${privateDirectory}, or remove artifacts only after confirming that no established CA would be lost. No files were changed.`,
      );
    await generateAndInstall(
      publicDirectory,
      privateDirectory,
      state === "empty-directory",
      true,
    );
    const { caCertificate } = await validateBundle(
      publicDirectory,
      privateDirectory,
    );
    writeStandardOutput(
      `Created local TLS CA and server certificate in ${publicDirectory} (private keys in ${privateDirectory}).\n` +
        fingerprintLine(caCertificate) +
        `Trust ${join(publicDirectory, publicFileNames.caCertificate)} on each client; never share ${privateFileNames.caPrivateKey}.\n`,
    );
    return;
  }

  let certificates;
  try {
    certificates = await validateBundle(publicDirectory, privateDirectory, {
      allowExpiredServer: true,
    });
  } catch (error) {
    throw new Error(
      `TLS setup is invalid: ${error.message}. No files were changed; move or remove the invalid directories explicitly before regenerating.`,
    );
  }

  if (options.rotateCa) {
    const oldFingerprint = certificates.caCertificate.fingerprint256;
    await generateAndInstall(publicDirectory, privateDirectory, true, true);
    const { caCertificate } = await validateBundle(
      publicDirectory,
      privateDirectory,
    );
    writeStandardOutput(
      `Rotated the local TLS CA and server certificate in ${publicDirectory} (private keys in ${privateDirectory}).\n` +
        `Old CA SHA-256 fingerprint: ${oldFingerprint}\n` +
        fingerprintLine(caCertificate, "New CA SHA-256 fingerprint") +
        `Re-register ${publicFileNames.caCertificate} on every client.\n`,
    );
    return;
  }

  const caRemainingMilliseconds =
    certificates.caCertificate.validToDate.getTime() - Date.now();
  if (caRemainingMilliseconds <= serverValidityDays * millisecondsPerDay) {
    throw new Error(
      `The CA expires too soon to issue a ${serverValidityDays}-day server certificate. Run with --rotate-ca and re-register the new ${publicFileNames.caCertificate}.`,
    );
  }
  const remainingMilliseconds =
    certificates.serverCertificate.validToDate.getTime() - Date.now();
  if (remainingMilliseconds >= renewalThresholdDays * millisecondsPerDay) {
    writeStandardOutput(
      `TLS certificates in ${publicDirectory} are valid; no changes were made.\n` +
        fingerprintLine(certificates.caCertificate),
    );
    return;
  }

  await generateAndInstall(publicDirectory, privateDirectory, true, false);
  const { caCertificate } = await validateBundle(
    publicDirectory,
    privateDirectory,
  );
  writeStandardOutput(
    `Renewed the server certificate in ${publicDirectory} (private keys in ${privateDirectory}) using the existing local CA.\n` +
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
  const lockDirectory = await acquireSetupLock(
    options.outputDirectory,
    options.privateDirectory,
  );
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
