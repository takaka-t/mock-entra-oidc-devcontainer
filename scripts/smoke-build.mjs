import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath, URL } from "node:url";
import { buildApp } from "../dist/app.js";
import {
  loadConfig,
  mockIssuer,
  mockIssuerPath,
  mockOrigin,
} from "../dist/config.js";
import { loadTlsServerOptions } from "../dist/tls.js";

const listenHost = "127.0.0.1";
const issuerUrl = new URL(mockOrigin);
const issuerHost = issuerUrl.host;
const stateDirectory = await mkdtemp(join(tmpdir(), "mock-entra-startup-"));
const tlsDirectory = join(stateDirectory, "tls");
const tlsPrivateDirectory = join(stateDirectory, "tls-private");
const setupTlsScript = fileURLToPath(
  new URL("./setup-tls.mjs", import.meta.url),
);
const execFileAsync = promisify(execFile);
let context;
let ca;

function requestJson(port, path) {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: listenHost,
        port,
        path,
        servername: issuerUrl.hostname,
        ca,
        headers: { host: issuerHost },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          try {
            resolve({
              statusCode: response.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

try {
  await execFileAsync(process.execPath, [
    setupTlsScript,
    "--output-dir",
    tlsDirectory,
    "--private-dir",
    tlsPrivateDirectory,
  ]);
  const config = {
    ...loadConfig(),
    host: listenHost,
    keyDirectory: join(stateDirectory, "keys"),
    clientConfigFile: join(stateDirectory, "clients.json"),
    tlsCaCertificateFile: join(tlsDirectory, "ca.crt"),
    tlsCertificateFile: join(tlsDirectory, "server.crt"),
    tlsPrivateKeyFile: join(tlsPrivateDirectory, "server.key.pem"),
  };
  const httpsOptions = await loadTlsServerOptions(config);
  ca = await readFile(config.tlsCaCertificateFile);
  context = await buildApp(config, { https: httpsOptions });
  await context.app.listen({ host: listenHost, port: 0 });
  const address = context.app.server.address();
  if (!address || typeof address === "string")
    throw new Error("Compiled server did not expose a TCP address");

  const healthResponse = await requestJson(address.port, "/health");
  if (healthResponse.statusCode !== 200 || healthResponse.body?.status !== "ok")
    throw new Error("Compiled server returned an invalid health response");

  const discoveryResponse = await requestJson(
    address.port,
    `${mockIssuerPath}/.well-known/openid-configuration`,
  );
  if (
    discoveryResponse.statusCode !== 200 ||
    discoveryResponse.body?.issuer !== mockIssuer
  )
    throw new Error("Compiled server returned invalid discovery metadata");

  process.stdout.write("Compiled server startup smoke test passed.\n");
} finally {
  await context?.app.close();
  await rm(stateDirectory, { recursive: true, force: true });
}
