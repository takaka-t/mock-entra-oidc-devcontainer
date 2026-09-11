import { z } from "zod";

export const printableAscii = z
  .string()
  .min(1)
  .refine(
    (value) =>
      [...value].every((character) => {
        const codePoint = character.codePointAt(0);
        return (
          codePoint !== undefined && codePoint >= 0x20 && codePoint <= 0x7e
        );
      }),
    "印字可能な ASCII 文字だけを使用してください",
  );

// Fastify's default maximum decoded path parameter length.
export const maxIdentifierLength = 100;

/** IDs must round-trip through the Admin API's path parameters. */
export const identifier = printableAscii
  .refine((value) => value.trim().length > 0, "空白だけにはできません")
  .transform((value) => value.trim())
  .pipe(
    z
      .string()
      .max(maxIdentifierLength)
      .refine(
        (value) => value !== "." && value !== "..",
        "「.」および「..」は使用できません",
      ),
  );

export const unique = <T>(values: T[]): T[] => [...new Set(values)];
