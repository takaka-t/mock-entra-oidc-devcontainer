export function rawPathname(url: string): string {
  return new URL(url, "http://local").pathname;
}

export function adminPath(pathname: string): boolean {
  return pathname === "/__mock" || pathname.startsWith("/__mock/");
}

/** Admin UI/API and the health probe: never OIDC traffic, never fault targets. */
export function managementPath(pathname: string): boolean {
  return pathname === "/health" || adminPath(pathname);
}

export function decodeRoutingPath(pathname: string): string {
  return pathname.replace(/%([0-7][\da-f])/gi, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/**
 * Fastify decodes percent-encoded ASCII characters before matching static
 * routes. Mirror that behavior for security checks that must run before route
 * dispatch, while leaving malformed and non-ASCII escapes untouched.
 */
export function routedPathname(url: string): string {
  return decodeRoutingPath(rawPathname(url));
}
