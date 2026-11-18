import { parameterValue } from "./parameters.js";
import Provider, {
  errors,
  interactionPolicy,
  type Configuration,
  type ErrorOut,
  type KoaContextWithOIDC,
} from "oidc-provider";
import type { FastifyBaseLogger } from "fastify";
import { requestCompatibility, validateAuthorizationCompatibility } from "./request-compatibility.js";
import { mockTokenTtlSeconds, type AppConfig } from "../config.js";
import { escapeHtml } from "../admin/html.js";
import type { OidcClientConfig } from "../clients/types.js";
import { authorizationFaultDefinitions, mutateAuthorizationResponse } from "../faults/authorization-fault.js";
import { mutateTokenResponse, tokenResponseFaultApplies } from "../faults/token-generator.js";
import type { InMemoryScenarioStore } from "../scenario/store.js";
import type { FaultDecision } from "../scenario/types.js";
import type { MockUserStore } from "../users/store.js";
import type { SigningKeys } from "./keys.js";
import type { SigningKeyRolloverState } from "./key-rollover.js";
import { createInMemoryAdapterFactory } from "./in-memory-adapter.js";
import { browserFacingRoutePath, oidcInternalRoutes } from "./routes.js";
import { v1TokenValidationPaths } from "./access-token-version.js";
import type { ApiResourceStore } from "../resources/store.js";
import { graphResource, internalOfflineScope, oidcScopes, resolveScopes } from "./scopes.js";
import { registerEntraGrants } from "./entra-grants.js";
import { findRedirect, spaOriginAllowed } from "../clients/redirect-uri.js";
import { diagnosticError } from "./errors.js";
import { pairwiseSubject } from "./claims.js";

function logFaultInjected(
  logger: FastifyBaseLogger,
  decision: FaultDecision,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  logger.warn(
    {
      scenario: decision.scenario,
      endpoint: decision.endpoint,
      mode: decision.mode,
      ...extra,
      faultInjected: true,
      remainingBefore: decision.remainingBefore,
      remainingAfter: decision.remainingAfter,
    },
    message,
  );
}

/**
 * The browser-facing counterpart of renderError below, styled like the
 * sign-in interaction page rather than oidc-provider default page.
 */
function errorPageHtml(out: ErrorOut): string {
  const rows = Object.entries(out)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(String(value))}</dd>`)
    .join("");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Mock Entra ID エラー</title><style>body{font-family:system-ui;background:#f4f6f8;padding:3rem}.box{max-width:420px;margin:auto;background:white;padding:2rem;border-radius:12px}dt{font-weight:600;margin-top:.8rem;color:#666;font-size:.85rem}dd{margin:.2rem 0 0;word-break:break-word}</style></head><body><main class="box"><h1>Mock Entra ID エラー</h1><dl>${rows}</dl></main></body></html>`;
}

