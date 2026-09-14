import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { loadTlsServerOptions } from "./tls.js";

/**
 * Startup failures are expected during setup (missing or expired TLS material,
 * an unusable port), and their messages already say what to do -- TlsSetupError
 * carries the `npm run setup:tls` hint. Reporting just the message keeps that
 * guidance from being buried in an unhandled-rejection stack trace.
 */
function reportFatal(error: unknown): never {
  console.error(`[MOCK-IDP] failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

let app: FastifyInstance;
try {
  const config = loadConfig();
  const https = await loadTlsServerOptions(config);
  ({ app } = await buildApp(config, { https }));
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  reportFatal(error);
}

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  // Repeated signals must not start a second close: Fastify would reject and
  // the first shutdown is already draining.
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await app.close();
  } catch (error) {
    console.error(
      `[MOCK-IDP] failed to shut down cleanly after ${signal}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
