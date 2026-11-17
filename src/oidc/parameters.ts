import { errors } from "oidc-provider";
export function parameterValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new errors.InvalidRequest("parameters must be single string values");
  return value;
}
