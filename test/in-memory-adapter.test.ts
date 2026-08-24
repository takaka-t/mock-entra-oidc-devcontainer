import { describe, expect, it, vi } from "vitest";
import { createInMemoryAdapterFactory } from "../src/oidc/in-memory-adapter.js";

describe("scoped in-memory OIDC adapter", () => {
  it("stores, consumes, and destroys records", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
    try {
      const adapter = createInMemoryAdapterFactory()("AuthorizationCode");
      await adapter.upsert("code", { accountId: "user" }, 60);

      expect(await adapter.find("code")).toMatchObject({ accountId: "user" });
      await adapter.consume("code");
      expect(await adapter.find("code")).toMatchObject({
        accountId: "user",
        consumed: 1_767_225_605,
      });

      await adapter.destroy("code");
      expect(await adapter.find("code")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires TTL records while keeping clients without a TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const factory = createInMemoryAdapterFactory();
      const codes = factory("AuthorizationCode");
      const clients = factory("Client");
      await codes.upsert("short-lived", { accountId: "user" }, 10);
      await clients.upsert("client", { client_id: "client" });

      vi.advanceTimersByTime(10_000);
      expect(await codes.find("short-lived")).toBeUndefined();
      expect(await clients.find("client")).toMatchObject({
        client_id: "client",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("maintains UID and user-code indexes across updates and deletion", async () => {
    const factory = createInMemoryAdapterFactory();
    const sessions = factory("Session");
    const deviceCodes = factory("DeviceCode");

    await sessions.upsert("session", { uid: "old-uid" }, 60);
    await sessions.upsert("session", { uid: "new-uid" }, 60);
    expect(await sessions.findByUid("old-uid")).toBeUndefined();
    expect(await sessions.findByUid("new-uid")).toMatchObject({
      uid: "new-uid",
    });

    await deviceCodes.upsert("device", { userCode: "ABCD-EFGH" }, 60);
    expect(await deviceCodes.findByUserCode("ABCD-EFGH")).toMatchObject({
      userCode: "ABCD-EFGH",
    });
    await deviceCodes.destroy("device");
    expect(await deviceCodes.findByUserCode("ABCD-EFGH")).toBeUndefined();
  });

  it("revokes every grant-bound artifact without touching other grants", async () => {
    const factory = createInMemoryAdapterFactory();
    const accessTokens = factory("AccessToken");
    const refreshTokens = factory("RefreshToken");
    await accessTokens.upsert("access", { grantId: "grant-a" }, 60);
    await refreshTokens.upsert("refresh", { grantId: "grant-a" }, 60);
    await accessTokens.upsert("other", { grantId: "grant-b" }, 60);

    await accessTokens.revokeByGrantId("grant-a");
    expect(await accessTokens.find("access")).toBeUndefined();
    expect(await refreshTokens.find("refresh")).toBeUndefined();
    expect(await accessTokens.find("other")).toMatchObject({
      grantId: "grant-b",
    });
  });

  it("evicts the least-recently-used record at an exact 1000-record limit", async () => {
    const adapter = createInMemoryAdapterFactory()("Session");
    await adapter.upsert("oldest", { uid: "oldest-uid" }, 60);
    for (let index = 1; index < 1_000; index++)
      await adapter.upsert(`session-${index}`, { uid: `uid-${index}` }, 60);

    // A read promotes this entry, making session-1 the next eviction target.
    await adapter.find("oldest");
    await adapter.upsert("newest", { uid: "newest-uid" }, 60);

    expect(await adapter.find("session-1")).toBeUndefined();
    expect(await adapter.findByUid("uid-1")).toBeUndefined();
    expect(await adapter.findByUid("oldest-uid")).toMatchObject({
      uid: "oldest-uid",
    });
    expect(await adapter.findByUid("newest-uid")).toMatchObject({
      uid: "newest-uid",
    });
  });

  it("isolates all records between separately created factories", async () => {
    const first = createInMemoryAdapterFactory();
    const second = createInMemoryAdapterFactory();
    await first("AuthorizationCode").upsert(
      "same-id",
      { accountId: "first" },
      60,
    );
    await second("AuthorizationCode").upsert(
      "same-id",
      { accountId: "second" },
      60,
    );

    expect(await first("AuthorizationCode").find("same-id")).toMatchObject({
      accountId: "first",
    });
    expect(await second("AuthorizationCode").find("same-id")).toMatchObject({
      accountId: "second",
    });
  });
});
