import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exportJWK, generateKeyPair, importJWK, type JWK } from "jose";

export interface SigningKey {
  privateJwk: JWK;
  publicJwk: JWK;
  privateKey: CryptoKey;
}
export interface SigningKeys {
  normal: SigningKey;
  invalid: SigningKey;
}

async function loadOrCreate(
  directory: string,
  name: string,
  kid: string,
): Promise<SigningKey> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${name}.json`);
  let privateJwk: JWK;
  try {
    privateJwk = JSON.parse(await readFile(path, "utf8")) as JWK;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const pair = await generateKeyPair("RS256", { extractable: true });
    privateJwk = {
      ...(await exportJWK(pair.privateKey)),
      kid,
      use: "sig",
      alg: "RS256",
    };
    await writeFile(path, `${JSON.stringify(privateJwk, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  privateJwk = { ...privateJwk, kid, use: "sig", alg: "RS256" };
  const { d, p, q, dp, dq, qi, oth, ...publicJwk } = privateJwk;
  void d;
  void p;
  void q;
  void dp;
  void dq;
  void qi;
  void oth;
  return {
    privateJwk,
    publicJwk,
    privateKey: (await importJWK(privateJwk, "RS256")) as CryptoKey,
  };
}

export async function loadSigningKeys(directory: string): Promise<SigningKeys> {
  return {
    normal: await loadOrCreate(
      directory,
      "normal-signing-key",
      "mock-normal-key",
    ),
    invalid: await loadOrCreate(
      directory,
      "invalid-signing-key",
      "mock-invalid-key",
    ),
  };
}
