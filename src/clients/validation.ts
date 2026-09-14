import { z } from "zod";
import {
  clientTypes,
  tokenEndpointAuthMethods,
  type CreateOidcClientInput,
  type UpdateOidcClientInput,
} from "./types.js";
import { identifier, printableAscii, unique } from "../validation/common.js";

const withoutFragment = (value: string): boolean => !value.includes("#");

const clientId = identifier;

const scopeName = printableAscii
  .refine((value) => value.trim().length > 0, "空白だけにはできません")
  .transform((value) => value.trim())
  .refine((value) => !/\s/.test(value), "空白文字は使用できません");

const absoluteUri = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    try {
      const url = new URL(value);
      return Boolean(url.protocol && !url.username && !url.password);
    } catch {
      return false;
    }
  }, "認証情報を含まない絶対 URI を指定してください")
  .refine(withoutFragment, "フラグメントは指定できません");

const webUri = absoluteUri.refine((value) => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}, "http または https を使用してください");

const commonShape = {
  clientType: z.enum(clientTypes),
  clientSecret: printableAscii.optional(),
  tokenEndpointAuthMethod: z.enum(tokenEndpointAuthMethods),
  redirectUris: z.array(webUri).min(1).transform(unique),
  postLogoutRedirectUris: z.array(webUri).transform(unique),
  accessTokenAudience: absoluteUri,
  accessTokenScope: scopeName,
  emailOptionalClaim: z.boolean(),
};

function refineClient(value: z.infer<z.ZodObject<typeof commonShape>>, ctx: z.RefinementCtx) {
  if (value.clientType === "PUBLIC") {
    if (value.clientSecret !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["clientSecret"],
        message: "PUBLIC クライアントにはクライアントシークレットを指定できません",
      });
    if (value.tokenEndpointAuthMethod !== "none")
      ctx.addIssue({
        code: "custom",
        path: ["tokenEndpointAuthMethod"],
        message: "PUBLIC クライアントの認証方式は none にしてください",
      });
  } else {
    if (!value.clientSecret)
      ctx.addIssue({
        code: "custom",
        path: ["clientSecret"],
        message: "CONFIDENTIAL クライアントにはクライアントシークレットが必要です",
      });
    if (value.tokenEndpointAuthMethod === "none")
      ctx.addIssue({
        code: "custom",
        path: ["tokenEndpointAuthMethod"],
        message: "CONFIDENTIAL クライアントにはトークンエンドポイント認証が必要です",
      });
  }
}

export const createClientSchema = z
  .object({ clientId, ...commonShape })
  .strict()
  .superRefine(refineClient);
export const updateClientSchema = z.object(commonShape).strict().superRefine(refineClient);

export const persistedClientSchema = z.preprocess((input) => {
  if (typeof input !== "object" || input === null) return input;
  const { scopes: _legacyScopes, ...client } = input as Record<string, unknown>;
  void _legacyScopes;
  return {
    accessTokenScope: "access_as_user",
    emailOptionalClaim: false,
    ...client,
  };
}, createClientSchema);

export function parseCreateClient(input: unknown): CreateOidcClientInput {
  return normalized(createClientSchema.parse(input));
}

export function parseUpdateClient(input: unknown): UpdateOidcClientInput {
  return normalized(updateClientSchema.parse(input));
}

function normalized<T extends { clientSecret?: string | undefined }>(value: T): T & { clientSecret?: string } {
  if (value.clientSecret === undefined) delete value.clientSecret;
  return value as T & { clientSecret?: string };
}
