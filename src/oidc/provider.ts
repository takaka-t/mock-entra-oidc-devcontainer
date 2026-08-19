import Provider, {
  errors,
  interactionPolicy,
  type Configuration,
} from "oidc-provider";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config.js";
import type { OidcClientConfig } from "../clients/types.js";
import { mutateTokenResponse } from "../faults/token-generator.js";
import type { InMemoryScenarioStore } from "../scenario/store.js";
import type { FaultDecision } from "../scenario/types.js";
import { findUser, type MockUser } from "../users/users.js";
import type { SigningKeys } from "./keys.js";

function userClaims(
  user: MockUser,
  decision: FaultDecision | null | undefined,
): Omit<MockUser, "groups"> & { groups?: string[]; email: string } {
  const claims: Omit<MockUser, "groups"> & {
    groups?: string[];
    email: string;
  } = {
    ...user,
    email: user.mail,
    groups: [...user.groups],
  };
  if (decision?.scenario === "NO_GROUPS") delete claims.groups;
  if (decision?.scenario === "UNKNOWN_GROUPS")
    claims.groups = ["unknown-group-id"];
  return claims;
}

export function createProvider(
  config: AppConfig,
  store: InMemoryScenarioStore,
  keys: SigningKeys,
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
        ? store.consume("claims", store.getRequestTicket(ctx.req))
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
  policy.add(
    new interactionPolicy.Prompt(
      { name: "mock_access_denied", requestable: false },
      new interactionPolicy.Check(
        "mock_access_denied",
        "Access denied by mock scenario",
        "access_denied",
        (ctx) => {
          const decision = store.consume(
            "authorization",
            store.getRequestTicket(ctx.req),
          );
          if (!decision) return false;
          logger.warn(
            {
              scenario: decision.scenario,
              endpoint: decision.endpoint,
              mode: decision.mode,
              faultInjected: true,
              remainingBefore: decision.remainingBefore,
              remainingAfter: decision.remainingAfter,
            },
            "[MOCK-IDP] authorization denied",
          );
          return true;
        },
      ),
    ),
    0,
  );
  policy.add(
    new interactionPolicy.Prompt({
      name: "select_account",
      requestable: true,
    }),
    2,
  );

  const configuration: Configuration = {
    jwks: { keys: [keys.normal.privateJwk] },
    claims: {
      openid: [
        "sub",
        "oid",
        "tid",
        "name",
        "preferred_username",
        "mail",
        "email",
        "groups",
        "iat",
        "nbf",
      ],
    },
    scopes: ["openid", "profile", "email", "offline_access"],
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
          new URL(value);
        } catch {
          throw new errors.InvalidClientMetadata(
            "mock_access_token_audience must be an absolute URI",
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
          if (user)
            Object.assign(jwt.payload, userClaims(user, claimDecisionFor(ctx)));
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
            scope: String(metadata.scope),
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
        claims: () => {
          const issuedAt = Math.floor(Date.now() / 1000);
          return {
            ...userClaims(user, scenario),
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
    if (ctx.path !== "/token" || ctx.status !== 200) return;
    const ticket = store.getRequestTicket(ctx.req);
    const decision = store.consume("token-jwt", ticket);
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
    ctx.body = await mutateTokenResponse(ctx.body, decision, keys);
  });
  return provider;
}

type ClientAdapter = {
  upsert(id: string, payload: Record<string, unknown>): Promise<void>;
  destroy(id: string): Promise<void>;
};

function clientMetadata(client: OidcClientConfig): Record<string, unknown> {
  return {
    client_id: client.clientId,
    ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
    redirect_uris: client.redirectUris,
    post_logout_redirect_uris: client.postLogoutRedirectUris,
    response_types: ["code"],
    grant_types: [
      "authorization_code",
      ...(client.scopes.includes("offline_access") ? ["refresh_token"] : []),
    ],
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    scope: client.scopes.join(" "),
    mock_access_token_audience: client.accessTokenAudience,
  };
}

export async function applyProviderClient(
  provider: Provider,
  client: OidcClientConfig,
): Promise<void> {
  const Client = provider.Client as unknown as {
    new (metadata: Record<string, unknown>): {
      metadata(): Record<string, unknown>;
    };
    adapter: ClientAdapter;
  };
  const validated = new Client(clientMetadata(client));
  await Client.adapter.upsert(client.clientId, validated.metadata());
}

export async function removeProviderClient(
  provider: Provider,
  clientId: string,
): Promise<void> {
  const Client = provider.Client as unknown as { adapter: ClientAdapter };
  await Client.adapter.destroy(clientId);
}
