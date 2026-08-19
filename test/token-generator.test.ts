import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compactVerify,
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  SignJWT,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { mutateToken } from "../src/faults/token-generator.js";
import { loadSigningKeys, type SigningKeys } from "../src/oidc/keys.js";
import type { FaultDecision } from "../src/scenario/types.js";

const tokenKinds = [
  {
    name: "ID token",
    audience: "mock-public-client",
    typ: "JWT",
    claims: { nonce: "test-nonce" },
  },
  {
    name: "access token",
    audience: "urn:mock-api",
    typ: "at+jwt",
    claims: { client_id: "mock-public-client", scope: "openid profile" },
  },
] as const;

function decision(scenario: FaultDecision["scenario"]): FaultDecision {
  return {
    scenario,
    endpoint: "token-jwt",
    mode: "LIMITED",
    parameters: {},
    remainingBefore: 1,
    remainingAfter: 0,
  };
}

describe("token fault generator", () => {
  let keys: SigningKeys;
  let normalKid: string;
  let normalPublicKey: CryptoKey;

  beforeAll(async () => {
    keys = await loadSigningKeys(
      await mkdtemp(join(tmpdir(), "mock-idp-token-generator-")),
    );
    if (typeof keys.normal.publicJwk.kid !== "string")
      throw new Error("normal signing key must have a kid");
    normalKid = keys.normal.publicJwk.kid;
    normalPublicKey = (await importJWK(
      keys.normal.publicJwk,
      "RS256",
    )) as CryptoKey;
  });

  async function makeToken(kind: (typeof tokenKinds)[number]) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      iss: "http://mock-idp.test:9000",
      aud: kind.audience,
      sub: "user-admin",
      iat: now,
      nbf: now,
      exp: now + 3600,
      mail: "admin@example.com",
      groups: ["app-admin-group-id", "app-user-group-id"],
      preserved: "unchanged",
      ...kind.claims,
    })
      .setProtectedHeader({
        alg: "RS256",
        kid: normalKid,
        typ: kind.typ,
      })
      .sign(keys.normal.privateKey);
  }

  it.each(tokenKinds)(
    "distinguishes invalid signatures from unknown kids for $name",
    async (kind) => {
      const source = await makeToken(kind);
      const jwks = createLocalJWKSet({ keys: [keys.normal.publicJwk] });

      const invalidSignature = await mutateToken(
        source,
        decision("INVALID_SIGNATURE"),
        keys,
      );
      expect(decodeProtectedHeader(invalidSignature)).toMatchObject({
        alg: "RS256",
        kid: normalKid,
        typ: kind.typ,
      });
      await expect(jwtVerify(invalidSignature, jwks)).rejects.toMatchObject({
        code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
      });

      const unknownKid = await mutateToken(
        source,
        decision("UNKNOWN_KID"),
        keys,
      );
      expect(decodeProtectedHeader(unknownKid)).toMatchObject({
        alg: "RS256",
        kid: "unknown-kid",
        typ: kind.typ,
      });
      await expect(jwtVerify(unknownKid, jwks)).rejects.toMatchObject({
        code: "ERR_JWKS_NO_MATCHING_KEY",
      });

      expect(decodeJwt(invalidSignature)).toEqual(decodeJwt(source));
      expect(decodeJwt(unknownKid)).toEqual(decodeJwt(source));
    },
  );

  it.each(tokenKinds)(
    "creates a future nbf before exp and preserves other $name claims",
    async (kind) => {
      const source = await makeToken(kind);
      const sourcePayload = decodeJwt(source);
      const before = Math.floor(Date.now() / 1000);
      const mutated = await mutateToken(source, decision("FUTURE_NBF"), keys);
      const after = Math.floor(Date.now() / 1000);
      const payload = decodeJwt(mutated);

      expect(payload.nbf).toBeGreaterThan(before);
      expect(payload.nbf).toBeLessThan(payload.exp as number);
      expect(payload.exp).toBe(sourcePayload.exp);
      expect({ ...payload, nbf: sourcePayload.nbf }).toEqual(sourcePayload);
      await expect(jwtVerify(mutated, normalPublicKey)).rejects.toMatchObject({
        code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
        claim: "nbf",
      });
      await expect(
        jwtVerify(mutated, normalPublicKey, {
          currentDate: new Date(((payload.nbf as number) + 1) * 1000),
        }),
      ).resolves.toBeDefined();
      expect(payload.nbf).toBeGreaterThan(after);
    },
  );

  it.each(tokenKinds)(
    "creates an expired but consistently ordered $name",
    async (kind) => {
      const source = await makeToken(kind);
      const sourcePayload = decodeJwt(source);
      const mutated = await mutateToken(
        source,
        decision("EXPIRED_TOKEN"),
        keys,
      );
      const payload = decodeJwt(mutated);
      const now = Math.floor(Date.now() / 1000);

      expect(payload.iat).toBeLessThanOrEqual(payload.nbf as number);
      expect(payload.nbf).toBeLessThan(payload.exp as number);
      expect(payload.exp).toBeLessThan(now);
      expect({
        ...payload,
        iat: sourcePayload.iat,
        nbf: sourcePayload.nbf,
        exp: sourcePayload.exp,
      }).toEqual(sourcePayload);
      await expect(jwtVerify(mutated, normalPublicKey)).rejects.toMatchObject({
        code: "ERR_JWT_EXPIRED",
      });
      await expect(
        compactVerify(mutated, normalPublicKey),
      ).resolves.toBeDefined();
    },
  );
});
