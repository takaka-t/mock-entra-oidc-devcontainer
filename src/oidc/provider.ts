import Provider, {
  errors,
  interactionPolicy,
  type Configuration,
} from "oidc-provider";
import type { FastifyBaseLogger } from "fastify";
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

function userClaims(
  user: MockUser,
  decision: FaultDecision | null | undefined,
  includeEmail: boolean,
): Omit<MockUser, "groups"> & { groups?: string[]; email?: string } {
  const claims: Omit<MockUser, "groups"> & {
    groups?: string[];
    email?: string;
  } = {
    ...user,
    ...(includeEmail ? { email: user.mail } : {}),
    groups: [...user.groups],
  };
  if (decision?.scenario === "NO_GROUPS") delete claims.groups;
  return claims;
}

const supportedScopes = ["openid", "profile", "email", "offline_access"];

function includesScope(value: unknown, scope: string): boolean {
  return typeof value === "string" && value.split(" ").includes(scope);
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
        "mail",
        "groups",
        "iat",
        "nbf",
      ],
      email: ["email"],
    },
    scopes: supportedScopes,
    responseTypes: ["code"],
    pkce: { required: () => true },
    extraClientMetadata: {
      properties: ["mock_access_token_audience"],
      validator: (_ctx, key, value) => {
        if (key !== "mock_access_token_audience" || typeof value !== "string")
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
          if (user)
            Object.assign(
              jwt.payload,
              userClaims(
                user,
                claimDecisionFor(ctx),
                includesScope(tokenScope, "email"),
              ),
            );
          if (typeof jwt.payload.iat === "number")
            jwt.payload.nbf = jwt.payload.iat;
          return jwt;
        },
      },
    },
    routes: { authorization: "/authorize", token: "/token", jwks: "/jwks" },
    features: {
      devInteractions: { enabled: false },
      userinfo: { enabled: false },
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
            ...userClaims(user, scenario, includesScope(scope, "email")),
            iat: issuedAt,
            nbf: issuedAt,
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
  provider.use(async (ctx, next) => {
    await next();
    if (ctx.path === "/jwks" && ctx.status === 200 && rolloverState.published) {
      ctx.body = {
        keys: [keys.normal.publicJwk, keys.rollover.publicJwk],
      };
    }
    if (ctx.path !== "/token" || ctx.status !== 200) return;
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
