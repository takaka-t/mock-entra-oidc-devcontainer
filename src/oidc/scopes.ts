import { errors } from "oidc-provider";
import type { OidcClientConfig } from "../clients/types.js";
import type { ApiResourceStore } from "../resources/store.js";
import type { ApiResourceConfig } from "../resources/types.js";
export const internalOfflineScope = "urn:mock:offline_access";
export const oidcScopes = ["openid", "profile", "email", "offline_access"];
export const graphResource = "https://graph.microsoft.com";
export interface ResolvedScopes {
  oidc: string[];
  targets: { resource: ApiResourceConfig; resourceIdentifier: string; scopes: string[] }[];
  canonical: string[];
}
export function validateResourceReferences(client: OidcClientConfig, resources: ApiResourceConfig[]): void {
  for (const permission of client.requiredResourceAccess) {
    const resource = resources.find((item) => item.resourceAppId === permission.resourceAppId);
    if (!resource || permission.scopes.some((scope) => !resource.scopes.includes(scope)))
      throw new Error("API 権限は登録済み API と公開スコープを参照してください");
  }
}
export function resolveScopes(scope: string, client: OidcClientConfig, resources: ApiResourceStore): ResolvedScopes {
  const names = [
    ...new Set(
      scope
        .split(" ")
        .filter(Boolean)
        .map((name) => (name === internalOfflineScope ? "offline_access" : name)),
    ),
  ];
  if (!names.length) throw new errors.InvalidScope("scope is required", "");
  const oidc = names.filter((name) => oidcScopes.includes(name));
  const targets: ResolvedScopes["targets"] = [];
  const defaults = names.filter((name) => name.endsWith("/.default"));
  if (defaults.length && names.some((name) => !oidcScopes.includes(name) && !name.endsWith("/.default")))
    throw new errors.InvalidScope(".default cannot be combined with dynamic API scopes", "");
  for (const name of names.filter((name) => !oidcScopes.includes(name))) {
    const resource = resources
      .list()
      .sort((a, b) => b.identifierUri.length - a.identifierUri.length)
      .find((item) => name.startsWith(`${item.identifierUri}/`) || name.startsWith(`${item.resourceAppId}/`));
    if (!resource) throw new errors.InvalidScope(`unknown resource scope: ${name}`, "");
    const prefix = name.startsWith(`${resource.identifierUri}/`) ? resource.identifierUri : resource.resourceAppId;
    const requested = name.slice(prefix.length + 1);
    const permission = client.requiredResourceAccess.find((item) => item.resourceAppId === resource.resourceAppId);
    if (!permission) throw new errors.InvalidScope("client has no configured permissions for this API", "");
    const scopes = requested === ".default" ? permission.scopes : [requested];
    if (scopes.some((value) => !resource.scopes.includes(value) || !permission.scopes.includes(value)))
      throw new errors.InvalidScope(`scope is not exposed or permitted: ${name}`, "");
    let target = targets.find((item) => item.resource.resourceAppId === resource.resourceAppId);
    if (!target) {
      target = { resource, resourceIdentifier: prefix, scopes: [] };
      targets.push(target);
    }
    target.scopes = [...new Set([...target.scopes, ...scopes])];
  }
  return {
    oidc,
    targets,
    canonical: [
      ...oidc,
      ...targets.flatMap((target) => target.scopes.map((name) => `${target.resource.resourceAppId}/${name}`)),
    ],
  };
}
export function narrowedScopes(requested: ResolvedScopes, granted: string[]): void {
  if (requested.canonical.some((scope) => !granted.includes(scope)))
    throw new errors.InvalidScope("requested scope was not granted", "");
}
