import { z } from "zod";
import {
  defaultDelayMs,
  defaultRetryAfterSeconds,
  defaultTokenError,
  maxDelayMs,
  scenarios,
} from "./registry.js";
import {
  scenarioNames,
  type ScenarioParameters,
  type SetScenarioInput,
} from "./types.js";

const baseSchema = z
  .object({
    scenario: z.enum(scenarioNames),
    mode: z.enum(["CONTINUOUS", "LIMITED"]).optional(),
    failureCount: z.number().int().positive().safe().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export function parseScenarioInput(value: unknown): SetScenarioInput {
  const parsed = baseSchema.parse(value);
  if (parsed.scenario === "NORMAL") {
    if (parsed.mode || parsed.failureCount || parsed.parameters)
      throw new Error("NORMAL does not accept mode, count, or parameters");
    return { scenario: "NORMAL" };
  }
  if (!parsed.mode) throw new Error("mode is required");
  if (parsed.mode === "LIMITED" && parsed.failureCount === undefined)
    throw new Error("failureCount is required for LIMITED");
  if (parsed.mode === "CONTINUOUS" && parsed.failureCount !== undefined)
    throw new Error("failureCount is not allowed for CONTINUOUS");

  const definition = scenarios[parsed.scenario];
  let parameters: ScenarioParameters | undefined;
  if (definition.parameterKind === "timeout") {
    parameters = z
      .object({
        delayMs: z
          .number()
          .int()
          .positive()
          .max(maxDelayMs)
          .default(defaultDelayMs),
      })
      .strict()
      .parse(parsed.parameters ?? {});
  } else if (definition.parameterKind === "token400") {
    const result = z
      .object({
        error: z.string().min(1).max(100).default(defaultTokenError),
        errorDescription: z.string().min(1).max(500).optional(),
      })
      .strict()
      .parse(parsed.parameters ?? {});
    parameters = {
      error: result.error,
      ...(result.errorDescription === undefined
        ? {}
        : { errorDescription: result.errorDescription }),
    };
  } else if (
    definition.parameterKind === "retryAfterRequired" ||
    definition.parameterKind === "retryAfterOptional"
  ) {
    const retryAfterSeconds = z.number().int().positive().safe();
    const result = z
      .object({
        retryAfterSeconds:
          definition.parameterKind === "retryAfterRequired"
            ? retryAfterSeconds.default(defaultRetryAfterSeconds)
            : retryAfterSeconds.optional(),
      })
      .strict()
      .parse(parsed.parameters ?? {});
    parameters =
      result.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: result.retryAfterSeconds };
  } else {
    z.object({})
      .strict()
      .parse(parsed.parameters ?? {});
    parameters = {};
  }
  if (parsed.mode === "LIMITED") {
    return {
      scenario: parsed.scenario,
      mode: "LIMITED",
      failureCount: parsed.failureCount as number,
      ...(parameters === undefined ? {} : { parameters }),
    } as SetScenarioInput;
  }
  return {
    scenario: parsed.scenario,
    mode: "CONTINUOUS",
    ...(parameters === undefined ? {} : { parameters }),
  } as SetScenarioInput;
}
