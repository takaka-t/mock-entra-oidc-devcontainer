import type Provider from "oidc-provider";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import {
  ClientConflictError,
  ClientNotFoundError,
  ClientValidationError,
  type OidcClientStore,
} from "../clients/store.js";
import type { AppConfig } from "../config.js";
import {
  authorizationFaultForPrompt,
  type AuthorizationFaultDefinition,
} from "../faults/authorization-fault.js";
import { routedPathname } from "../http-path.js";
import type { InMemoryScenarioStore } from "../scenario/store.js";
import { parseScenarioInput } from "../scenario/validation.js";
import { users } from "../users/users.js";
import { adminHtml } from "./ui.js";

const interactionBodySchema = z
  .object({ accountId: z.string().min(1) })
  .strict();
const resetBodySchema = z.object({}).strict();

function adminMutation(method: string, requestPath: string): boolean {
  return (
    requestPath.startsWith("/__mock/") &&
    ["DELETE", "PATCH", "POST", "PUT"].includes(method)
  );
}

function adminJsonMutation(method: string, requestPath: string): boolean {
  return (
    requestPath.startsWith("/__mock/api/") &&
    (method === "POST" || method === "PUT" || method === "PATCH")
  );
}

function sameOrigin(
  value: string | string[] | undefined,
  expectedOrigin: string,
): boolean {
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
    message: "Reset body must be an empty JSON object",
  });
}

function interactionHtml(uid: string, issuerPath: string): string {
  const buttons = users
    .map(
      (user) =>
        `<button name="accountId" value="${user.sub}" type="submit"><strong>${user.name}</strong><small>${user.preferred_username}</small></button>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Mock sign in</title><style>body{font-family:system-ui;background:#f4f6f8;padding:3rem}.box{max-width:420px;margin:auto;background:white;padding:2rem;border-radius:12px}button{display:block;width:100%;text-align:left;padding:1rem;margin:.7rem 0;background:white;border:1px solid #bbb;border-radius:7px;cursor:pointer}small{display:block;color:#666;margin-top:.3rem}</style></head><body><main class="box"><h1>Mock Entra ID</h1><p>Select a test user</p><form method="post" action="${issuerPath}/interaction/${encodeURIComponent(uid)}">${buttons}</form></main></body></html>`;
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
  if (promptDetails.missingOIDCScope?.length)
    grant.addOIDCScope(promptDetails.missingOIDCScope.join(" "));
  if (promptDetails.missingOIDCClaims?.length)
    grant.addOIDCClaims(promptDetails.missingOIDCClaims);
  for (const [resource, scopes] of Object.entries(
    promptDetails.missingResourceScopes ?? {},
  ))
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
    message: `Unsupported interaction prompt: ${prompt}`,
  });
}

