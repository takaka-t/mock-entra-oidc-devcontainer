import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const issuer = "http://mock-idp.test:9000";

describe("OIDC issuer configuration", () => {
  it.each([undefined, "", "   "])("requires OIDC_ISSUER (%s)", (value) => {
    expect(() =>
      loadConfig(value === undefined ? {} : { OIDC_ISSUER: value }),
    ).toThrow("OIDC_ISSUER is required");
  });

  it.each([
    {
      value: issuer,
      expected: {
        issuer,
        issuerOrigin: issuer,
        issuerPath: "",
      },
    },
    {
      value: `${issuer}/`,
      expected: {
        issuer,
        issuerOrigin: issuer,
        issuerPath: "",
      },
    },
    {
      value: "https://idp.example.test/tenant/v2.0/",
      expected: {
        issuer: "https://idp.example.test/tenant/v2.0",
        issuerOrigin: "https://idp.example.test",
        issuerPath: "/tenant/v2.0",
      },
    },
    {
      value: "https://idp.example.test/tenant/v2.0///",
      expected: {
        issuer: "https://idp.example.test/tenant/v2.0",
        issuerOrigin: "https://idp.example.test",
        issuerPath: "/tenant/v2.0",
      },
    },
  ])("normalizes issuer $value", ({ value, expected }) => {
    expect(loadConfig({ OIDC_ISSUER: value })).toMatchObject(expected);
  });

  it.each([
    "http://user@idp.example.test",
    "http://user:password@idp.example.test",
    "http://@idp.example.test",
    "http://idp.example.test?tenant=example",
    "http://idp.example.test?",
    "http://idp.example.test#fragment",
    "http://idp.example.test#",
  ])("rejects credentials, query, or fragment in %s", (value) => {
    expect(() => loadConfig({ OIDC_ISSUER: value })).toThrow(
      "OIDC_ISSUER must not contain credentials, query, or fragment",
    );
  });

  it.each(["ftp://idp.example.test", "file:///tmp/mock-idp"])(
    "rejects non-HTTP issuer %s",
    (value) => {
      expect(() => loadConfig({ OIDC_ISSUER: value })).toThrow(
        "OIDC_ISSUER must use http or https",
      );
    },
  );

  it.each(["idp.example.test", "/tenant/v2.0", "not a URL"])(
    "rejects non-absolute issuer %s",
    (value) => {
      expect(() => loadConfig({ OIDC_ISSUER: value })).toThrow(
        "OIDC_ISSUER must be an absolute HTTP(S) URL",
      );
    },
  );

  it.each([
    "/__mock",
    "/__mock/",
    "/__mock/api",
    "/health",
    "/health/ready",
    "/%5f%5fmock",
    "/__m%6fck/api",
    "/%5F%5Fmock/%ff",
    "/%68ealth",
    "/%68ealth%2fready",
  ])("rejects reserved issuer path %s", (path) => {
    expect(() => loadConfig({ OIDC_ISSUER: `${issuer}${path}` })).toThrow(
      "OIDC_ISSUER path must not use the reserved /__mock or /health namespace",
    );
  });

  it.each([
    "/__mockery",
    "/__mock-api",
    "/healthcheck",
    "/health-check",
    "/__mock%65ry",
    "/health%63heck",
    "/tenant/__mock",
    "/tenant/health",
  ])("allows non-conflicting issuer path %s", (path) => {
    expect(loadConfig({ OIDC_ISSUER: `${issuer}${path}` }).issuerPath).toBe(
      path,
    );
  });
});

describe("TRUST_PROXY configuration", () => {
  it.each([
    { value: undefined, expected: false },
    { value: "false", expected: false },
    { value: "true", expected: true },
  ])("parses $value as $expected", ({ value, expected }) => {
    expect(
      loadConfig({
        OIDC_ISSUER: issuer,
        ...(value === undefined ? {} : { TRUST_PROXY: value }),
      }).trustProxy,
    ).toBe(expected);
  });

  it.each(["", "TRUE", "False", "1", "yes"])(
    "rejects invalid value %j",
    (value) => {
      expect(() =>
        loadConfig({ OIDC_ISSUER: issuer, TRUST_PROXY: value }),
      ).toThrow("TRUST_PROXY must be true or false");
    },
  );
});