export function createProvider(
  config: AppConfig,
  store: InMemoryScenarioStore,
  userStore: MockUserStore,
  keys: SigningKeys,
  rolloverState: SigningKeyRolloverState,
  logger: FastifyBaseLogger,
  resources: ApiResourceStore,
): Provider {
  const resourcesClientIds = () => registeredClients.get(provider) ?? [];
  const policy = interactionPolicy.base();
  // A session can outlive an Admin-managed user. The default no_session check
  // only checks accountId, so it otherwise reaches consent without a Grant.
  policy
    .get("login")!
    .checks.add(
      new interactionPolicy.Check("account_missing", "End-User authentication is required", "login_required", (ctx) =>
        Boolean(ctx.oidc.session?.accountId && !ctx.oidc.account),
      ),
    );
  // The provider's default check compares its internal account ID to sub.
  // Entra subjects are generated per receiving application instead.
  const loginChecks = policy.get("login")!.checks;
  loginChecks.add(
    new interactionPolicy.Check("login_hint", "the hinted user is not signed in", "login_required", (ctx) => {
      const hint = parameterValue(ctx.oidc.params?.login_hint);
      // A hint guides SSO; an explicit login may select a different account.
      if (!hint || ctx.oidc.result?.login) return false;
      const user = userStore.findByOid(ctx.oidc.session?.accountId ?? "");
      return (
        !user ||
        ![user.preferred_username, user.mail].some((value) => value && value.toLowerCase() === hint.toLowerCase())
      );
    }),
  );
  loginChecks.remove("id_token_hint");
  loginChecks.add(
    new interactionPolicy.Check(
      "id_token_hint",
      "id_token_hint and authenticated subject do not match",
      "login_required",
      (ctx) => {
        const hint = ctx.oidc.entities.IdTokenHint?.payload;
        if (!hint) return false;
        const user = userStore.findByOid(ctx.oidc.session?.accountId ?? "");
        return !user || hint.sub !== pairwiseSubject(config.tenantId, user, ctx.oidc.client!.clientId);
      },
    ),
  );
  authorizationFaultDefinitions.forEach((definition, index) => {
    policy.add(
      new interactionPolicy.Prompt(
        { name: definition.promptName, requestable: false },
        new interactionPolicy.Check(definition.promptName, definition.errorDescription, definition.error, (ctx) => {
          if (!["GET", "POST"].includes(ctx.method)) return false;
          if (store.get().scenario !== definition.scenario) return false;
          const decision = store.consumeForRequest("authorization", store.getRequestTicket(ctx.req));
          if (!decision) return false;
          logFaultInjected(logger, decision, "[MOCK-IDP] authorization fault injected", {
            oauthError: definition.error,
          });
          return true;
        }),
      ),
      index,
    );
  });
  policy.add(
    new interactionPolicy.Prompt({
      name: "select_account",
      requestable: true,
    }),
    authorizationFaultDefinitions.length + 1,
  );

  const configuration: Configuration & { enableHttpPostMethods: boolean } = {
    adapter: createInMemoryAdapterFactory(),
    jwks: { keys: [keys.normal.privateJwk] },
    claims: {
      openid: ["sub", "tid", "nbf", "ver", "sid", "groups", "_claim_names", "_claim_sources"],
      profile: ["oid", "name", "preferred_username"],
      email: ["email"],
    },
    scopes: [...oidcScopes, internalOfflineScope],
    responseTypes: ["code"],
    allowOmittingSingleRegisteredRedirectUri: false,
    enableHttpPostMethods: true,
    pkce: {
      required: (ctx, client) => {
        const config = client.metadata().mock_config as OidcClientConfig;
        return findRedirect(config.redirectUris, String(ctx.oidc.params?.redirect_uri))?.type === "spa";
      },
    },
    clientBasedCORS: (ctx, origin, client) => {
      const config = client.metadata().mock_config as OidcClientConfig;
      return config.clientType === "PUBLIC" && spaOriginAllowed(config.redirectUris, origin);
    },
    extraClientMetadata: {
      properties: ["mock_config"],
      validator: (_ctx, key, value) => {
        if (key === "mock_config" && (!value || typeof value !== "object"))
          throw new errors.InvalidClientMetadata("mock_config is required");
      },
    },
    extraParams: {
      client_info: (_ctx, value) => {
        parameterValue(value);
      },
      mock_validate: (ctx, _value, client) => {
        validateAuthorizationCompatibility(ctx);
        const config = client.metadata().mock_config as OidcClientConfig;
        resolveScopes(parameterValue(ctx.oidc.params?.scope), config, resources);
      },
    },
    routes: oidcInternalRoutes,
    /**
     * oidc-provider error handler picks the error response format by content
     * negotiation (`ctx.accepts("json", "html")` in shared/error_handler.js)
     * and hands anything preferring HTML to renderError -- the token endpoint
     * included. msal4j default HttpClient is a JDK HttpURLConnection, which
     * sends its own `Accept: text/html, image/gif, image/jpeg, ...` when the
     * caller sets none, so every token error arrived as an HTML page and
     * msal4j failed to parse it as JSON. Entra ID answers its machine
     * endpoints with JSON whatever the client accepts, so HTML is kept only
     * for the pages a browser actually renders.
     */
    renderError: (ctx, out) => {
      if (!browserFacingRoutePath(ctx.path)) {
        ctx.type = "application/json; charset=utf-8";
        ctx.body = diagnosticError(out);
        return;
      }
      ctx.type = "text/html; charset=utf-8";
      ctx.body = errorPageHtml(diagnosticError(out));
    },
    features: {
      devInteractions: { enabled: false },
      userinfo: { enabled: false },
      dPoP: { enabled: false },
      // Entra ID's discovery document does not advertise a PAR endpoint.
      pushedAuthorizationRequests: { enabled: false },
      resourceIndicators: {
        enabled: true,
        defaultResource: (ctx, client, oneOf) => {
          if (oneOf?.length) return oneOf[0]!;
          const resolved = resolveScopes(
            parameterValue(ctx.oidc.params?.scope),
            client.metadata().mock_config as OidcClientConfig,
            resources,
          );
          const targets = resolved.targets.map((target) => target.resource.identifierUri);
          return targets.length ? targets : graphResource;
        },
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, resource, client) => {
          if (resource === graphResource)
            return { scope: [...oidcScopes, internalOfflineScope].join(" "), accessTokenFormat: "opaque" };
          const target = resources.list().find((item) => item.identifierUri === resource);
          const clientSettings = client.metadata().mock_config as OidcClientConfig;
          const permission = clientSettings.requiredResourceAccess.find(
            (item) => item.resourceAppId === target?.resourceAppId,
          );
          if (!target || !permission) throw new errors.InvalidTarget();
          return {
            scope: [
              ...permission.scopes.map((name) => `${target.identifierUri}/${name}`),
              ...permission.scopes.map((name) => `${target.resourceAppId}/${name}`),
              `${target.identifierUri}/.default`,
              `${target.resourceAppId}/.default`,
            ].join(" "),
            audience: target.requestedAccessTokenVersion === 2 ? target.resourceAppId : target.identifierUri,
            accessTokenFormat: "jwt",
          };
        },
      },
    },
    findAccount: (_ctx, oid) => {
      const user = userStore.findByOid(oid);
      return user ? { accountId: user.oid, claims: () => ({ sub: user.oid }) } : undefined;
    },
    interactions: {
      policy,
      url: (_ctx, interaction) => `${config.issuerPath}/interaction/${interaction.uid}`,
    },
    cookies: {
      long: { sameSite: "none" },
      keys: ["mock-cookie-key-one-at-least-32-bytes", "mock-cookie-key-two-at-least-32-bytes"],
    },
    ttl: {
      AccessToken: mockTokenTtlSeconds,
      AuthorizationCode: 60,
      Grant: 90 * 24 * 3600,
      IdToken: mockTokenTtlSeconds,
      Interaction: 600,
      RefreshToken: 90 * 24 * 3600,
      Session: 90 * 24 * 3600,
    },
  };

  const provider = new Provider(config.issuer, configuration);
  provider.proxy = config.trustProxy;
  // Override the documented URI policy methods; the typed registry is authoritative.
  const clientPrototype = provider.Client.prototype;
  clientPrototype.redirectUriAllowed = function (value: string) {
    return !!findRedirect((this.metadata().mock_config as OidcClientConfig).redirectUris, value);
  };
  clientPrototype.postLogoutRedirectUriAllowed = function (value: string) {
    return !!findRedirect((this.metadata().mock_config as OidcClientConfig).redirectUris, value);
  };
  registerEntraGrants(provider, config, resources, userStore, store, keys);
  const compatibleRequest = requestCompatibility(provider, resourcesClientIds);
  // Compatibility checks run before the provider's route-specific error handlers.
  provider.use(async (ctx: KoaContextWithOIDC, next) => {
    try {
      await compatibleRequest(ctx, next);
    } catch (error) {
      if (!(error instanceof errors.OIDCProviderError)) throw error;
      ctx.status = error.statusCode;
      ctx.set("Cache-Control", "no-store");
      ctx.set("Pragma", "no-cache");
      const out = { error: error.error, error_description: error.error_description };
      if (browserFacingRoutePath(ctx.path) && ctx.accepts("json", "html") === "html") {
        ctx.type = "text/html; charset=utf-8";
        ctx.body = errorPageHtml(diagnosticError(out));
      } else {
        ctx.type = "application/json; charset=utf-8";
        ctx.body = diagnosticError(out);
      }
    }
  });
  provider.on("authorization.success", (ctx: KoaContextWithOIDC, out: Record<string, unknown>) => {
    const decision = store.consumeForRequest("authorization-response", store.getRequestTicket(ctx.req));
    if (!decision) return;
    mutateAuthorizationResponse(out, decision);
    logFaultInjected(logger, decision, "[MOCK-IDP] authorization response fault injected");
  });
  provider.use(async (ctx: KoaContextWithOIDC, next) => {
    await next();
    const path = ctx.path.replace(/\/$/, "");
    if (
      path === "/.well-known/openid-configuration" &&
      ctx.status === 200 &&
      typeof ctx.body === "object" &&
      ctx.body !== null
    ) {
      const originalUrl = (ctx.req as typeof ctx.req & { originalUrl?: string }).originalUrl;
      const v1 = v1TokenValidationPaths(config.issuerPath);
      const pathname = originalUrl?.split("?")[0]?.replace(/\/$/, "");
      // This document is for API access-token validation, not SPA sign-in:
      // authorization and ID Tokens remain on the v2 endpoint and issuer.
      ctx.body =
        pathname === v1.discoveryPath
          ? {
              issuer: `${config.issuerOrigin}${v1.issuerPath}`,
              jwks_uri: `${config.issuerOrigin}${v1.jwksPath}`,
              id_token_signing_alg_values_supported: ["RS256"],
            }
          : {
              ...(ctx.body as Record<string, unknown>),
              authorization_endpoint: `${config.issuerOrigin}${config.authorizePath}`,
              token_endpoint: `${config.issuerOrigin}${config.tokenPath}`,
              jwks_uri: `${config.issuerOrigin}${config.jwksPath}`,
              end_session_endpoint: `${config.issuerOrigin}${config.logoutPath}`,
              // Like Entra metadata, omit this flag: optional claims are tolerated,
              // but the mock does not implement generic claims selection.
              claims_parameter_supported: undefined,
              subject_types_supported: ["pairwise"],
              claim_types_supported: ["normal", "distributed"],
              token_endpoint_auth_signing_alg_values_supported: undefined,
              code_challenge_methods_supported: ["S256", "plain"],
              scopes_supported: [
                ...oidcScopes,
                ...resources
                  .list()
                  .flatMap((resource) => resource.scopes.map((name) => `${resource.identifierUri}/${name}`)),
              ],
              token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
            };
    }
    if (path === "/jwks" && ctx.status === 200 && rolloverState.published) {
      ctx.body = {
        keys: [keys.normal.publicJwk, keys.rollover.publicJwk],
      };
    }
    if (
      path === "/token" &&
      ctx.status >= 400 &&
      ctx.body &&
      typeof ctx.body === "object" &&
      "error" in ctx.body &&
      typeof ctx.body.error === "string"
    ) {
      ctx.body = diagnosticError(ctx.body as { error: string });
    }
    if (path !== "/token" || ctx.status !== 200) return;
    // Checked and consumed with no await in between, like the authorization
    // fault Checks above, so the scenario cannot change between the two.
    const active = store.get().scenario;
    if (active !== "NORMAL" && !tokenResponseFaultApplies(active, ctx.body, store.get().parameters?.claim)) return;
    const decision = store.consumeForRequest("token-jwt", store.getRequestTicket(ctx.req));
    if (!decision) return;
    logFaultInjected(logger, decision, "[MOCK-IDP] token fault injected");
    try {
      ctx.body = await mutateTokenResponse(ctx.body, decision, keys);
    } catch (error) {
      logger.warn(
        {
          scenario: decision.scenario,
          endpoint: decision.endpoint,
          err: error,
        },
        "[MOCK-IDP] token fault mutation failed",
      );
      ctx.status = 500;
      ctx.body = {
        error: "server_error",
        error_description: `Injected ${decision.scenario} fault could not be applied to this token`,
      };
    }
  });
  return provider;
}

