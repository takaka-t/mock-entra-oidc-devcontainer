import { mkdir, rename, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { defaultUsers, MockUserStore, UserConflictError, UserNotFoundError } from "../src/users/store.js";

const newUser = {
  sub: "user-new",
  oid: "ABCDEF01-2345-6789-ABCD-EF0123456789",
  name: "New User",
  preferred_username: "new@example.com",
  mail: "new@example.com",
  groups: ["group-a", "group-a", "group-b"],
};

async function temporaryFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((entry) => entry.endsWith(".tmp"));
}

describe("mock user store", () => {
  let directory: string;
  let file: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "mock-users-"));
    file = join(directory, "users.json");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function initialized(): Promise<MockUserStore> {
    const store = new MockUserStore(file);
    await store.initialize();
    return store;
  }

  it("seeds defaults with 0600 and without tid, reloads, and resets", async () => {
    const store = await initialized();
    expect(store.list()).toEqual(defaultUsers());
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const persisted = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>[];
    expect(persisted).toHaveLength(3);
    expect(persisted.every((user) => !("tid" in user))).toBe(true);

    await store.create(newUser);
    expect(await temporaryFiles(directory)).toEqual([]);

    const reloaded = await initialized();
    expect(reloaded.find("user-new")).toEqual({
      ...newUser,
      oid: newUser.oid.toLowerCase(),
      groups: ["group-a", "group-b"],
    });
    expect(await reloaded.reset()).toEqual(defaultUsers());
    expect(reloaded.find("user-new")).toBeUndefined();
    expect((await initialized()).list()).toEqual(defaultUsers());
  });

  it("normalizes input and returns copies", async () => {
    const store = await initialized();
    const created = await store.create({
      ...newUser,
      sub: "  spaced  ",
      name: "  Spaced Name  ",
    });
    expect(created).toEqual({
      sub: "spaced",
      oid: newUser.oid.toLowerCase(),
      name: "Spaced Name",
      preferred_username: newUser.preferred_username,
      mail: newUser.mail,
      groups: ["group-a", "group-b"],
    });
    created.groups.push("mutated");
    expect(store.find("spaced")?.groups).toEqual(["group-a", "group-b"]);
    const listed = store.list();
    listed[0]!.groups.push("mutated");
    expect(store.find(listed[0]!.sub)?.groups).not.toContain("mutated");
  });

  it("generates and persists a sub when one is omitted", async () => {
    const store = await initialized();
    const { sub: _sub, ...input } = newUser;
    void _sub;
    const created = await store.create(input);

    expect(created.sub).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect((await initialized()).find(created.sub)).toEqual(created);
  });

  it("updates every field except sub", async () => {
    const store = await initialized();
    const updated = await store.update("user-normal", {
      oid: "44444444-4444-4444-4444-444444444444",
      name: "Renamed",
      preferred_username: "renamed@example.com",
      mail: "renamed@example.com",
      groups: ["x"],
    });
    expect(updated.sub).toBe("user-normal");
    expect(updated.name).toBe("Renamed");
    expect((await initialized()).find("user-normal")).toEqual(updated);
    await store.delete("user-normal");
    expect(store.find("user-normal")).toBeUndefined();
    expect((await initialized()).list().map((user) => user.sub)).toEqual(["user-admin", "user-unauthorized"]);
  });

  it("rejects duplicate sub, oid, and preferred_username", async () => {
    const store = await initialized();
    await store.create(newUser);
    await expect(store.create(newUser)).rejects.toBeInstanceOf(UserConflictError);
    await expect(
      store.create({
        ...newUser,
        sub: "other",
        preferred_username: "other@example.com",
      }),
    ).rejects.toThrow("oid already in use");
    await expect(
      store.create({
        ...newUser,
        sub: "other",
        oid: "55555555-5555-5555-5555-555555555555",
        preferred_username: "NEW@example.com",
      }),
    ).rejects.toThrow("preferred_username already in use");
    const { sub: _sub, ...update } = newUser;
    void _sub;
    await expect(
      store.update("user-admin", {
        ...update,
        preferred_username: "admin@example.com",
      }),
    ).rejects.toThrow("oid already in use");
    // Keeping its own oid is not a conflict with itself.
    await expect(store.update("user-new", { ...update, name: "Still New" })).resolves.toMatchObject({
      name: "Still New",
    });
    expect(store.list()).toHaveLength(4);
  });

  it("reports missing users", async () => {
    const store = await initialized();
    const { sub: _sub, ...update } = newUser;
    void _sub;
    await expect(store.update("missing", update)).rejects.toBeInstanceOf(UserNotFoundError);
    await expect(store.delete("missing")).rejects.toBeInstanceOf(UserNotFoundError);
  });

  it.each([
    { name: "malformed oid", input: { ...newUser, oid: "not-a-guid" } },
    { name: "malformed mail", input: { ...newUser, mail: "nope" } },
    { name: "blank name", input: { ...newUser, name: "   " } },
    { name: "tid", input: { ...newUser, tid: "tenant" } },
    {
      name: "groups that are not an array",
      input: { ...newUser, groups: "x" },
    },
    { name: "blank group", input: { ...newUser, groups: [""] } },
  ])("rejects $name without touching state", async ({ input }) => {
    const store = await initialized();
    const before = await readFile(file, "utf8");
    await expect(store.create(input as never)).rejects.toBeInstanceOf(ZodError);
    expect(store.list()).toEqual(defaultUsers());
    expect(await readFile(file, "utf8")).toBe(before);
    expect(await temporaryFiles(directory)).toEqual([]);
  });

  it("accepts GUIDs that are not RFC 9562 UUIDs", async () => {
    const store = await initialized();
    await expect(store.create({ ...newUser, oid: "12345678-1234-1234-1234-123456789abc" })).resolves.toMatchObject({
      oid: "12345678-1234-1234-1234-123456789abc",
    });
  });

  it("fails startup for malformed or duplicated persisted data", async () => {
    await writeFile(file, "not-json");
    await expect(new MockUserStore(file).initialize()).rejects.toBeInstanceOf(SyntaxError);
    expect(await readFile(file, "utf8")).toBe("not-json");

    const [admin, normal] = defaultUsers();
    await writeFile(file, JSON.stringify([admin, { ...normal, oid: admin!.oid }]));
    await expect(new MockUserStore(file).initialize()).rejects.toThrow("duplicate oid");
    await writeFile(file, JSON.stringify([{ ...admin, tid: "tenant" }]));
    await expect(new MockUserStore(file).initialize()).rejects.toBeInstanceOf(ZodError);
  });

  it.each([
    { sub: "." },
    { sub: ".." },
    { sub: "u".repeat(101) },
    { name: "first\nlast" },
    { preferred_username: "first\rlast" },
    { groups: ["allowed\r\nadmin"] },
  ])("rejects incompatible persisted users without rewriting them: %j", async (changes) => {
    const original = JSON.stringify([{ ...newUser, ...changes }]);
    await writeFile(file, original);
    await expect(new MockUserStore(file).initialize()).rejects.toBeInstanceOf(ZodError);
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("preserves Unicode and trims field boundaries without splitting groups", async () => {
    const store = await initialized();
    const user = await store.create({
      ...newUser,
      name: "  山田 太郎\n",
      preferred_username: " 利用者@example.com ",
      groups: ["\n管理者 グループ\r\n", "管理者 グループ", "一般利用者"],
    });
    expect(user).toMatchObject({
      name: "山田 太郎",
      preferred_username: "利用者@example.com",
      groups: ["管理者 グループ", "一般利用者"],
    });
    expect((await initialized()).find(newUser.sub)).toEqual(user);
  });

  it("preserves memory and the previous file after a failed commit and allows retry", async () => {
    const store = await initialized();
    const before = await readFile(file, "utf8");
    const backup = file + ".backup";
    await rename(file, backup);
    await mkdir(file);
    await expect(store.create(newUser)).rejects.toMatchObject({
      code: "EISDIR",
    });
    expect(store.list()).toEqual(defaultUsers());
    expect(await readFile(backup, "utf8")).toBe(before);
    expect(await temporaryFiles(directory)).toEqual([]);
    await rm(file, { recursive: true });
    await rename(backup, file);
    await store.create(newUser);
    expect((await initialized()).find(newUser.sub)).toEqual(store.find(newUser.sub));
  });

  it("serializes concurrent mutations", async () => {
    const store = await initialized();
    await Promise.all([
      store.create(newUser),
      store.create({
        ...newUser,
        sub: "user-other",
        oid: "66666666-6666-6666-6666-666666666666",
        preferred_username: "other@example.com",
      }),
    ]);
    expect((await initialized()).list()).toHaveLength(5);
    expect(await temporaryFiles(directory)).toEqual([]);
  });
});
