import { mkdtemp, rm } from "node:fs/promises";
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mutateToken,
  mutateTokenResponse,
  tokenResponseFaultApplies,
  wrongTenantId,
} from "../src/faults/token-generator.js";
import { loadSigningKeys, type SigningKeys } from "../src/oidc/keys.js";
import type { FaultDecision } from "../src/scenario/types.js";

const tokenKinds = [
  {
    name: "ID token",
    audience: "mock-public-client",
    claims: { nonce: "test-nonce" },
  },
  {
    name: "access token",
    audience: "urn:mock-api",
    typ: "at+jwt",
    claims: { client_id: "mock-public-client", scope: "openid profile" },
  },
] as const;

const tenantId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function decision(scenario: FaultDecision["scenario"], parameters: FaultDecision["parameters"] = {}): FaultDecision {
  return {
    scenario,
    endpoint: "token-jwt",
    mode: "LIMITED",
    parameters,
    remainingBefore: 1,
    remainingAfter: 0,
  };
}

describe("token fault generator", () => {
  let keys: SigningKeys;
  let keyDirectory: string;
  let normalKid: string;
  let normalPublicKey: CryptoKey;

  beforeAll(async () => {
    keyDirectory = await mkdtemp(join(tmpdir(), "mock-idp-token-generator-"));
    keys = await loadSigningKeys(keyDirectory);
    if (typeof keys.normal.publicJwk.kid !== "string") throw new Error("normal signing key must have a kid");
    normalKid = keys.normal.publicJwk.kid;
    normalPublicKey = (await importJWK(keys.normal.publicJwk, "RS256")) as CryptoKey;
  });

  afterAll(async () => {
    await rm(keyDirectory, { recursive: true, force: true });
  });

  async function makeToken(kind: (typeof tokenKinds)[number]) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      iss: `https://mock-idp.test:9000/${tenantId}/v2.0`,
      aud: kind.audience,
      sub: "user-admin",
      oid: "00000000-0000-4000-8000-000000000001",
      tid: tenantId,
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
        ...(kind.name === "access token" ? { typ: kind.typ } : {}),
      })
      .sign(keys.normal.privateKey);
  }

  it.each(tokenKinds)("distinguishes invalid signatures from unknown kids for $name", async (kind) => {
    const source = await makeToken(kind);
    const jwks = createLocalJWKSet({ keys: [keys.normal.publicJwk] });

    const invalidSignature = await mutateToken(source, decision("INVALID_SIGNATURE"), keys);
    expect(decodeProtectedHeader(invalidSignature)).toEqual({
      alg: "RS256",
      kid: normalKid,
      ...(kind.name === "access token" ? { typ: kind.typ } : {}),
    });
    await expect(jwtVerify(invalidSignature, jwks)).rejects.toMatchObject({
      code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
    });

    const unknownKid = await mutateToken(source, decision("UNKNOWN_KID"), keys);
    expect(decodeProtectedHeader(unknownKid)).toEqual({
      alg: "RS256",
      kid: "unknown-kid",
      ...(kind.name === "access token" ? { typ: kind.typ } : {}),
    });
    await expect(jwtVerify(unknownKid, jwks)).rejects.toMatchObject({
      code: "ERR_JWKS_NO_MATCHING_KEY",
    });

    expect(decodeJwt(invalidSignature)).toEqual(decodeJwt(source));
    expect(decodeJwt(unknownKid)).toEqual(decodeJwt(source));
  });

  it.each(tokenKinds)("signs a rollover $name with the newly published key", async (kind) => {
    const source = await makeToken(kind);
    const rollover = await mutateToken(source, decision("SIGNING_KEY_ROLLOVER"), keys);

    expect(decodeProtectedHeader(rollover)).toEqual({
      alg: "RS256",
      kid: "mock-rollover-key",
      ...(kind.name === "access token" ? { typ: kind.typ } : {}),
    });
    await expect(
      jwtVerify(
        rollover,
        createLocalJWKSet({
          keys: [keys.normal.publicJwk, keys.rollover.publicJwk],
        }),
      ),
    ).resolves.toBeDefined();
    await expect(jwtVerify(rollover, createLocalJWKSet({ keys: [keys.normal.publicJwk] }))).rejects.toMatchObject({
      code: "ERR_JWKS_NO_MATCHING_KEY",
    });
    expect(decodeJwt(rollover)).toEqual(decodeJwt(source));
  });

  it.each(["WRONG_AUDIENCE", "WRONG_ISSUER", "EXPIRED_TOKEN", "FUTURE_NBF"] as const)(
    "preserves protected headers for %s",
    async (scenario) => {
      const source = await makeToken(tokenKinds[0]);
      const mutated = await mutateToken(source, decision(scenario), keys);

      expect(decodeProtectedHeader(mutated)).toEqual(decodeProtectedHeader(source));
    },
  );

  it.each(tokenKinds)("creates a future nbf before exp and preserves other $name claims", async (kind) => {
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
  });

  it("replaces or removes the ID Token nonce and leaves the access token untouched", async () => {
    const idToken = await makeToken(tokenKinds[0]);
    const accessToken = await makeToken(tokenKinds[1]);
    for (const scenario of ["NONCE_MISMATCH", "NONCE_MISSING"] as const) {
      const response = (await mutateTokenResponse(
        { id_token: idToken, access_token: accessToken, token_type: "Bearer" },
        decision(scenario),
        keys,
      )) as Record<string, string>;
      const payload = decodeJwt(response.id_token!);
      if (scenario === "NONCE_MISMATCH") expect(payload.nonce).toBe("mock-mismatched-nonce");
      else expect(payload).not.toHaveProperty("nonce");
      expect({ ...payload, nonce: "test-nonce" }).toEqual(decodeJwt(idToken));
      expect(decodeProtectedHeader(response.id_token!)).toEqual(decodeProtectedHeader(idToken));
      await expect(jwtVerify(response.id_token!, normalPublicKey)).resolves.toBeDefined();
      expect(response.access_token).toBe(accessToken);
    }
  });

  it.each(tokenKinds)("emits an unsigned alg=none $name without a kid", async (kind) => {
    const source = await makeToken(kind);
    const mutated = await mutateToken(source, decision("ALG_NONE"), keys);

    expect(mutated.endsWith(".")).toBe(true);
    expect(mutated.split(".")).toHaveLength(3);
    expect(decodeProtectedHeader(mutated)).toEqual({
      alg: "none",
      ...(kind.name === "access token" ? { typ: kind.typ } : {}),
    });
    expect(decodeJwt(mutated)).toEqual(decodeJwt(source));
    await expect(jwtVerify(mutated, normalPublicKey)).rejects.toBeDefined();
  });

  it.each(tokenKinds)("moves the $name to another tenant consistently for WRONG_TENANT", async (kind) => {
    const source = await makeToken(kind);
    const mutated = await mutateToken(source, decision("WRONG_TENANT"), keys);
    const payload = decodeJwt(mutated);

    expect(payload.tid).toBe(wrongTenantId);
    expect(payload.iss).toBe(`https://mock-idp.test:9000/${wrongTenantId}/v2.0`);
    expect({ ...payload, tid: tenantId, iss: decodeJwt(source).iss }).toEqual(decodeJwt(source));
    await expect(jwtVerify(mutated, normalPublicKey)).resolves.toBeDefined();
  });

  it.each(["sub", "oid", "tid", "iss", "aud", "exp", "iat"] as const)(
    "removes only %s for MISSING_CLAIM",
    async (claim) => {
      for (const kind of tokenKinds) {
        const source = await makeToken(kind);
        const mutated = await mutateToken(source, decision("MISSING_CLAIM", { claim }), keys);
        const payload = decodeJwt(mutated);
        const expected = { ...decodeJwt(source) };
        delete expected[claim];

        expect(payload).toEqual(expected);
        expect(decodeProtectedHeader(mutated)).toEqual(decodeProtectedHeader(source));
      }
    },
  );

  it("removes sub when MISSING_CLAIM has no claim parameter", async () => {
    const source = await makeToken(tokenKinds[0]);
    const payload = decodeJwt(await mutateToken(source, decision("MISSING_CLAIM"), keys));
    expect(payload).not.toHaveProperty("sub");
    expect(payload.oid).toBeTypeOf("string");
  });

  it("drops id_token from the token response for TOKEN_NO_ID_TOKEN", async () => {
    const idToken = await makeToken(tokenKinds[0]);
    const accessToken = await makeToken(tokenKinds[1]);
    const response = await mutateTokenResponse(
      { id_token: idToken, access_token: accessToken, token_type: "Bearer", expires_in: 3600 },
      decision("TOKEN_NO_ID_TOKEN"),
      keys,
    );
    expect(response).toEqual({ access_token: accessToken, token_type: "Bearer", expires_in: 3600 });
  });

  it("applies ID Token-only faults only to a response they would change", async () => {
    const withNonce = await makeToken(tokenKinds[0]);
    // The access token fixture carries no nonce, so it stands in for an ID
    // Token from an Authorization request that sent none.
    const withoutNonce = await makeToken(tokenKinds[1]);
    const accessOnly = { access_token: withoutNonce, token_type: "Bearer" };

    for (const scenario of ["NONCE_MISMATCH", "NONCE_MISSING"] as const) {
      expect(tokenResponseFaultApplies(scenario, { ...accessOnly, id_token: withNonce })).toBe(true);
      expect(tokenResponseFaultApplies(scenario, { ...accessOnly, id_token: withoutNonce })).toBe(false);
      expect(tokenResponseFaultApplies(scenario, accessOnly)).toBe(false);
    }
    expect(tokenResponseFaultApplies("TOKEN_NO_ID_TOKEN", { ...accessOnly, id_token: withoutNonce })).toBe(true);
    expect(tokenResponseFaultApplies("TOKEN_NO_ID_TOKEN", accessOnly)).toBe(false);
    expect(tokenResponseFaultApplies("TOKEN_NO_ID_TOKEN", null)).toBe(false);
    for (const scenario of ["WRONG_AUDIENCE", "ALG_NONE", "MISSING_CLAIM"] as const)
      expect(tokenResponseFaultApplies(scenario, accessOnly)).toBe(true);
  });

  it("rejects FUTURE_NBF for a token that is already about to expire", async () => {
    const now = Math.floor(Date.now() / 1000);
    const almostExpired = await new SignJWT({
      iss: "https://mock-idp.test:9000",
      aud: "mock-public-client",
      sub: "user-admin",
      iat: now,
      nbf: now,
      exp: now + 1,
    })
      .setProtectedHeader({ alg: "RS256", kid: normalKid })
      .sign(keys.normal.privateKey);

    await expect(mutateToken(almostExpired, decision("FUTURE_NBF"), keys)).rejects.toThrow(
      "FUTURE_NBF requires a token that expires in the future",
    );
  });

  it.each(tokenKinds)("creates an expired but consistently ordered $name", async (kind) => {
    const source = await makeToken(kind);
    const sourcePayload = decodeJwt(source);
    const mutated = await mutateToken(source, decision("EXPIRED_TOKEN"), keys);
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
    await expect(compactVerify(mutated, normalPublicKey)).resolves.toBeDefined();
  });
});