type ClientAdapter = {
  upsert(id: string, payload: Record<string, unknown>): Promise<void>;
  destroy(id: string): Promise<void>;
};

type ProviderClientModel = {
  new (metadata: Record<string, unknown>): {
    metadata(): Record<string, unknown>;
  };
  adapter: ClientAdapter;
};

const registeredClients = new WeakMap<Provider, string[]>();
function clientMetadata(client: OidcClientConfig): Record<string, unknown> {
  const native = client.redirectUris.some((item) => !["http:", "https:"].includes(new URL(item.uri).protocol));
  const redirectUris = client.redirectUris.map(({ uri }) => {
    const parsed = new URL(uri);
    return native && parsed.protocol === "https:" && ["localhost", "127.0.0.1"].includes(parsed.hostname)
      ? uri.replace(/^https:/i, "http:")
      : uri;
  });
  return {
    client_id: client.clientId,
    ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
    application_type: native ? "native" : "web",
    redirect_uris: redirectUris,
    post_logout_redirect_uris: redirectUris,
    response_types: ["code"],
    grant_types: ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    mock_config: client,
  };
}

function providerClientModel(provider: Provider): ProviderClientModel {
  return provider.Client as unknown as ProviderClientModel;
}

/**
 * Runs oidc-provider's complete client metadata validation without changing
 * adapter state. The store uses this before staging a configuration change so
 * an input accepted by our API cannot fail only after it has been persisted.
 */
export function validateProviderClient(provider: Provider, client: OidcClientConfig): void {
  const Client = providerClientModel(provider);
  new Client(clientMetadata(client));
}

export async function applyProviderClient(provider: Provider, client: OidcClientConfig): Promise<void> {
  const Client = providerClientModel(provider);
  const validated = new Client(clientMetadata(client));
  await Client.adapter.upsert(client.clientId, validated.metadata());
  registeredClients.set(provider, [...new Set([...(registeredClients.get(provider) ?? []), client.clientId])]);
}

export async function removeProviderClient(provider: Provider, clientId: string): Promise<void> {
  const Client = providerClientModel(provider);
  await Client.adapter.destroy(clientId);
  registeredClients.set(
    provider,
    (registeredClients.get(provider) ?? []).filter((id) => id !== clientId),
  );
}
