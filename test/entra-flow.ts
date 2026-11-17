import { createHash, randomBytes } from "node:crypto";
import type { OutgoingHttpHeaders } from "node:http";
import type { AppContext } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { publicClientId } from "../src/clients/types.js";
import { defaultResourceUri } from "../src/resources/types.js";
export function cookieJar(current: string, headers: OutgoingHttpHeaders): string {
  const jar = new Map(
    current
      .split("; ")
      .filter(Boolean)
      .map((pair) => [pair.split("=")[0]!, pair]),
  );
  const values = headers["set-cookie"];
  for (const cookie of Array.isArray(values) ? values : values ? [values] : []) {
    const pair = cookie.split(";")[0]!;
    jar.set(pair.split("=")[0]!, pair);
  }
  return [...jar.values()].join("; ");
}
export interface FlowOptions {
  clientId?: string;
  redirectUri?: string;
  scope?: string;
  pkce?: "S256" | "plain" | "omitted" | "none";
  nonce?: string | null;
  jar?: string;
  userId?: string;
  method?: "GET" | "POST";
  trailingSlash?: boolean;
  prompt?: string;
  idTokenHint?: string;
}
export async function authorize(context: AppContext, config: AppConfig, options: FlowOptions = {}) {
  const verifier = randomBytes(32).toString("base64url");
  const redirectUri = options.redirectUri ?? "http://localhost:3000/callback";
  const pkce = options.pkce ?? "S256";
  const query = new URLSearchParams({
    client_id: options.clientId ?? publicClientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: options.scope ?? `openid profile offline_access ${defaultResourceUri}/api.read`,
    state: "entra-state",
    ...(options.prompt ? { prompt: options.prompt } : {}),
    ...(options.idTokenHint ? { id_token_hint: options.idTokenHint } : {}),
    ...(options.nonce === null ? {} : { nonce: options.nonce ?? "entra-nonce" }),
    ...(pkce === "none"
      ? {}
      : {
          code_challenge: pkce === "S256" ? createHash("sha256").update(verifier).digest("base64url") : verifier,
          ...(pkce === "omitted" ? {} : { code_challenge_method: pkce }),
        }),
  });
  let jar = options.jar ?? "";
  const method = options.method ?? "GET";
  let currentUrl = `${config.authorizePath}${options.trailingSlash ? "/" : ""}${method === "GET" ? `?${query}` : ""}`;
  let response = await context.app.inject({
    method,
    url: currentUrl,
    headers: {
      host: new URL(config.issuer).host,
      cookie: jar,
      ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(method === "POST" ? { payload: query.toString() } : {}),
  });
  for (let attempt = 0; attempt < 15; attempt++) {
    jar = cookieJar(jar, response.headers);
    const location = response.headers.location;
    if (!location) {
      if (response.body.includes('name="accountId"')) {
        const interaction = currentUrl;
        response = await context.app.inject({
          method: "POST",
          url: interaction,
          headers: {
            host: new URL(config.issuer).host,
            cookie: jar,
            "content-type": "application/x-www-form-urlencoded",
          },
          payload: `accountId=${encodeURIComponent(options.userId ?? "user-admin")}`,
        });
        continue;
      }
      throw new Error(`authorization failed (${response.statusCode}): ${response.body}`);
    }
    const next = new URL(String(location), config.issuer);
    if (next.origin !== config.issuerOrigin) {
      const code = next.searchParams.get("code");
      if (!code) throw new Error(`authorization error: ${next}`);
      return { code, verifier, jar, callback: next };
    }
    currentUrl = `${next.pathname}${next.search}`;
    response = await context.app.inject({ url: currentUrl, headers: { host: next.host, cookie: jar } });
  }
  throw new Error("too many authorization redirects");
}
export function tokenRequest(
  context: AppContext,
  config: AppConfig,
  payload: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return context.app.inject({
    method: "POST",
    url: config.tokenPath,
    headers: { host: new URL(config.issuer).host, "content-type": "application/x-www-form-urlencoded", ...headers },
    payload: new URLSearchParams(payload).toString(),
  });
}
