import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  commitStagedFile,
  discardStagedFile,
  readJsonFile,
  SerialQueue,
  stageJsonFile,
} from "../persistence/json-file.js";
import type {
  CreateMockUserInput,
  MockUser,
  UpdateMockUserInput,
} from "./types.js";
import {
  parseCreateUser,
  parseUpdateUser,
  persistedUserSchema,
} from "./validation.js";

export class UserConflictError extends Error {}
export class UserNotFoundError extends Error {}

export const defaultUsers = (): MockUser[] => [
  {
    sub: "user-admin",
    oid: "11111111-1111-1111-1111-111111111111",
    name: "Admin User",
    preferred_username: "admin@example.com",
    mail: "admin@example.com",
    groups: ["app-admin-group-id", "app-user-group-id"],
  },
  {
    sub: "user-normal",
    oid: "22222222-2222-2222-2222-222222222222",
    name: "Normal User",
    preferred_username: "user@example.com",
    mail: "user@example.com",
    groups: ["app-user-group-id"],
  },
  {
    sub: "user-unauthorized",
    oid: "33333333-3333-3333-3333-333333333333",
    name: "Unauthorized User",
    preferred_username: "unauthorized@example.com",
    mail: "unauthorized@example.com",
    groups: [],
  },
];

type UniqueField = "sub" | "oid" | "preferred_username";

const uniqueFields: readonly [UniqueField, (value: string) => string][] = [
  ["sub", (value) => value],
  ["oid", (value) => value],
  ["preferred_username", (value) => value.toLowerCase()],
];

function duplicateField(
  users: readonly MockUser[],
): { field: UniqueField; value: string } | undefined {
  for (const [field, normalize] of uniqueFields) {
    const seen = new Set<string>();
    for (const user of users) {
      const key = normalize(user[field]);
      if (seen.has(key)) return { field, value: user[field] };
      seen.add(key);
    }
  }
  return undefined;
}

export class MockUserStore {
  #users = new Map<string, MockUser>();
  readonly #queue = new SerialQueue();

  constructor(readonly filePath: string) {}

  async initialize(): Promise<void> {
    const contents = await readJsonFile(this.filePath);
    const users = contents.exists
      ? z.array(persistedUserSchema).parse(contents.value)
      : defaultUsers();
    const duplicate = duplicateField(users);
    if (duplicate)
      throw new Error(
        `duplicate ${duplicate.field} in ${this.filePath}: ${duplicate.value}`,
      );
    if (!contents.exists) {
      const temporary = await stageJsonFile(this.filePath, users);
      try {
        await commitStagedFile(temporary, this.filePath);
      } finally {
        await discardStagedFile(temporary);
      }
    }
    this.#users = new Map(users.map((user) => [user.sub, user]));
  }

  list(): MockUser[] {
    return [...this.#users.values()].map((user) => structuredClone(user));
  }

  find(sub: string): MockUser | undefined {
    const user = this.#users.get(sub);
    return user && structuredClone(user);
  }

  async create(input: CreateMockUserInput): Promise<MockUser> {
    const parsed = parseCreateUser(input);
    return this.#queue.run(async () => {
      // Keep an explicitly supplied value for reproducible tests, otherwise
      // generate the pairwise-style subject once and persist it with the user.
      let sub = parsed.sub;
      if (sub === undefined) {
        do sub = randomUUID();
        while (this.#users.has(sub));
      } else if (this.#users.has(sub)) {
        throw new UserConflictError(`user already exists: ${sub}`);
      }
      const user: MockUser = { ...parsed, sub };
      await this.commit(new Map(this.#users).set(user.sub, user));
      return structuredClone(user);
    });
  }

  async update(sub: string, input: UpdateMockUserInput): Promise<MockUser> {
    const update = parseUpdateUser(input);
    return this.#queue.run(async () => {
      if (!this.#users.has(sub))
        throw new UserNotFoundError(`user not found: ${sub}`);
      const user = { sub, ...update };
      await this.commit(new Map(this.#users).set(sub, user));
      return structuredClone(user);
    });
  }

  async delete(sub: string): Promise<void> {
    return this.#queue.run(async () => {
      if (!this.#users.has(sub))
        throw new UserNotFoundError(`user not found: ${sub}`);
      const next = new Map(this.#users);
      next.delete(sub);
      await this.commit(next);
    });
  }

  async reset(): Promise<MockUser[]> {
    return this.#queue.run(async () => {
      await this.commit(
        new Map(defaultUsers().map((user) => [user.sub, user])),
      );
      return this.list();
    });
  }

  private async commit(next: Map<string, MockUser>): Promise<void> {
    const users = [...next.values()];
    const duplicate = duplicateField(users);
    if (duplicate)
      throw new UserConflictError(
        `${duplicate.field} already in use: ${duplicate.value}`,
      );
    const temporary = await stageJsonFile(this.filePath, users);
    try {
      await commitStagedFile(temporary, this.filePath);
      this.#users = next;
    } finally {
      await discardStagedFile(temporary);
    }
  }
}
