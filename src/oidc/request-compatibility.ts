import { createHash } from "node:crypto";
import { parse } from "node:querystring";
import type Provider from "oidc-provider";
import { errors, type KoaContextWithOIDC } from "oidc-provider";
import type { OidcClientConfig } from "../clients/types.js";
import { findRedirect } from "../clients/redirect-uri.js";
import { internalOfflineScope } from "./scopes.js";
/** Adapt Entra request semantics before the standards-oriented provider validates them. */
export function requestCompatibility(provider: Provider, clientIds: () => string[]) {
  return async (ctx: KoaContextWithOIDC, next: () => Promise<unknown>) => {
    const path = ctx.path.replace(/\/$/, "");
    if (path === "/token" && ctx.method === "POST" && ctx.get("dpop"))
      throw new errors.InvalidRequest("DPoP is not implemented by this mock");
    if (
      !["/authorize", "/logout", "/token"].includes(path) ||
      !["GET", "POST"].includes(ctx.method) ||
      (path === "/token" && ctx.method !== "POST")
    )
      return next();
    if (ctx.method === "POST" && !ctx.is("application/x-www-form-urlencoded")) return next();
    const req = ctx.req as typeof ctx.req & { body?: unknown; originalUrl?: string };
    let params: Record<string, string | string[] | undefined>;
    if (ctx.method === "POST") {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of ctx.req) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        size += data.length;
        if (size > 56 * 1024) throw new errors.InvalidRequest("request body is too large");
        chunks.push(data);
      }
      params = parse(Buffer.concat(chunks).toString("utf8"), undefined, undefined, { maxKeys: 0 });
    } else params = parse(ctx.querystring, undefined, undefined, { maxKeys: 0 });
    // Koa and the provider's form parser retain at most 1000 fields. Reject
    // excess input before a trailing scope or duplicate can disappear.
    const fields = Object.values(params).reduce((count, value) => count + (Array.isArray(value) ? value.length : 1), 0);
    if (fields > 1000) throw new errors.InvalidRequest("too many request parameters");
    if (path === "/authorize") {
      if (params.resource !== undefined)
        throw new errors.InvalidRequest("v2 requests must use scope instead of resource");
      if (params.claims !== undefined)
        throw new errors.InvalidRequest("claims requests are not implemented by this mock");
      if (params.dpop_jkt !== undefined) throw new errors.InvalidRequest("DPoP is not implemented by this mock");
      const challenge = params.code_challenge;
      if (
        typeof challenge === "string" &&
        (params.code_challenge_method === "plain" || !params.code_challenge_method)
      ) {
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(challenge))
          throw new errors.InvalidRequest("invalid plain PKCE challenge");
        params.code_challenge = createHash("sha256").update(challenge).digest("base64url");
        params.code_challenge_method = "S256";
      }
      if (typeof params.scope === "string") {
        const scopes = params.scope.split(" ");
        if (scopes.includes(internalOfflineScope))
          throw new errors.InvalidScope("unsupported scope", internalOfflineScope);
        // Entra permits offline_access without forcing prompt=consent, including silent SSO.
        params.scope = scopes.map((scope) => (scope === "offline_access" ? internalOfflineScope : scope)).join(" ");
      }
    }
    if (
      path === "/logout" &&
      !params.client_id &&
      !params.id_token_hint &&
      typeof params.post_logout_redirect_uri === "string"
    ) {
      const destination = params.post_logout_redirect_uri;
      const clients = await Promise.all(clientIds().map((id) => provider.Client.find(id)));
      const client = clients.find(
        (item) => item && findRedirect((item.metadata().mock_config as OidcClientConfig).redirectUris, destination),
      );
      if (!client) throw new errors.InvalidRequest("post_logout_redirect_uri is not registered");
      params.client_id = client.clientId;
    }
    if (ctx.method === "POST") req.body = params;
    else {
      ctx.query = params;
      // Preserve the external mount after rewriting the query string.
      if (req.originalUrl)
        req.originalUrl = req.originalUrl.split("?")[0] + (ctx.querystring ? `?${ctx.querystring}` : "");
    }
    return next();
  };
}
