import { z } from "zod";
import {
  clientTypes,
  supportedScopes,
  tokenEndpointAuthMethods,
  type CreateOidcClientInput,
  type UpdateOidcClientInput,
} from "./types.js";

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
  }, "must be an absolute URI without credentials");

const webUri = absoluteUri.refine((value) => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}, "must use http or https");

const unique = <T>(values: T[]): T[] => [...new Set(values)];

const commonShape = {
  clientType: z.enum(clientTypes),
  clientSecret: z.string().min(1).optional(),
  tokenEndpointAuthMethod: z.enum(tokenEndpointAuthMethods),
  redirectUris: z.array(webUri).min(1).transform(unique),
  postLogoutRedirectUris: z.array(webUri).transform(unique),
  scopes: z
    .array(z.enum(supportedScopes))
    .min(1)
    .transform(unique)
    .refine((scopes) => scopes.includes("openid"), "openid is required"),
  accessTokenAudience: absoluteUri,
};

function refineClient(
  value: z.infer<z.ZodObject<typeof commonShape>>,
  ctx: z.RefinementCtx,
) {
  if (value.clientType === "PUBLIC") {
    if (value.clientSecret !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["clientSecret"],
        message: "public clients must not have a client secret",
      });
    if (value.tokenEndpointAuthMethod !== "none")
      ctx.addIssue({
        code: "custom",
        path: ["tokenEndpointAuthMethod"],
        message: "public clients must use none",
      });
  } else {
    if (!value.clientSecret)
      ctx.addIssue({
        code: "custom",
        path: ["clientSecret"],
        message: "confidential clients require a client secret",
      });
    if (value.tokenEndpointAuthMethod === "none")
      ctx.addIssue({
        code: "custom",
        path: ["tokenEndpointAuthMethod"],
        message: "confidential clients must authenticate at the token endpoint",
      });
  }
}

export const createClientSchema = z
  .object({ clientId: z.string().trim().min(1), ...commonShape })
  .strict()
  .superRefine(refineClient);
export const updateClientSchema = z
  .object(commonShape)
  .strict()
  .superRefine(refineClient);

export function parseCreateClient(input: unknown): CreateOidcClientInput {
  return normalized(createClientSchema.parse(input));
}

export function parseUpdateClient(input: unknown): UpdateOidcClientInput {
  return normalized(updateClientSchema.parse(input));
}

function normalized<T extends { clientSecret?: string | undefined }>(
  value: T,
): T & { clientSecret?: string } {
  if (value.clientSecret === undefined) delete value.clientSecret;
  return value as T & { clientSecret?: string };
}
