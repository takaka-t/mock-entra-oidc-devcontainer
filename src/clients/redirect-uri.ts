import type { RedirectUri } from "./types.js";
export function validRedirect(value: string, type: RedirectUri["type"]): boolean {
  try {
    const uri = new URL(value);
    if (
      uri.username ||
      uri.password ||
      value.includes("#") ||
      uri.hostname === "[::1]" ||
      uri.hostname.split(".").some((label) => label.toLowerCase().startsWith("xn--")) ||
      /[!$'(),;]/.test(value) ||
      value.length > 256 ||
      [...value].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)
    )
      return false;
    if (uri.protocol === "https:") return !!uri.hostname;
    if (uri.protocol === "http:") return uri.hostname === "localhost" || uri.hostname === "127.0.0.1";
    return type === "native" && !["javascript:", "data:", "file:", "ftp:", "about:", "blob:"].includes(uri.protocol);
  } catch {
    return false;
  }
}
export function redirectMatches(registered: string, requested: string): boolean {
  try {
    const expected = new URL(registered),
      actual = new URL(requested);
    if (expected.hostname === "localhost" && actual.hostname === "localhost") {
      expected.port = "";
      actual.port = "";
    }
    return expected.href === actual.href;
  } catch {
    return false;
  }
}
export function findRedirect(uris: RedirectUri[], requested: string): RedirectUri | undefined {
  return uris.find((item) => redirectMatches(item.uri, requested));
}

/** Origin syntax is strict; localhost follows Entra's redirect port exception. */
export function spaOriginAllowed(uris: RedirectUri[], origin: string): boolean {
  try {
    if (new URL(origin).origin !== origin) return false;
    return uris.some((item) => item.type === "spa" && redirectMatches(new URL(item.uri).origin, origin));
  } catch {
    return false;
  }
}
