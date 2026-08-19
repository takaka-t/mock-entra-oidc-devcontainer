import type Provider from "oidc-provider";
import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import {
  ClientConflictError,
  ClientNotFoundError,
  type OidcClientStore,
} from "../clients/store.js";
import type { AppConfig } from "../config.js";
import type { InMemoryScenarioStore } from "../scenario/store.js";
import { parseScenarioInput } from "../scenario/validation.js";
import { users } from "../users/users.js";
import { adminHtml } from "./ui.js";

const interactionBodySchema = z
  .object({ accountId: z.string().min(1) })
  .strict();

function interactionHtml(uid: string, issuerPath: string): string {
  const buttons = users
    .map(
      (user) =>
        `<button name="accountId" value="${user.sub}" type="submit"><strong>${user.name}</strong><small>${user.preferred_username}</small></button>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Mock sign in</title><style>body{font-family:system-ui;background:#f4f6f8;padding:3rem}.box{max-width:420px;margin:auto;background:white;padding:2rem;border-radius:12px}button{display:block;width:100%;text-align:left;padding:1rem;margin:.7rem 0;background:white;border:1px solid #bbb;border-radius:7px;cursor:pointer}small{display:block;color:#666;margin-top:.3rem}</style></head><body><main class="box"><h1>Mock Entra ID</h1><p>Select a test user</p><form method="post" action="${issuerPath}/interaction/${encodeURIComponent(uid)}">${buttons}</form></main></body></html>`;
}

export async function registerRoutes(
  app: FastifyInstance,
  provider: Provider,
  store: InMemoryScenarioStore,
  clientStore: OidcClientStore,
  config: AppConfig,
): Promise<void> {
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
  app.post("/__mock/api/reset", async () => store.reset());
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
  app.post("/__mock/api/clients/reset", async (_request, reply) =>
    reply.send(await clientStore.reset()),
  );

  app.get<{ Params: { uid: string } }>(
    `${config.issuerPath}/interaction/:uid`,
    async (request, reply) => {
      const details = await provider.interactionDetails(request.raw, reply.raw);
      if (details.prompt.name === "mock_access_denied") {
        reply.hijack();
        await provider.interactionFinished(
          request.raw,
          reply.raw,
          {
            error: "access_denied",
            error_description: "Access denied by mock scenario",
          },
          { mergeWithLastSubmission: false },
        );
        return;
      }
      if (details.prompt.name === "consent") {
        const accountId = details.session?.accountId;
        if (!accountId)
          return reply.code(400).send({ error: "missing_account" });
        const grant = details.grantId
          ? await provider.Grant.find(details.grantId)
          : new provider.Grant({
              accountId,
              clientId: String(details.params.client_id),
            });
        if (!grant) return reply.code(400).send({ error: "missing_grant" });
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
        return;
      }
      return reply
        .type("text/html; charset=utf-8")
        .send(interactionHtml(request.params.uid, config.issuerPath));
    },
  );
  app.post<{ Params: { uid: string } }>(
    `${config.issuerPath}/interaction/:uid`,
    async (request, reply) => {
      const body = interactionBodySchema.safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({ error: "invalid_interaction_body" });
      const { accountId } = body.data;
      if (!users.some((user) => user.sub === accountId))
        return reply.code(400).send({ error: "unknown_user" });
      const details = await provider.interactionDetails(request.raw, reply.raw);
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
  throw error;
}
