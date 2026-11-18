import { errors } from "oidc-provider";
import { z } from "zod";

const claimRequest = z.union([
  z.null(),
  z
    .looseObject({
      essential: z.boolean().optional(),
      value: z.unknown().optional(),
      values: z.array(z.unknown()).optional(),
    })
    .refine((claim) => !(Object.hasOwn(claim, "value") && Object.hasOwn(claim, "values"))),
]);
const claimRequests = z.record(z.string(), claimRequest);
const requestedClaims = z.looseObject({
  id_token: claimRequests.optional(),
  userinfo: claimRequests.optional(),
  access_token: claimRequests.optional(),
});

/**
 * Accept optional claims without inventing information the mock does not have.
 * OIDC Core 5.5.1 permits missing ordinary claims even when essential is true;
 * subject constraints and authentication contexts require separate enforcement.
 */
export function validateClaimsRequest(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "string") throw new errors.InvalidRequest("claims must not be repeated");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new errors.InvalidRequest("claims must be a valid JSON object");
  }
  const result = requestedClaims.safeParse(parsed);
  if (!result.success) throw new errors.InvalidRequest("claims must contain valid claim request objects");

  for (const section of [result.data.id_token, result.data.userinfo, result.data.access_token]) {
    if (!section) continue;
    for (const [name, claim] of Object.entries(section)) {
      if (!claim) continue;
      const constrained = Object.hasOwn(claim, "value") || Object.hasOwn(claim, "values");
      if (name === "sub" && constrained)
        throw new errors.InvalidRequest("claims subject constraints are not implemented by this mock");
      if (
        (name === "acr" && claim.essential === true) ||
        (name === "acrs" && (claim.essential === true || constrained))
      )
        throw new errors.InvalidRequest("claims authentication constraints are not implemented by this mock");
    }
  }
  const capabilities = result.data.access_token?.xms_cc;
  if (capabilities?.values?.some((capability) => typeof capability !== "string"))
    throw new errors.InvalidRequest("access_token.xms_cc.values must be an array of strings");
}
