import { ApiResourceStore, ResourceConflictError, ResourceNotFoundError } from "../resources/store.js";
import { guid, scopeName } from "../resources/validation.js";
import { resolveScopes } from "../oidc/scopes.js";
import type Provider from "oidc-provider";
import type { InMemoryAccessLog } from "../access-log/store.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import {
  ClientConflictError,
  ClientNotFoundError,
  ClientValidationError,
  type OidcClientStore,
} from "../clients/store.js";
import type { AppConfig } from "../config.js";
import { issueAccessToken } from "../oidc/direct-token.js";
import type { SigningKeys } from "../oidc/keys.js";
import { identifier } from "../validation/common.js";
import { authorizationFaultForPrompt, type AuthorizationFaultDefinition } from "../faults/authorization-fault.js";
import { routedPathname } from "../http-path.js";
import type { InMemoryScenarioStore } from "../scenario/store.js";
import { parseScenarioInput } from "../scenario/validation.js";
import { UserConflictError, UserNotFoundError, type MockUserStore } from "../users/store.js";
import type { MockUser } from "../users/types.js";
import { escapeHtml } from "./html.js";
import { renderAdminHtml } from "./ui.js";

const interactionBodySchema = z.object({ accountId: z.string().min(1) }).strict();
const resetBodySchema = z.object({}).strict();
const tokenBodySchema = z
  .object({ clientId: guid, userId: identifier, resourceAppId: guid, scopes: z.array(scopeName).min(1) })
  .strict();

function adminMutation(method: string, requestPath: string): boolean {
  return requestPath.startsWith("/__mock/") && ["DELETE", "PATCH", "POST", "PUT"].includes(method);
}

function adminJsonMutation(method: string, requestPath: string): boolean {
  return requestPath.startsWith("/__mock/api/") && (method === "POST" || method === "PUT" || method === "PATCH");
}

function sameOrigin(value: string | string[] | undefined, expectedOrigin: string): boolean {
  if (value === undefined) return true;
  if (Array.isArray(value) || !value || value.includes(",")) return false;
  try {
    const origin = new URL(value);
    return value === origin.origin && origin.origin === expectedOrigin;
  } catch {
    return false;
  }
}

