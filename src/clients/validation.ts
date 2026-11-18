import { z } from "zod";
import { clientTypes, tokenEndpointAuthMethods, type OidcClientConfig, type UpdateOidcClientInput } from "./types.js";
import { printableAscii, unique } from "../validation/common.js";
import { guid, scopeName, groupMembershipClaims } from "../resources/validation.js";
import { validRedirect, redirectMatches } from "./redirect-uri.js";
const redirect = z
  .object({ uri: z.string(), type: z.enum(["spa", "web", "native"]) })
  .strict()
  .refine((item) => validRedirect(item.uri, item.type), "リダイレクト URI の形式または scheme が正しくありません");
const commonShape = {
  clientType: z.enum(clientTypes),
  clientSecret: printableAscii.optional(),
  tokenEndpointAuthMethod: z.enum(tokenEndpointAuthMethods),
  redirectUris: z.array(redirect).min(1).max(256),
  requiredResourceAccess: z.array(
    z.object({ resourceAppId: guid, scopes: z.array(scopeName).min(1).transform(unique) }).strict(),
  ),
  emailOptionalClaim: z.boolean(),
  groupMembershipClaims,
};
function refineClient(value: Omit<OidcClientConfig, "clientId">, ctx: z.RefinementCtx) {
  if (value.clientType === "PUBLIC" && value.clientSecret !== undefined)
    ctx.addIssue({
      code: "custom",
      path: ["clientSecret"],
      message: "PUBLIC クライアントにはクライアントシークレットを指定できません",
    });
  if (value.clientType === "PUBLIC" && value.tokenEndpointAuthMethod !== "none")
    ctx.addIssue({
      code: "custom",
      path: ["tokenEndpointAuthMethod"],
      message: "PUBLIC クライアントの認証方式は none にしてください",
    });
  if (value.clientType === "CONFIDENTIAL" && (!value.clientSecret || value.tokenEndpointAuthMethod === "none"))
    ctx.addIssue({
      code: "custom",
      path: ["clientSecret"],
      message: "CONFIDENTIAL クライアントには secret と認証方式が必要です",
    });
  if (value.clientType === "PUBLIC" && value.redirectUris.some((item) => item.type === "web"))
    ctx.addIssue({
      code: "custom",
      path: ["redirectUris"],
      message: "Web リダイレクトには CONFIDENTIAL クライアントを使用してください",
    });
  if (value.clientType === "CONFIDENTIAL" && value.redirectUris.some((item) => item.type === "spa"))
    ctx.addIssue({
      code: "custom",
      path: ["redirectUris"],
      message: "SPA リダイレクトには PUBLIC クライアントを使用してください",
    });
  for (let index = 0; index < value.redirectUris.length; index++)
    if (value.redirectUris.slice(0, index).some((item) => redirectMatches(item.uri, value.redirectUris[index]!.uri)))
      ctx.addIssue({
        code: "custom",
        path: ["redirectUris", index, "uri"],
        message: "localhost のポートだけが異なる URI を含め、同じ URI は重複登録できません",
      });
  if (
    new Set(value.requiredResourceAccess.map((item) => item.resourceAppId)).size !== value.requiredResourceAccess.length
  )
    ctx.addIssue({ code: "custom", path: ["requiredResourceAccess"], message: "API 権限の登録が重複しています" });
}
export const createClientSchema = z
  .object({ clientId: guid, ...commonShape })
  .strict()
  .superRefine(refineClient);
export const updateClientSchema = z.object(commonShape).strict().superRefine(refineClient);
export const persistedClientSchema = createClientSchema;
export function parseCreateClient(input: unknown): OidcClientConfig {
  return createClientSchema.parse(input);
}
export function parseUpdateClient(input: unknown): UpdateOidcClientInput {
  return updateClientSchema.parse(input);
}
