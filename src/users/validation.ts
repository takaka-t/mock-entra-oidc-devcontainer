import { z } from "zod";
import { identifier, unique } from "../validation/common.js";
import type { CreateMockUserInput, UpdateMockUserInput } from "./types.js";

const sub = identifier;
// z.guid(), not z.uuid(): Entra object IDs are GUIDs and need not carry RFC
// 9562 version/variant bits (the seeded users, for one, do not).
const oid = z.guid().transform((value) => value.toLowerCase());
// These values are edited in single-line inputs or one group per line.
const singleLine = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !/[\r\n]/.test(value), "改行は使用できません");
const mail = z.email();
const groups = z.array(singleLine).transform(unique);

const commonShape = {
  oid,
  name: singleLine,
  preferred_username: singleLine,
  mail,
  groups,
};

export const createUserSchema = z
  .object({ sub: sub.optional(), ...commonShape })
  .strict();
export const updateUserSchema = z.object(commonShape).strict();
// Stored users must always have a subject. Omitting it is only supported at
// creation time, before the store generates and persists one.
export const persistedUserSchema = z.object({ sub, ...commonShape }).strict();

export function parseCreateUser(input: unknown): CreateMockUserInput {
  return createUserSchema.parse(input);
}

export function parseUpdateUser(input: unknown): UpdateMockUserInput {
  return updateUserSchema.parse(input);
}
