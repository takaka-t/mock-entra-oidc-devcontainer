import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const host = "127.0.0.1";
const startupTimeoutMs = 10_000;

async function availablePort() {
  const reservation = createServer();
  reservation.unref();
  reservation.listen(0, host);
  await once(reservation, "listening");
  const address = reservation.address();
  if (!address || typeof address === "string")
    throw new Error("Failed to reserve a TCP port for the startup smoke test");
  await new Promise((resolve, reject) => {
    reservation.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function waitForHealth(url, child, output) {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `Compiled server exited before becoming healthy (code ${child.exitCode}, signal ${child.signalCode}).\n${output()}`,
      );
    try {
      const response = await globalThis.fetch(url, {
        signal: globalThis.AbortSignal.timeout(500),
      });
      const body = await response.json();
      if (response.ok && body?.status === "ok") return;
    } catch {
      // The server may still be generating its signing keys or binding its port.
    }
    await delay(50);
  }
  throw new Error(
    `Compiled server did not become healthy within ${startupTimeoutMs}ms.\n${output()}`,
  );
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    closed.then(() => true),
    delay(3_000).then(() => false),
  ]);
  if (graceful || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await closed;
}

const keyDirectory = await mkdtemp(join(tmpdir(), "mock-entra-startup-"));
let child;
try {
  const port = await availablePort();
  let processOutput = "";
  child = spawn(process.execPath, ["dist/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: host,
      KEY_DIRECTORY: keyDirectory,
      NODE_ENV: "production",
      OIDC_ISSUER: `http://${host}:${port}`,
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const recordOutput = (chunk) => {
    processOutput = `${processOutput}${chunk.toString()}`.slice(-20_000);
  };
  child.stdout?.on("data", recordOutput);
  child.stderr?.on("data", recordOutput);
  const origin = `http://${host}:${port}`;
  await waitForHealth(`${origin}/health`, child, () => processOutput);
  const discoveryResponse = await globalThis.fetch(
    `${origin}/.well-known/openid-configuration`,
  );
  const discovery = await discoveryResponse.json();
  if (!discoveryResponse.ok || discovery?.issuer !== origin)
    throw new Error(
      `Compiled server returned invalid discovery metadata.\n${processOutput}`,
    );
  process.stdout.write("Compiled server startup smoke test passed.\n");
} finally {
  if (child) await stop(child);
  await rm(keyDirectory, { recursive: true, force: true });
}
