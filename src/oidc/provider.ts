import Provider, {
  errors,
  interactionPolicy,
  type Client,
  type Configuration,
  type KoaContextWithOIDC,
} from "oidc-provider";
import type { FastifyBaseLogger } from "fastify";
import {
  decodeJwt,
  decodeProtectedHeader,
  SignJWT,
  type JWTHeaderParameters,
} from "jose";
import type { AppConfig } from "../config.js";
import type { OidcClientConfig } from "../clients/types.js";
import { authorizationFaultDefinitions } from "../faults/authorization-fault.js";
import { mutateTokenResponse } from "../faults/token-generator.js";
import type { InMemoryScenarioStore } from "../scenario/store.js";
import type { FaultDecision } from "../scenario/types.js";
import { findUser, type MockUser } from "../users/users.js";
import type { SigningKeys } from "./keys.js";
import type { SigningKeyRolloverState } from "./key-rollover.js";
import { createInMemoryAdapterFactory } from "./in-memory-adapter.js";
import { oidcInternalRoutes } from "./routes.js";

function userClaims(
  user: MockUser,
  decision: FaultDecision | null | undefined,
  includeEmail: boolean,
): Omit<MockUser, "groups" | "mail"> & { groups?: string[]; email?: string } {
  const { mail, ...rest } = user;
  const claims: Omit<MockUser, "groups" | "mail"> & {
    groups?: string[];
    email?: string;
  } = {
    ...rest,
    ...(includeEmail ? { email: mail } : {}),
    groups: [...user.groups],
  };
  if (decision?.scenario === "NO_GROUPS") delete claims.groups;
  return claims;
}

const supportedScopes = ["openid", "profile", "email", "offline_access"];

function includesScope(value: unknown, scope: string): boolean {
  return typeof value === "string" && value.split(" ").includes(scope);
}

function emailOptionalClaimFor(client: Client | undefined): boolean {
  return client?.metadata().mock_email_optional_claim === true;
}

/**
 * A stable per-login-session identifier to use as the `sid` claim.
 *
 * oidc-provider only carries its own `Session#sidFor(clientId)` value onto
 * issued tokens for backchannel-logout clients or when the OIDC `claims`
 * request parameter explicitly asks for `sid` (see
 * `helpers/process_response_types.js`) -- neither applies to this mock, and
 * `ctx.oidc.session` at the /token endpoint is a fresh, cookie-less session
 * unrelated to the one that authenticated at /authorize, so it cannot be
 * used directly either. `sessionUid`, however, is copied verbatim from the
 * AuthorizationCode (and its RefreshToken) onto every token derived from a
 * given login, unconditionally, so it is used here as the `sid` value
 * instead. This mock does not implement backchannel logout, so it does not
 * need to match oidc-provider's own `sid` value bit-for-bit -- only be
 * stable per login session, which `sessionUid` already is.
 */
function sessionIdFor(ctx: KoaContextWithOIDC): string | undefined {
  return (
    ctx.oidc.entities.AuthorizationCode?.sessionUid ??
    ctx.oidc.entities.RefreshToken?.sessionUid ??
    ctx.oidc.session?.uid
  );
}

/**
 * Entra ID always includes `sid` once a session exists, and lets an app
 * registration request `email` independently of scope via optional claims.
 * oidc-provider has no per-token-type claims customizer for ID Tokens
 * (unlike `formats.customizers.jwt`, which only covers Access/Client
 * Credentials tokens), so this re-signs the already-issued ID Token to add
 * both claims after the fact.
 */
async function patchIdToken(
  idToken: string,
  ctx: KoaContextWithOIDC,
  keys: SigningKeys,
): Promise<string> {
  const payload = { ...decodeJwt(idToken) };
  const sid = sessionIdFor(ctx);
  if (sid) payload.sid = sid;
  const client = ctx.oidc.client;
  if (emailOptionalClaimFor(client) && payload.email === undefined) {
    const sub = typeof payload.sub === "string" ? payload.sub : undefined;
    const user = sub ? findUser(sub) : undefined;
    if (user) payload.email = user.mail;
  }
  const header = decodeProtectedHeader(idToken) as JWTHeaderParameters;
  return new SignJWT(payload)
    .setProtectedHeader(header)
    .sign(keys.normal.privateKey);
}

