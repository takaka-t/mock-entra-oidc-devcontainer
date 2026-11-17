import { spaOriginAllowed } from "../clients/redirect-uri.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { matchesCommonProbePath } from "./common-probe.js";
import type { AppConfig } from "../config.js";
import type { OidcClientStore } from "../clients/store.js";
import { v1TokenValidationPaths } from "./access-token-version.js";
export function createCorsMiddleware(config: AppConfig, clients: OidcClientStore) {
  const v1 = v1TokenValidationPaths(config.issuerPath);
  const open = [
    config.jwksPath,
    `${config.issuerPath}/.well-known/openid-configuration`,
    v1.discoveryPath,
    v1.jwksPath,
    config.commonAuthorizePath,
  ];
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const path = (req.url ?? "/").split("?")[0]!;
    const token = path === config.tokenPath || path === `${config.tokenPath}/`;
    const isOpen =
      open.some((candidate) => path === candidate || path === `${candidate}/`) ||
      matchesCommonProbePath(path, config.commonAuthorizePath);
    if (!token && !isOpen) return next();
    const origin = req.headers.origin;
    const allowed =
      isOpen ||
      (typeof origin === "string" && clients.list().some((client) => spaOriginAllowed(client.redirectUris, origin)));
    if (allowed) {
      res.setHeader("access-control-allow-origin", origin ?? "*");
      res.setHeader("vary", "Origin");
      res.setHeader("access-control-allow-methods", token ? "POST, OPTIONS" : "GET, HEAD, OPTIONS");
      res.setHeader(
        "access-control-allow-headers",
        "authorization, content-type, x-client-sku, x-client-ver, x-client-os, x-client-cpu, client-request-id, return-client-request-id, x-client-current-telemetry, x-client-last-telemetry, x-ms-lib-capability, x-anchormailbox, x-app-name, x-app-ver",
      );
    }
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.setHeader("cache-control", "no-store");
      res.end();
      return;
    }
    next();
  };
}
