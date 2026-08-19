import Provider, { interactionPolicy, type Configuration } from "oidc-provider";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config.js";
import { mutateTokenResponse } from "../faults/token-generator.js";
import type { InMemoryScenarioStore } from "../scenario/store.js";
import type { FaultDecision } from "../scenario/types.js";
import { findUser, type MockUser } from "../users/users.js";
import type { SigningKeys } from "./keys.js";

function userClaims(
  user: MockUser,
  decision: FaultDecision | null | undefined,
): Omit<MockUser, "groups"> & { groups?: string[] } {
  const claims: Omit<MockUser, "groups"> & { groups?: string[] } = {
    ...user,
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
    clients: [
      {
        client_id: config.publicClientId,
        redirect_uris: config.redirectUris,
        response_types: ["code"],
        grant_types: ["authorization_code"],
        token_endpoint_auth_method: "none",
      },
      {
        client_id: config.confidentialClientId,
        client_secret: config.confidentialClientSecret,
        redirect_uris: config.redirectUris,
        response_types: ["code"],
        grant_types: ["authorization_code"],
        token_endpoint_auth_method: "client_secret_basic",
      },
    ],
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
    },
    scopes: ["openid", "profile"],
    responseTypes: ["code"],
    pkce: { required: () => true },
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
        defaultResource: () => config.accessTokenAudience,
        useGrantedResource: () => true,
        getResourceServerInfo: () => ({
          scope: "openid profile",
          audience: config.accessTokenAudience,
          accessTokenFormat: "jwt",
          jwt: { sign: { alg: "RS256", kid: keys.normal.publicJwk.kid } },
        }),
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
