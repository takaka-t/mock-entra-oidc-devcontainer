/** Entra client_info extension; this mock has a single tenant and no guest accounts. */
export function encodeClientInfo(oid: string, tenantId: string): string {
  return Buffer.from(JSON.stringify({ uid: oid, utid: tenantId }), "utf8").toString("base64url");
}
