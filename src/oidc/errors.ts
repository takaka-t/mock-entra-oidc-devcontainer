import { randomUUID } from "node:crypto";
const codes: Record<string, number> = {
  invalid_scope: 70011,
  invalid_client: 700016,
  invalid_request: 900144,
  invalid_grant: 70000,
  login_required: 50058,
  consent_required: 65001,
  access_denied: 65004,
};
/** Stable protocol categories, with mock-generated diagnostic identifiers. */
export function diagnosticError<T extends { error: string; error_description?: string | undefined }>(
  out: T,
): T & Record<string, unknown> {
  const code =
    out.error === "invalid_client" && /authentication failed|secret/i.test(out.error_description ?? "")
      ? 7000215
      : codes[out.error];
  if ("trace_id" in out) return out;
  return {
    ...out,
    ...(code ? { error_codes: [code] } : {}),
    timestamp: new Date()
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "Z"),
    trace_id: randomUUID(),
    correlation_id: randomUUID(),
  };
}
