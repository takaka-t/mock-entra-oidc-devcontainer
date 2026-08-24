import type { Adapter, AdapterPayload } from "oidc-provider";

const MAX_ENTRIES = 1_000;

const grantableModels = new Set([
  "AccessToken",
  "AuthorizationCode",
  "RefreshToken",
  "DeviceCode",
  "BackchannelAuthenticationRequest",
  "PreAuthorizedCode",
]);

interface StoredEntry {
  payload: AdapterPayload;
  expiresAt?: number;
  uid?: string;
  userCode?: string;
  grantId?: string;
}

export interface InMemoryAdapter extends Adapter {
  upsert(
    id: string,
    payload: AdapterPayload,
    expiresIn?: number,
  ): Promise<void>;
}

export type InMemoryAdapterFactory = (model: string) => InMemoryAdapter;

/**
 * Creates one adapter factory with storage scoped to a single Provider.
 * Calling this function again creates a completely isolated store.
 */
export function createInMemoryAdapterFactory(): InMemoryAdapterFactory {
  const entries = new Map<string, StoredEntry>();
  const sessionKeysByUid = new Map<string, string>();
  const keysByUserCode = new Map<string, string>();
  const keysByGrantId = new Map<string, Set<string>>();

  const remove = (key: string): void => {
    const entry = entries.get(key);
    if (!entry) return;

    entries.delete(key);
    if (entry.uid && sessionKeysByUid.get(entry.uid) === key)
      sessionKeysByUid.delete(entry.uid);
    if (entry.userCode && keysByUserCode.get(entry.userCode) === key)
      keysByUserCode.delete(entry.userCode);
    if (entry.grantId) {
      const grantKeys = keysByGrantId.get(entry.grantId);
      grantKeys?.delete(key);
      if (grantKeys?.size === 0) keysByGrantId.delete(entry.grantId);
    }
  };

  const expired = (entry: StoredEntry): boolean =>
    entry.expiresAt !== undefined && entry.expiresAt <= Date.now();

  const read = (key: string): AdapterPayload | undefined => {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (expired(entry)) {
      remove(key);
      return undefined;
    }

    // Map insertion order is the LRU order. Reads promote live records.
    entries.delete(key);
    entries.set(key, entry);
    return entry.payload;
  };

  const removeExpired = (): void => {
    for (const [key, entry] of entries) if (expired(entry)) remove(key);
  };

  const enforceCapacity = (): void => {
    while (entries.size > MAX_ENTRIES) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) return;
      remove(oldestKey);
    }
  };

  return (model: string): InMemoryAdapter => {
    const keyFor = (id: string): string => `${model}:${id}`;

    return {
      async upsert(id, payload, expiresIn) {
        removeExpired();
        const key = keyFor(id);
        remove(key);

        const uid =
          model === "Session" && typeof payload.uid === "string"
            ? payload.uid
            : undefined;
        const userCode =
          typeof payload.userCode === "string" ? payload.userCode : undefined;
        const grantId =
          grantableModels.has(model) && typeof payload.grantId === "string"
            ? payload.grantId
            : undefined;
        const expiresAt =
          expiresIn === undefined || !Number.isFinite(expiresIn)
            ? undefined
            : Date.now() + Math.max(0, expiresIn) * 1_000;
        const entry: StoredEntry = {
          payload,
          ...(expiresAt === undefined ? {} : { expiresAt }),
          ...(uid === undefined ? {} : { uid }),
          ...(userCode === undefined ? {} : { userCode }),
          ...(grantId === undefined ? {} : { grantId }),
        };

        entries.set(key, entry);
        if (uid) sessionKeysByUid.set(uid, key);
        if (userCode) keysByUserCode.set(userCode, key);
        if (grantId) {
          const grantKeys = keysByGrantId.get(grantId) ?? new Set<string>();
          grantKeys.add(key);
          keysByGrantId.set(grantId, grantKeys);
        }
        enforceCapacity();
      },

      async find(id) {
        return read(keyFor(id));
      },

      async findByUid(uid) {
        const key = sessionKeysByUid.get(uid);
        return key === undefined ? undefined : read(key);
      },

      async findByUserCode(userCode) {
        const key = keysByUserCode.get(userCode);
        return key === undefined ? undefined : read(key);
      },

      async consume(id) {
        const payload = read(keyFor(id));
        if (payload) payload.consumed = Math.floor(Date.now() / 1_000);
      },

      async destroy(id) {
        remove(keyFor(id));
      },

      async revokeByGrantId(grantId) {
        const grantKeys = keysByGrantId.get(grantId);
        if (!grantKeys) return;
        for (const key of [...grantKeys]) remove(key);
      },
    };
  };
}