export function createProvider(
  config: AppConfig,
  store: InMemoryScenarioStore,
  keys: SigningKeys,
  rolloverState: SigningKeyRolloverState,
  logger: FastifyBaseLogger,
): Provider {
  const claimDecisions = new WeakMap<object, FaultDecision | null>();
  const claimDecisionFor = (ctx: {
    req: object;
    path: string;
  }): FaultDecision | null => {
    if (claimDecisions.has(ctx.req)) return claimDecisions.get(ctx.req) ?? null;
    const decision =
      ctx.path === "/token"
        ? store.consumeForRequest("claims", store.getRequestTicket(ctx.req))
        : null;
    claimDecisions.set(ctx.req, decision);
    if (decision)
      logger.warn(
        {
          scenario: decision.scenario,
          endpoint: decision.endpoint,
          mode: decision.mode,
          faultInjected: true,
          remainingBefore: decision.remainingBefore,
          remainingAfter: decision.remainingAfter,
        },
        "[MOCK-IDP] claim fault injected",
      );
    return decision;
  };
  const policy = interactionPolicy.base();
  authorizationFaultDefinitions.forEach((definition, index) => {
    policy.add(
      new interactionPolicy.Prompt(
        { name: definition.promptName, requestable: false },
        new interactionPolicy.Check(
          definition.promptName,
          definition.errorDescription,
          definition.error,
          (ctx) => {
            if (ctx.method !== "GET") return false;
            if (store.get().scenario !== definition.scenario) return false;
            const decision = store.consumeForRequest(
              "authorization",
              store.getRequestTicket(ctx.req),
            );
            if (!decision) return false;
            logger.warn(
              {
                scenario: decision.scenario,
                endpoint: decision.endpoint,
                mode: decision.mode,
                oauthError: definition.error,
                faultInjected: true,
                remainingBefore: decision.remainingBefore,
                remainingAfter: decision.remainingAfter,
              },
              "[MOCK-IDP] authorization fault injected",
            );
            return true;
          },
        ),
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

  const configuration: Configuration = {
    adapter: createInMemoryAdapterFactory(),
    jwks: { keys: [keys.normal.privateJwk] },
    claims: {
      openid: [
        "sub",
        "oid",
        "tid",
        "name",
        "preferred_username",
        "groups",
        "iat",
        "nbf",
        "ver",
        "sid",
      ],
      email: ["email"],
    },
    scopes: supportedScopes,
    responseTypes: ["code"],
    pkce: { required: () => true },
    extraClientMetadata: {
      properties: [
        "mock_access_token_audience",
        "mock_access_token_scope",
        "mock_email_optional_claim",
      ],
      validator: (_ctx, key, value) => {
        if (key === "mock_access_token_audience") {
          if (typeof value !== "string")
            throw new errors.InvalidClientMetadata(
              "mock_access_token_audience must be a string",
            );
          try {
            const resource = new URL(value);
            if (resource.username || resource.password || value.includes("#"))
              throw new Error("invalid resource URI");
          } catch {
            throw new errors.InvalidClientMetadata(
              "mock_access_token_audience must be an absolute URI without credentials or a fragment",
            );
          }
        }
        if (key === "mock_access_token_scope" && typeof value !== "string")
          throw new errors.InvalidClientMetadata(
            "mock_access_token_scope must be a string",
          );
        if (key === "mock_email_optional_claim" && typeof value !== "boolean")
          throw new errors.InvalidClientMetadata(
            "mock_email_optional_claim must be a boolean",
          );
      },
    },
    formats: {
      customizers: {
        jwt: (ctx, token, jwt) => {
          const accountId =
            "accountId" in token && typeof token.accountId === "string"
              ? token.accountId
              : undefined;
          const user = accountId ? findUser(accountId) : undefined;
          const tokenScope = "scope" in token ? token.scope : undefined;
          const client = ctx.oidc.client;
          if (user)
            Object.assign(
              jwt.payload,
              userClaims(
                user,
                claimDecisionFor(ctx),
                includesScope(tokenScope, "email") ||
                  emailOptionalClaimFor(client),
              ),
            );
          jwt.payload.ver = "2.0";
          if (client) {
            jwt.payload.azp = client.clientId;
            jwt.payload.azpacr =
              client.tokenEndpointAuthMethod === "none" ? "0" : "1";
            const scope = client.metadata().mock_access_token_scope;
            if (typeof scope === "string" && scope) jwt.payload.scp = scope;
          }
          const sid = sessionIdFor(ctx);
          if (sid) jwt.payload.sid = sid;
          if (typeof jwt.payload.iat === "number")
            jwt.payload.nbf = jwt.payload.iat;
          return jwt;
        },
      },
    },
    routes: oidcInternalRoutes,
    features: {
      devInteractions: { enabled: false },
      userinfo: { enabled: false },
      // Entra ID's discovery document does not advertise a PAR endpoint.
      pushedAuthorizationRequests: { enabled: false },
      resourceIndicators: {
        enabled: true,
        defaultResource: (_ctx, client) =>
          String(client.metadata().mock_access_token_audience),
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, resource, client) => {
          const metadata = client.metadata();
          const audience = String(metadata.mock_access_token_audience);
          if (resource !== audience) throw new errors.InvalidTarget();
          return {
            scope: supportedScopes.join(" "),
            audience,
            accessTokenFormat: "jwt",
            jwt: { sign: { alg: "RS256", kid: keys.normal.publicJwk.kid } },
          };
        },
      },
    },
    findAccount: (ctx, sub) => {
      const user = findUser(sub);
      if (!user) return undefined;
      const scenario = claimDecisionFor(ctx);
      return {
        accountId: user.sub,
        claims: (_use, scope) => {
          const issuedAt = Math.floor(Date.now() / 1000);
          return {
            ...userClaims(
              user,
              scenario,
              includesScope(scope, "email") ||
                emailOptionalClaimFor(ctx.oidc.client),
            ),
            iat: issuedAt,
            nbf: issuedAt,
            ver: "2.0",
          };
        },
      };
    },
    interactions: {
      policy,
      url: (_ctx, interaction) =>
        `${config.issuerPath}/interaction/${interaction.uid}`,
    },
    cookies: {
      keys: [
        "mock-cookie-key-one-at-least-32-bytes",
        "mock-cookie-key-two-at-least-32-bytes",
      ],
    },
    ttl: {
      AccessToken: 3600,
      AuthorizationCode: 600,
      Grant: 14 * 24 * 3600,
      IdToken: 3600,
      Interaction: 600,
      RefreshToken: 14 * 24 * 3600,
      Session: 14 * 24 * 3600,
    },
  };

  const provider = new Provider(config.issuer, configuration);
  provider.proxy = config.trustProxy;
  provider.use(async (ctx: KoaContextWithOIDC, next) => {
    await next();
    if (
      ctx.path === "/.well-known/openid-configuration" &&
      ctx.status === 200 &&
      typeof ctx.body === "object" &&
      ctx.body !== null
    ) {
      ctx.body = {
        ...(ctx.body as Record<string, unknown>),
        authorization_endpoint: `${config.issuerOrigin}${config.authorizePath}`,
        token_endpoint: `${config.issuerOrigin}${config.tokenPath}`,
        jwks_uri: `${config.issuerOrigin}${config.jwksPath}`,
        end_session_endpoint: `${config.issuerOrigin}${config.logoutPath}`,
      };
    }
    if (ctx.path === "/jwks" && ctx.status === 200 && rolloverState.published) {
      ctx.body = {
        keys: [keys.normal.publicJwk, keys.rollover.publicJwk],
      };
    }
    if (ctx.path !== "/token" || ctx.status !== 200) return;
    if (
      typeof ctx.body === "object" &&
      ctx.body !== null &&
      typeof (ctx.body as Record<string, unknown>).id_token === "string"
    ) {
      const responseBody = ctx.body as Record<string, unknown>;
      responseBody.id_token = await patchIdToken(
        responseBody.id_token as string,
        ctx,
        keys,
      );
      ctx.body = responseBody;
    }
    const ticket = store.getRequestTicket(ctx.req);
    const decision = store.consumeForRequest("token-jwt", ticket);
    if (!decision) return;
    logger.warn(
      {
        scenario: decision.scenario,
        endpoint: decision.endpoint,
        mode: decision.mode,
        faultInjected: true,
        remainingBefore: decision.remainingBefore,
        remainingAfter: decision.remainingAfter,
      },
      "[MOCK-IDP] token fault injected",
    );
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

function clientMetadata(client: OidcClientConfig): Record<string, unknown> {
  return {
    client_id: client.clientId,
    ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
    redirect_uris: client.redirectUris,
    post_logout_redirect_uris: client.postLogoutRedirectUris,
    response_types: ["code"],
    grant_types: ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    mock_access_token_audience: client.accessTokenAudience,
    mock_access_token_scope: client.accessTokenScope,
    mock_email_optional_claim: client.emailOptionalClaim,
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
export function validateProviderClient(
  provider: Provider,
  client: OidcClientConfig,
): void {
  const Client = providerClientModel(provider);
  new Client(clientMetadata(client));
}

export async function applyProviderClient(
  provider: Provider,
  client: OidcClientConfig,
): Promise<void> {
  const Client = providerClientModel(provider);
  const validated = new Client(clientMetadata(client));
  await Client.adapter.upsert(client.clientId, validated.metadata());
}

export async function removeProviderClient(
  provider: Provider,
  clientId: string,
): Promise<void> {
  const Client = providerClientModel(provider);
  await Client.adapter.destroy(clientId);
}