function applicationJson(value: string | string[] | undefined): boolean {
  if (typeof value !== "string") return false;
  return value.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function invalidResetBody(reply: FastifyReply) {
  return reply.code(400).send({
    error: "invalid_reset_body",
    message: "リセット要求の本文は空の JSON オブジェクト {} にしてください",
  });
}

const userFieldLabels: Record<string, string> = {
  sub: "ユーザー ID（sub）",
  oid: "オブジェクト ID（oid）",
  name: "表示名（name）",
  preferred_username: "優先ユーザー名（preferred_username）",
  mail: "メールアドレス（mail）",
  groups: "グループ（groups）",
};

const clientFieldLabels: Record<string, string> = {
  clientId: "クライアント ID（client_id）",
  clientType: "クライアント種別（clientType）",
  clientSecret: "クライアントシークレット（client_secret）",
  tokenEndpointAuthMethod: "トークンエンドポイント認証方式（tokenEndpointAuthMethod）",
  redirectUris: "リダイレクト URI（redirectUris）",
  requiredResourceAccess: "API 権限（requiredResourceAccess）",
  groupMembershipClaims: "グループ claim 設定（groupMembershipClaims）",
  emailOptionalClaim: "email claim（email）",
};

function localizedZodMessage(issue: ZodError["issues"][number]): string {
  if (issue.code === "custom") return issue.message;
  if (issue.code === "unrecognized_keys") return `未対応の項目が含まれています: ${issue.keys.join(", ")}`;
  if (issue.code === "invalid_type") return "値の型が正しくありません";
  if (issue.code === "invalid_format") return "形式が正しくありません";
  if (issue.code === "too_small") return "値が短すぎるか、少なすぎます";
  if (issue.code === "too_big") return "値が長すぎるか、多すぎます";
  return "入力値が正しくありません";
}

function formatZodIssues(error: ZodError, fieldLabels: Record<string, string> = {}): string {
  return error.issues
    .map((issue) => {
      const field = issue.path[0];
      const label = typeof field === "string" ? (fieldLabels[field] ?? field) : undefined;
      return label ? `${label}：${localizedZodMessage(issue)}` : localizedZodMessage(issue);
    })
    .join("; ");
}

function registrationIssues(error: ZodError) {
  return error.issues.map((issue) => {
    let message = localizedZodMessage(issue);
    if (issue.code === "invalid_format" && issue.format === "guid") message = "GUID形式で入力してください";
    if (issue.code === "invalid_format" && issue.format === "email") message = "有効なメールアドレスを入力してください";
    if (issue.code === "too_small")
      message = issue.origin === "array" ? "1件以上入力してください" : "値を入力してください";
    if (issue.code === "too_big") message = `${issue.maximum}以下にしてください（文字数または件数）`;
    return { path: issue.path.filter((part) => typeof part === "string" || typeof part === "number"), message };
  });
}

function interactionHtml(uid: string, issuerPath: string, users: readonly MockUser[]): string {
  const buttons = users
    .map(
      (user) =>
        `<button name="accountId" value="${escapeHtml(user.sub)}" type="submit"><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.preferred_username)}</small></button>`,
    )
    .join("");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Mock Entra ID にサインイン</title><style>body{font-family:system-ui;background:#f4f6f8;padding:3rem}.box{max-width:420px;margin:auto;background:white;padding:2rem;border-radius:12px}button{display:block;width:100%;text-align:left;padding:1rem;margin:.7rem 0;background:white;border:1px solid #bbb;border-radius:7px;cursor:pointer}small{display:block;color:#666;margin-top:.3rem}</style></head><body><main class="box"><h1>Mock Entra ID にサインイン</h1><p>テストユーザーを選択してください。</p><form method="post" action="${issuerPath}/interaction/${encodeURIComponent(uid)}">${buttons}</form></main></body></html>`;
}

type InteractionDetails = Awaited<ReturnType<Provider["interactionDetails"]>>;

async function finishAuthorizationFault(
  provider: Provider,
  request: FastifyRequest,
  reply: FastifyReply,
  fault: AuthorizationFaultDefinition,
): Promise<void> {
  reply.hijack();
  await provider.interactionFinished(
    request.raw,
    reply.raw,
    {
      error: fault.error,
      error_description: fault.errorDescription,
    },
    { mergeWithLastSubmission: false },
  );
}

async function consentInteraction(
  provider: Provider,
  request: FastifyRequest,
  reply: FastifyReply,
  details: InteractionDetails,
): Promise<boolean> {
  const accountId = details.session?.accountId;
  if (!accountId) {
    await reply.code(400).send({ error: "missing_account" });
    return false;
  }
  const grant = details.grantId
    ? await provider.Grant.find(details.grantId)
    : new provider.Grant({
        accountId,
        clientId: String(details.params.client_id),
      });
  if (!grant) {
    await reply.code(400).send({ error: "missing_grant" });
    return false;
  }
  const promptDetails = details.prompt.details as {
    missingOIDCScope?: string[];
    missingOIDCClaims?: string[];
    missingResourceScopes?: Record<string, string[]>;
  };
  if (promptDetails.missingOIDCScope?.length) grant.addOIDCScope(promptDetails.missingOIDCScope.join(" "));
  if (promptDetails.missingOIDCClaims?.length) grant.addOIDCClaims(promptDetails.missingOIDCClaims);
  for (const [resource, scopes] of Object.entries(promptDetails.missingResourceScopes ?? {}))
    grant.addResourceScope(resource, scopes.join(" "));
  const grantId = await grant.save();
  reply.hijack();
  await provider.interactionFinished(
    request.raw,
    reply.raw,
    { consent: { grantId } },
    { mergeWithLastSubmission: true },
  );
  return true;
}

function unsupportedPrompt(reply: FastifyReply, prompt: string) {
  return reply.code(400).send({
    error: "unsupported_interaction_prompt",
    message: `対応していないインタラクションプロンプトです: ${prompt}`,
  });
}

export async function registerRoutes(
  app: FastifyInstance,
  provider: Provider,
  store: InMemoryScenarioStore,
  clientStore: OidcClientStore,
  userStore: MockUserStore,
  accessLog: InMemoryAccessLog,
  config: AppConfig,
  keys: SigningKeys,
  resourceStore: ApiResourceStore,
): Promise<void> {
  app.addHook("onRequest", async (request, reply) => {
    const requestPath = routedPathname(request.url);
    if (!adminMutation(request.method, requestPath)) return;
    if (!sameOrigin(request.headers.origin, config.issuerOrigin)) {
      await reply.code(403).send({
        error: "invalid_admin_origin",
        message: "Origin が設定済みの Issuer（issuer）と一致しません",
      });
      return;
    }
    if (adminJsonMutation(request.method, requestPath) && !applicationJson(request.headers["content-type"])) {
      await reply.code(415).send({
        error: "unsupported_media_type",
        message: "管理 API のリクエスト本文には application/json を使用してください",
      });
    }
  });

  app.get("/health", async () => ({ status: "ok" }));
  const adminUi = async (_request: FastifyRequest, reply: FastifyReply) =>
    reply
      .type("text/html; charset=utf-8")
      .send(renderAdminHtml(config.tenantId, config.issuer, `${config.issuerOrigin}${config.logoutPath}`));
  // The Admin UI URL is typed by hand, so tolerate a trailing slash the way the
  // OIDC endpoints do; the API paths stay exact.
  app.get("/__mock", adminUi);
  app.get("/__mock/", adminUi);
  app.get("/__mock/api/scenario", async () => store.get());
  app.post("/__mock/api/tokens", async (request, reply) => {
    const parsed = tokenBodySchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({
        error: "invalid_token_request",
        message: formatZodIssues(parsed.error, {
          clientId: "クライアント ID（clientId）",
          userId: "ユーザー ID（userId）",
        }),
      });
    const client = clientStore.list().find((entry) => entry.clientId === parsed.data.clientId);
    if (!client) return clientError(reply, new ClientNotFoundError());
    const user = userStore.find(parsed.data.userId);
    if (!user) return userError(reply, new UserNotFoundError());
    try {
      const resource = resourceStore.find(parsed.data.resourceAppId);
      if (!resource) return reply.code(404).send({ error: "resource_not_found" });
      const resolved = resolveScopes(
        parsed.data.scopes.map((scope) => `${resource.identifierUri}/${scope}`).join(" "),
        client,
        resourceStore,
      );
      const result = await issueAccessToken(
        config,
        keys,
        store,
        client,
        resource,
        resolved.targets[0]!.scopes,
        user,
        store.getRequestTicket(request.raw),
      );
      if (result.fault)
        app.log.warn({ ...result.fault, faultInjected: true }, "[MOCK-IDP] direct token fault injected");
      return result;
    } catch (error) {
      if (error instanceof Error && error.name === "InvalidScope")
        return reply.code(400).send({ error: "invalid_scope", message: error.message });
      app.log.error({ err: error }, "[MOCK-IDP] direct token issuance failed");
      return reply.code(500).send({ error: "token_issue_failed", message: "アクセストークンの発行に失敗しました" });
    }
  });
  app.put("/__mock/api/scenario", async (request, reply) => {
    try {
      return store.set(parseScenarioInput(request.body));
    } catch (error) {
      return reply.code(400).send({
        error: "invalid_scenario",
        message: error instanceof ZodError ? formatZodIssues(error) : (error as Error).message,
      });
    }
  });
  app.delete("/__mock/api/scenario", async () => store.clear());
  app.post("/__mock/api/reset", async (request, reply) => {
    if (!resetBodySchema.safeParse(request.body).success) return invalidResetBody(reply);
    return store.reset();
  });
  app.get("/__mock/api/resources", async () => resourceStore.list());
  app.post("/__mock/api/resources", async (request, reply) => {
    try {
      return reply.code(201).send(await resourceStore.create(request.body));
    } catch (error) {
      return resourceError(reply, error);
    }
  });
  app.put<{ Params: { id: string } }>("/__mock/api/resources/:id", async (request, reply) => {
    try {
      return await resourceStore.update(request.params.id, request.body);
    } catch (error) {
      return resourceError(reply, error);
    }
  });
  app.delete<{ Params: { id: string } }>("/__mock/api/resources/:id", async (request, reply) => {
    try {
      await resourceStore.delete(request.params.id);
      return reply.code(204).send();
    } catch (error) {
      return resourceError(reply, error);
    }
  });
  app.post("/__mock/api/resources/reset", async (request, reply) => {
    if (!resetBodySchema.safeParse(request.body).success) return invalidResetBody(reply);
    try {
      return await resourceStore.reset();
    } catch (error) {
      return resourceError(reply, error);
    }
  });
  app.get("/__mock/api/clients", async () => clientStore.list());
  app.post("/__mock/api/clients", async (request, reply) => {
    try {
      return reply.code(201).send(await clientStore.create(request.body as never));
    } catch (error) {
      return clientError(reply, error);
    }
  });
  app.put<{ Params: { clientId: string } }>("/__mock/api/clients/:clientId", async (request, reply) => {
    try {
      return await clientStore.update(request.params.clientId, request.body as never);
    } catch (error) {
      return clientError(reply, error);
    }
  });
  app.delete<{ Params: { clientId: string } }>("/__mock/api/clients/:clientId", async (request, reply) => {
    try {
      await clientStore.delete(request.params.clientId);
      return reply.code(204).send();
    } catch (error) {
      return clientError(reply, error);
    }
  });
  app.post("/__mock/api/clients/reset", async (request, reply) => {
    if (!resetBodySchema.safeParse(request.body).success) return invalidResetBody(reply);
    try {
      return reply.send(await clientStore.reset());
    } catch (error) {
      return clientError(reply, error);
    }
  });
  app.get("/__mock/api/users", async () => userStore.list());
  app.post("/__mock/api/users", async (request, reply) => {
    try {
      return reply.code(201).send(await userStore.create(request.body as never));
    } catch (error) {
      return userError(reply, error);
    }
  });
  app.put<{ Params: { sub: string } }>("/__mock/api/users/:sub", async (request, reply) => {
    try {
      return await userStore.update(request.params.sub, request.body as never);
    } catch (error) {
      return userError(reply, error);
    }
  });
  app.delete<{ Params: { sub: string } }>("/__mock/api/users/:sub", async (request, reply) => {
    try {
      await userStore.delete(request.params.sub);
      return reply.code(204).send();
    } catch (error) {
      return userError(reply, error);
    }
  });
  app.post("/__mock/api/users/reset", async (request, reply) => {
    if (!resetBodySchema.safeParse(request.body).success) return invalidResetBody(reply);
    return reply.send(await userStore.reset());
  });
  app.get("/__mock/api/access-log", async () => accessLog.list());
  app.delete("/__mock/api/access-log", async (_request, reply) => {
    accessLog.clear();
    return reply.code(204).send();
  });

  app.get<{ Params: { uid: string } }>(`${config.issuerPath}/interaction/:uid`, async (request, reply) => {
    const details = await provider.interactionDetails(request.raw, reply.raw);
    const authorizationFault = authorizationFaultForPrompt(details.prompt.name);
    if (authorizationFault) {
      await finishAuthorizationFault(provider, request, reply, authorizationFault);
      return;
    }
    switch (details.prompt.name) {
      case "consent":
        await consentInteraction(provider, request, reply, details);
        return;
      case "login":
      case "select_account":
        return reply
          .type("text/html; charset=utf-8")
          .send(interactionHtml(request.params.uid, config.issuerPath, userStore.list()));
      default:
        return unsupportedPrompt(reply, details.prompt.name);
    }
  });
  app.post<{ Params: { uid: string } }>(`${config.issuerPath}/interaction/:uid`, async (request, reply) => {
    const details = await provider.interactionDetails(request.raw, reply.raw);
    const authorizationFault = authorizationFaultForPrompt(details.prompt.name);
    if (authorizationFault) {
      await finishAuthorizationFault(provider, request, reply, authorizationFault);
      return;
    }
    if (details.prompt.name === "consent") {
      await consentInteraction(provider, request, reply, details);
      return;
    }
    if (details.prompt.name !== "login" && details.prompt.name !== "select_account")
      return unsupportedPrompt(reply, details.prompt.name);
    const body = interactionBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_interaction_body" });
    const { accountId } = body.data;
    const user = userStore.find(accountId);
    if (!user) return reply.code(400).send({ error: "unknown_user" });
    const requestedPrompts = new Set(typeof details.params.prompt === "string" ? details.params.prompt.split(" ") : []);
    reply.hijack();
    await provider.interactionFinished(
      request.raw,
      reply.raw,
      {
        login: {
          accountId: user.oid,
          acr: "urn:mace:incommon:iap:password",
          amr: ["pwd"],
          remember: false,
        },
        ...(details.prompt.name === "select_account" || requestedPrompts.has("select_account")
          ? { select_account: {} }
          : {}),
      },
      { mergeWithLastSubmission: false },
    );
  });
}

function userError(reply: FastifyReply, error: unknown) {
  if (error instanceof UserConflictError)
    return reply.code(409).send({
      error: "user_conflict",
      message: "同じユーザー ID、オブジェクト ID、または優先ユーザー名を持つテストユーザーが既に登録されています",
    });
  if (error instanceof UserNotFoundError)
    return reply.code(404).send({
      error: "user_not_found",
      message: "指定されたテストユーザーが見つかりません",
    });
  if (error instanceof ZodError)
    return reply.code(400).send({
      error: "invalid_user",
      message: formatZodIssues(error, userFieldLabels),
      issues: registrationIssues(error),
    });
  throw error;
}

function clientError(reply: import("fastify").FastifyReply, error: unknown) {
  if (error instanceof ClientConflictError)
    return reply.code(409).send({
      error: "client_conflict",
      message: "同じクライアント ID を持つ OIDC クライアントが既に登録されています",
    });
  if (error instanceof ClientNotFoundError)
    return reply.code(404).send({
      error: "client_not_found",
      message: "指定された OIDC クライアントが見つかりません",
    });
  if (error instanceof ZodError)
    return reply.code(400).send({
      error: "invalid_client",
      message: formatZodIssues(error, clientFieldLabels),
      issues: registrationIssues(error),
    });
  if (error instanceof ClientValidationError)
    return reply.code(400).send({
      error: "invalid_client",
      message: `クライアント「${error.clientId}」の設定が正しくありません: ${error.message}`,
    });
  throw error;
}

function resourceError(reply: FastifyReply, error: unknown) {
  if (error instanceof ResourceConflictError)
    return reply.code(409).send({ error: "resource_conflict", message: error.message });
  if (error instanceof ResourceNotFoundError) return reply.code(404).send({ error: "resource_not_found" });
  if (error instanceof ZodError)
    return reply
      .code(400)
      .send({ error: "invalid_resource", message: formatZodIssues(error), issues: registrationIssues(error) });
  throw error;
}
