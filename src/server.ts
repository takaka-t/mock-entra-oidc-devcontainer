import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { loadTlsServerOptions } from "./tls.js";

const config = loadConfig();
const https = await loadTlsServerOptions(config);
const { app } = await buildApp(config, { https });

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
await app.listen({ host: config.host, port: config.port });