export async function registerRoutes(
  app: FastifyInstance,
  provider: Provider,
  store: InMemoryScenarioStore,
  clientStore: OidcClientStore,
  config: AppConfig,
): Promise<void> {
  app.addHook("onRequest", async (request, reply) => {
    const requestPath = routedPathname(request.url);
    if (!adminMutation(request.method, requestPath)) return;
    if (!sameOrigin(request.headers.origin, config.issuerOrigin)) {
      await reply.code(403).send({
        error: "invalid_admin_origin",
        message: "Origin does not match OIDC_ISSUER",
      });
      return;
    }
    if (
      adminJsonMutation(request.method, requestPath) &&
      !applicationJson(request.headers["content-type"])
    ) {
      await reply.code(415).send({
        error: "unsupported_media_type",
        message: "Admin request body must use application/json",
      });
    }
  });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/__mock", async (_request, reply) =>
    reply.type("text/html; charset=utf-8").send(adminHtml),
  );
  app.get("/__mock/api/scenario", async () => store.get());
  app.put("/__mock/api/scenario", async (request, reply) => {
    try {
      return store.set(parseScenarioInput(request.body));
    } catch (error) {
      return reply.code(400).send({
        error: "invalid_scenario",
        message:
          error instanceof ZodError
            ? error.issues.map((issue) => issue.message).join("; ")
            : (error as Error).message,
      });
    }
  });
  app.delete("/__mock/api/scenario", async () => store.clear());
  app.post("/__mock/api/reset", async (request, reply) => {
    if (!resetBodySchema.safeParse(request.body).success)
      return invalidResetBody(reply);
    return store.reset();
  });
  app.get("/__mock/api/clients", async () => clientStore.list());
  app.post("/__mock/api/clients", async (request, reply) => {
    try {
      return reply
        .code(201)
        .send(await clientStore.create(request.body as never));
    } catch (error) {
      return clientError(reply, error);
    }
  });
  app.put<{ Params: { clientId: string } }>(
    "/__mock/api/clients/:clientId",
    async (request, reply) => {
      try {
        return await clientStore.update(
          request.params.clientId,
          request.body as never,
        );
      } catch (error) {
        return clientError(reply, error);
      }
    },
  );
  app.delete<{ Params: { clientId: string } }>(
    "/__mock/api/clients/:clientId",
    async (request, reply) => {
      try {
        await clientStore.delete(request.params.clientId);
        return reply.code(204).send();
      } catch (error) {
        return clientError(reply, error);
      }
    },
  );
  app.post("/__mock/api/clients/reset", async (request, reply) => {
    if (!resetBodySchema.safeParse(request.body).success)
      return invalidResetBody(reply);
    return reply.send(await clientStore.reset());
  });

  app.get<{ Params: { uid: string } }>(
    `${config.issuerPath}/interaction/:uid`,
    async (request, reply) => {
      const details = await provider.interactionDetails(request.raw, reply.raw);
      const authorizationFault = authorizationFaultForPrompt(
        details.prompt.name,
      );
      if (authorizationFault) {
        await finishAuthorizationFault(
          provider,
          request,
          reply,
          authorizationFault,
        );
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
            .send(interactionHtml(request.params.uid, config.issuerPath));
        default:
          return unsupportedPrompt(reply, details.prompt.name);
      }
    },
  );
  app.post<{ Params: { uid: string } }>(
    `${config.issuerPath}/interaction/:uid`,
    async (request, reply) => {
      const details = await provider.interactionDetails(request.raw, reply.raw);
      const authorizationFault = authorizationFaultForPrompt(
        details.prompt.name,
      );
      if (authorizationFault) {
        await finishAuthorizationFault(
          provider,
          request,
          reply,
          authorizationFault,
        );
        return;
      }
      if (details.prompt.name === "consent") {
        await consentInteraction(provider, request, reply, details);
        return;
      }
      if (
        details.prompt.name !== "login" &&
        details.prompt.name !== "select_account"
      )
        return unsupportedPrompt(reply, details.prompt.name);
      const body = interactionBodySchema.safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({ error: "invalid_interaction_body" });
      const { accountId } = body.data;
      if (!users.some((user) => user.sub === accountId))
        return reply.code(400).send({ error: "unknown_user" });
      const requestedPrompts = new Set(
        typeof details.params.prompt === "string"
          ? details.params.prompt.split(" ")
          : [],
      );
      reply.hijack();
      await provider.interactionFinished(
        request.raw,
        reply.raw,
        {
          login: {
            accountId,
            acr: "urn:mace:incommon:iap:password",
            amr: ["pwd"],
            remember: false,
          },
          ...(details.prompt.name === "select_account" ||
          requestedPrompts.has("select_account")
            ? { select_account: {} }
            : {}),
        },
        { mergeWithLastSubmission: false },
      );
    },
  );
}

function clientError(reply: import("fastify").FastifyReply, error: unknown) {
  if (error instanceof ClientConflictError)
    return reply
      .code(409)
      .send({ error: "client_conflict", message: error.message });
  if (error instanceof ClientNotFoundError)
    return reply
      .code(404)
      .send({ error: "client_not_found", message: error.message });
  if (error instanceof ZodError)
    return reply.code(400).send({
      error: "invalid_client",
      message: error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    });
  if (error instanceof ClientValidationError)
    return reply
      .code(400)
      .send({ error: "invalid_client", message: error.message });
  throw error;
}
