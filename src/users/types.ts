/**
 * A test user as stored in users.json. `tid` is deliberately absent: it is
 * always the mock's tenant ID and is added when claims are issued.
 */
export interface MockUser {
  sub: string;
  oid: string;
  name: string;
  preferred_username: string;
  mail: string;
  groups: string[];
}

/** `sub` may be omitted when creating a user; the store generates it once. */
export type CreateMockUserInput = Omit<MockUser, "sub"> & {
  sub?: string | undefined;
};
export type UpdateMockUserInput = Omit<MockUser, "sub">;
