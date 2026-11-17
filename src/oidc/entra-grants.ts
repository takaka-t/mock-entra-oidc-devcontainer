import { parameterValue } from "./parameters.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type Provider from "oidc-provider";
import { errors, type KoaContextWithOIDC } from "oidc-provider";
import { SignJWT } from "jose";
import type { OidcClientConfig, RedirectUri } from "../clients/types.js";
import { findRedirect } from "../clients/redirect-uri.js";
import { mockTokenTtlSeconds, type AppConfig } from "../config.js";
import type { ApiResourceStore } from "../resources/store.js";
import type { InMemoryScenarioStore } from "../scenario/store.js";
import type { MockUserStore } from "../users/store.js";
import { SerialQueue } from "../persistence/json-file.js";
import { sessionGuid, userClaims } from "./claims.js";
import { signAccessToken } from "./direct-token.js";
import type { SigningKeys } from "./keys.js";
import { narrowedScopes, resolveScopes, type ResolvedScopes } from "./scopes.js";

interface RefreshRecord {
  clientId: string;
  userId: string;
  oid: string;
  sid: string;
  nonce?: string;
  scopes: string[];
  defaultScope: string;
  defaultResourceIdentifier?: string;
  redirectType: RedirectUri["type"];
  origin: string;
  expiresAt: number;
  spaDeadline?: number;
  authTime?: number;
}
interface CodeBinding {
  type: RedirectUri["type"];
  origin: string;
  expiresAt: number;
  oid: string;
  scopes: ResolvedScopes;
}
function useDefaultResourceIdentifier(resolved: ResolvedScopes, identifier: string | undefined): void {
  const target = resolved.targets[0];
  if (target)
    target.resourceIdentifier =
      identifier === target.resource.resourceAppId ? target.resource.resourceAppId : target.resource.identifierUri;
}
export function clientConfig(ctx: KoaContextWithOIDC): OidcClientConfig {
  const client = ctx.oidc.client?.metadata().mock_config as OidcClientConfig | undefined;
  if (!client) throw new errors.InvalidClient("client is not registered");
  return client;
}
function requireBrowserBinding(
  ctx: KoaContextWithOIDC,
  client: OidcClientConfig,
  type: RedirectUri["type"],
  origin: string,
): void {
  const supplied = ctx.get("origin");
  if (supplied && client.clientType === "CONFIDENTIAL")
    throw new errors.InvalidRequest("client credentials cannot be used with Origin");
  if (type === "spa" && (!supplied || supplied !== origin))
    throw new errors.InvalidRequest("SPA token redemption requires the registered Origin");
  if (type !== "spa" && supplied)
    throw new errors.InvalidRequest("cross-origin token redemption is permitted only for SPA redirects");
}
export function registerEntraGrants(
  provider: Provider,
  config: AppConfig,
  resources: ApiResourceStore,
  users: MockUserStore,
  scenarios: InMemoryScenarioStore,
  keys: SigningKeys,
): void {
  const refreshTokens = new Map<string, RefreshRecord>();
  const codeQueue = new SerialQueue();
  const codeBindings = new Map<string, CodeBinding>();
  provider.on("authorization.success", (ctx: KoaContextWithOIDC) => {
    const code = ctx.oidc.entities.AuthorizationCode;
    if (!code?.redirectUri) return;
    const redirect = findRedirect(clientConfig(ctx).redirectUris, code.redirectUri);
    const user = users.findByOid(code.accountId!);
    if (!redirect || !user) return;
    for (const [id, binding] of codeBindings) if (binding.expiresAt <= Date.now()) codeBindings.delete(id);
    if (codeBindings.size >= 1000) codeBindings.delete(codeBindings.keys().next().value!);
    codeBindings.set(code.jti, {
      type: redirect.type,
      origin: new URL(code.redirectUri).origin,
      expiresAt: Date.now() + 60000,
      oid: user.oid,
      scopes: resolveScopes(code.scope!, clientConfig(ctx), resources),
    });
  });
  const now = () => Math.floor(Date.now() / 1000);
  const saveRefresh = (record: RefreshRecord): string => {
    for (const [key, value] of refreshTokens) if (value.expiresAt <= now()) refreshTokens.delete(key);
    if (refreshTokens.size >= 1000) refreshTokens.delete(refreshTokens.keys().next().value!);
    const token = randomBytes(48).toString("base64url");
    refreshTokens.set(token, structuredClone(record));
    return token;
  };
  const issue = async (
    ctx: KoaContextWithOIDC,
    client: OidcClientConfig,
    record: RefreshRecord,
    resolved: ResolvedScopes,
    issueRefresh: boolean,
  ): Promise<void> => {
    const user = users.find(record.userId);
    if (!user || user.oid !== record.oid) throw new errors.InvalidGrant("referenced account not found");
    const target = resolved.targets[0];
    const groupsPresent =
      user.groups.length > 0 &&
      ((resolved.oidc.includes("openid") && client.groupMembershipClaims === "SecurityGroup") ||
        target?.resource.groupMembershipClaims === "SecurityGroup");
    const fault = groupsPresent ? scenarios.consumeForRequest("claims", scenarios.getRequestTicket(ctx.req)) : null;
    const accessToken = target
      ? await signAccessToken(
          config,
          keys,
          client,
          target.resource,
          target.scopes,
          user,
          fault,
          record.sid,
          resolved.oidc.includes("profile"),
          target.resourceIdentifier,
        )
      : randomBytes(48).toString("base64url");
    let idToken: string | undefined;
    if (resolved.oidc.includes("openid")) {
      const issuedAt = now();
      idToken = await new SignJWT({
        ...userClaims(
          user,
          config.tenantId,
          fault,
          resolved.oidc.includes("email") || client.emailOptionalClaim,
          client.clientId,
          resolved.oidc.includes("profile"),
          client.groupMembershipClaims === "SecurityGroup",
        ),
        iss: config.issuer,
        aud: client.clientId,
        iat: issuedAt,
        nbf: issuedAt,
        exp: issuedAt + mockTokenTtlSeconds,
        ver: "2.0",
        sid: record.sid,
        ...(record.authTime === undefined ? {} : { auth_time: record.authTime }),
        ...(record.nonce ? { nonce: record.nonce } : {}),
      })
        .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: String(keys.normal.publicJwk.kid) })
        .sign(keys.normal.privateKey);
    }
    const lifetime = record.redirectType === "spa" ? Math.max(0, record.spaDeadline! - now()) : 90 * 86400;
    ctx.body = {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: mockTokenTtlSeconds,
      scope: target
        ? target.scopes.map((name) => `${target.resource.identifierUri}/${name}`).join(" ")
        : resolved.oidc.filter((name) => name !== "offline_access").join(" "),
      ...(idToken ? { id_token: idToken } : {}),
      ...(issueRefresh ? { refresh_token: saveRefresh({ ...record, expiresAt: now() + lifetime }) } : {}),
    };
    ctx.status = 200;
    ctx.set("Cache-Control", "no-store");
    ctx.set("Pragma", "no-cache");
  };
  provider.registerGrantType(
    "authorization_code",
    async (ctx) => {
      const client = clientConfig(ctx),
        params = ctx.oidc.params!;
      if (!params.code || !params.redirect_uri) throw new errors.InvalidRequest("code and redirect_uri are required");
      const validated = await codeQueue.run(async () => {
        const code = await provider.AuthorizationCode.find(String(params.code), { ignoreExpiration: true });
        if (
          !code ||
          code.isExpired ||
          (code as typeof code & { consumed?: number }).consumed ||
          code.clientId !== client.clientId
        )
          throw new errors.InvalidGrant("authorization code is invalid, expired or already used");
        if (code.redirectUri !== params.redirect_uri)
          throw new errors.InvalidGrant("authorization code redirect_uri mismatch");
        const redirect = findRedirect(client.redirectUris, String(code.redirectUri));
        if (!redirect) throw new errors.InvalidGrant("redirect is no longer registered");
        const binding = codeBindings.get(code.jti);
        if (!binding || binding.expiresAt <= Date.now())
          throw new errors.InvalidGrant("authorization code binding is unavailable");
        requireBrowserBinding(ctx, client, binding.type, binding.origin);
        if (code.codeChallenge) {
          const verifier = parameterValue(params.code_verifier);
          if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new errors.InvalidGrant("invalid PKCE verifier");
          const challenge = createHash("sha256").update(verifier).digest("base64url");
          if (
            challenge.length !== code.codeChallenge.length ||
            !timingSafeEqual(Buffer.from(challenge), Buffer.from(code.codeChallenge))
          )
            throw new errors.InvalidGrant("PKCE verification failed");
        } else if (params.code_verifier) throw new errors.InvalidGrant("unexpected PKCE verifier");
        const grant = await provider.Grant.find(code.grantId!);
        const user = users.findByOid(code.accountId!);
        if (
          !grant ||
          grant.isExpired ||
          grant.clientId !== client.clientId ||
          grant.accountId !== code.accountId ||
          !user ||
          user.oid !== binding.oid
        )
          throw new errors.InvalidGrant("authorization grant or account is no longer valid");
        // Expand .default only at authorization and bind permissions to API IDs.
        const granted = binding.scopes;
        const defaultScope = [
          ...granted.oidc,
          ...granted.targets
            .slice(0, 1)
            .flatMap((target) => target.scopes.map((name) => `${target.resource.resourceAppId}/${name}`)),
        ].join(" ");
        if (parameterValue(params.scope).split(" ").includes("urn:mock:offline_access"))
          throw new errors.InvalidScope("unsupported scope", "");
        const resolved = resolveScopes(params.scope ? parameterValue(params.scope) : defaultScope, client, resources);
        if (!params.scope) useDefaultResourceIdentifier(resolved, granted.targets[0]?.resourceIdentifier);
        narrowedScopes(resolved, granted.canonical);
        if (params.scope && resolved.targets.length > 1)
          throw new errors.InvalidScope("authorization code redemption must target a single API", "");
        await code.consume();
        codeBindings.delete(code.jti);
        const record: RefreshRecord = {
          clientId: client.clientId,
          userId: user.sub,
          oid: user.oid,
          sid: sessionGuid(code.sessionUid ?? code.jti),
          scopes: granted.canonical,
          defaultScope,
          ...(granted.targets[0] ? { defaultResourceIdentifier: granted.targets[0].resourceIdentifier } : {}),
          redirectType: binding.type,
          origin: binding.origin,
          expiresAt: now() + (binding.type === "spa" ? 86400 : 90 * 86400),
          ...(typeof code.authTime === "number" ? { authTime: code.authTime } : {}),
          ...(code.nonce ? { nonce: code.nonce } : {}),
          ...(binding.type === "spa" ? { spaDeadline: now() + 86400 } : {}),
        };
        return { record, resolved, offline: granted.oidc.includes("offline_access") };
      });
      await issue(ctx, client, validated.record, validated.resolved, validated.offline);
    },
    ["code", "redirect_uri", "code_verifier", "scope"],
  );
  provider.registerGrantType(
    "refresh_token",
    async (ctx) => {
      const client = clientConfig(ctx),
        value = ctx.oidc.params!.refresh_token;
      if (!value) throw new errors.InvalidRequest("refresh_token is required");
      const record = refreshTokens.get(parameterValue(value));
      if (!record || record.clientId !== client.clientId || record.expiresAt <= now())
        throw new errors.InvalidGrant("refresh token is invalid or expired");
      requireBrowserBinding(ctx, client, record.redirectType, record.origin);
      const scope = ctx.oidc.params!.scope;
      if (parameterValue(scope).split(" ").includes("urn:mock:offline_access"))
        throw new errors.InvalidScope("unsupported scope", "");
      const resolved = resolveScopes(scope ? parameterValue(scope) : record.defaultScope, client, resources);
      if (!scope) useDefaultResourceIdentifier(resolved, record.defaultResourceIdentifier);
      narrowedScopes(resolved, record.scopes);
      await issue(ctx, client, record, resolved, true);
    },
    ["refresh_token", "scope"],
  );
}
