import { loadConfig, type AppConfig } from "../src/config.js";

interface TestConfigOverrides extends Partial<AppConfig> {
  issuer?: string;
}

export function testConfig(overrides: TestConfigOverrides = {}): AppConfig {
  const issuer = overrides.issuer ?? loadConfig().issuer;
  const url = new URL(issuer);
  const issuerPath =
    url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return {
    ...loadConfig(),
    logger: false,
    ...overrides,
    issuer: `${url.origin}${issuerPath}`,
    issuerOrigin: url.origin,
    issuerPath,
  };
}
