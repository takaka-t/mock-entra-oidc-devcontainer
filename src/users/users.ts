export interface MockUser {
  sub: string;
  oid: string;
  tid: string;
  name: string;
  preferred_username: string;
  mail: string;
  groups: string[];
}

const tenantId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

export const users: readonly MockUser[] = [
  {
    sub: "user-admin",
    oid: "11111111-1111-1111-1111-111111111111",
    tid: tenantId,
    name: "Admin User",
    preferred_username: "admin@example.com",
    mail: "admin@example.com",
    groups: ["app-admin-group-id", "app-user-group-id"],
  },
  {
    sub: "user-normal",
    oid: "22222222-2222-2222-2222-222222222222",
    tid: tenantId,
    name: "Normal User",
    preferred_username: "user@example.com",
    mail: "user@example.com",
    groups: ["app-user-group-id"],
  },
  {
    sub: "user-unauthorized",
    oid: "33333333-3333-3333-3333-333333333333",
    tid: tenantId,
    name: "Unauthorized User",
    preferred_username: "unauthorized@example.com",
    mail: "unauthorized@example.com",
    groups: [],
  },
] as const;

export function findUser(sub: string): MockUser | undefined {
  return users.find((user) => user.sub === sub);
}
