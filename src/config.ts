import { decodeRoutingPath } from "./http-path.js";

export interface AppConfig {
  issuer: string;
  issuerOrigin: string;
  issuerPath: string;
  port: number;
  host: string;
  trustProxy: boolean;
  keyDirectory: string;
  clientConfigFile: string;
}

const reservedIssuerNamespaces = ["/__mock", "/health"];

function conflictsWithReservedNamespace(pathname: string): boolean {
  const decodedPathname = decodeRoutingPath(pathname);
  return reservedIssuerNamespaces.some(
    (namespace) =>
      decodedPathname === namespace ||
      decodedPathname.startsWith(`${namespace}/`),
  );
}

function issuerConfiguration(
  value: string | undefined,
): Pick<AppConfig, "issuer" | "issuerOrigin" | "issuerPath"> {
  const input = value?.trim();
  if (!input) throw new Error("OIDC_ISSUER is required");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("OIDC_ISSUER must be an absolute HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("OIDC_ISSUER must use http or https");
  const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(input)?.[1];
  if (
    url.username ||
    url.password ||
    authority?.includes("@") ||
    input.includes("?") ||
    input.includes("#")
  )
    throw new Error(
      "OIDC_ISSUER must not contain credentials, query, or fragment",
    );
  const issuerPath =
    url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  if (conflictsWithReservedNamespace(issuerPath))
    throw new Error(
      "OIDC_ISSUER path must not use the reserved /__mock or /health namespace",
    );
  return {
    issuer: `${url.origin}${issuerPath}`,
    issuerOrigin: url.origin,
    issuerPath,
  };
}

function boolean(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("TRUST_PROXY must be true or false");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT ?? 9000);
  const keyDirectory = env.KEY_DIRECTORY ?? ".data/keys";
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be a valid TCP port");
  return {
    ...issuerConfiguration(env.OIDC_ISSUER),
    port,
    host: env.HOST ?? "0.0.0.0",
    trustProxy: boolean(env.TRUST_PROXY),
    keyDirectory,
    clientConfigFile:
      env.CLIENT_CONFIG_FILE ??
      (env.NODE_ENV === "test"
        ? `${keyDirectory}/clients.json`
        : ".data/clients.json"),
  };
}
