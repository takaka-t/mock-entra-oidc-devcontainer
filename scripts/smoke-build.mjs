import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { buildApp } from "../dist/app.js";
import {
  loadConfig,
  mockIssuer,
  mockIssuerPath,
  mockOrigin,
} from "../dist/config.js";

const listenHost = "127.0.0.1";
const issuerHost = new URL(mockOrigin).host;
const stateDirectory = await mkdtemp(join(tmpdir(), "mock-entra-startup-"));
let context;

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      { headers: { host: issuerHost } },
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
  context = await buildApp({
    ...loadConfig(),
    host: listenHost,
    keyDirectory: join(stateDirectory, "keys"),
    clientConfigFile: join(stateDirectory, "clients.json"),
  });
  await context.app.listen({ host: listenHost, port: 0 });
  const address = context.app.server.address();
  if (!address || typeof address === "string")
    throw new Error("Compiled server did not expose a TCP address");
  const localOrigin = `http://${listenHost}:${address.port}`;

  const healthResponse = await requestJson(`${localOrigin}/health`);
  if (healthResponse.statusCode !== 200 || healthResponse.body?.status !== "ok")
    throw new Error("Compiled server returned an invalid health response");

  const discoveryResponse = await requestJson(
    `${localOrigin}${mockIssuerPath}/.well-known/openid-configuration`,
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
