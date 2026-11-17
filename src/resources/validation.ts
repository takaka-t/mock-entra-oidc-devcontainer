import { z } from "zod";
import { unique } from "../validation/common.js";
export const guid = z.guid().transform((value) => value.toLowerCase());
export const scopeName = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/)
  .refine((value) => !value.includes("/") && value !== ".default", "スコープ名に / または .default は使用できません");
export const groupMembershipClaims = z.enum(["None", "SecurityGroup"]);
export const resourceSchema = z
  .object({
    resourceAppId: guid,
    identifierUri: z
      .string()
      .max(1024)
      .refine((value) => {
        try {
          const uri = new URL(value);
          return (
            !uri.username &&
            !uri.password &&
            !value.includes("#") &&
            !value.includes("?") &&
            value.trim() === value &&
            !/\s/.test(value) &&
            uri.hostname !== "graph.microsoft.com" &&
            !!uri.hostname &&
            ((uri.protocol === "api:" && value.startsWith("api://")) || uri.protocol === "https:")
          );
        } catch {
          return false;
        }
      }, "API URI は api:// または https:// の絶対 URI にしてください"),
    scopes: z.array(scopeName).min(1).transform(unique),
    requestedAccessTokenVersion: z.union([z.literal(1), z.literal(2), z.null()]),
    emailOptionalClaim: z.boolean(),
    groupMembershipClaims,
  })
  .strict();
export const updateResourceSchema = resourceSchema.omit({ resourceAppId: true });
