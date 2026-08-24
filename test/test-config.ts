import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type AppConfig } from "../src/config.js";

type TestStatePaths = Pick<AppConfig, "keyDirectory" | "clientConfigFile">;
type TestConfigOverrides = TestStatePaths &
  Partial<Omit<AppConfig, keyof TestStatePaths>>;

const repositoryDataDirectory = fileURLToPath(
  new URL("../.data", import.meta.url),
);

function assertOutsideRepositoryData(name: string, value: string): void {
  const relativePath = relative(repositoryDataDirectory, resolve(value));
  if (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) &&
      relativePath !== ".." &&
      !isAbsolute(relativePath))
  )
    throw new Error(
      `${name} must not resolve inside the repository .data directory`,
    );
}

export function testConfig(overrides: TestConfigOverrides): AppConfig {
  const defaults = loadConfig();
  assertOutsideRepositoryData("keyDirectory", overrides.keyDirectory);
  assertOutsideRepositoryData("clientConfigFile", overrides.clientConfigFile);
  const issuer = overrides.issuer ?? defaults.issuer;
  const url = new URL(issuer);
  const issuerPath =
    url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return {
    ...defaults,
    logger: false,
    ...overrides,
    issuer: `${url.origin}${issuerPath}`,
    issuerOrigin: url.origin,
    issuerPath,
  };
}
