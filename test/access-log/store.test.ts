import { describe, expect, it } from "vitest";
import {
  accessLogCapacity,
  InMemoryAccessLog,
  type AccessLogInput,
} from "../../src/access-log/store.js";

function entry(overrides: Partial<AccessLogInput> = {}): AccessLogInput {
  return {
    receivedAt: "2026-01-01T00:00:00.000Z",
    method: "GET",
    path: "/jwks",
    endpoint: "jwks",
    statusCode: 200,
    durationMs: 1,
    scenario: "NORMAL",
    fault: null,
    ...overrides,
  };
}

describe("InMemoryAccessLog", () => {
  it("defaults to the documented capacity", () => {
    expect(new InMemoryAccessLog().capacity).toBe(accessLogCapacity);
    expect(accessLogCapacity).toBe(200);
  });

  it("rejects a non-positive capacity", () => {
    expect(() => new InMemoryAccessLog(0)).toThrow(RangeError);
    expect(() => new InMemoryAccessLog(1.5)).toThrow(RangeError);
  });

  it("lists entries newest first with monotonic ids", () => {
    const log = new InMemoryAccessLog();
    log.record(entry({ path: "/first" }));
    log.record(entry({ path: "/second" }));
    log.record(entry({ path: "/third" }));
    expect(log.list().map((item) => [item.id, item.path])).toEqual([
      [3, "/third"],
      [2, "/second"],
      [1, "/first"],
    ]);
  });

  it("drops the oldest entries once the capacity is exceeded", () => {
    const log = new InMemoryAccessLog(2);
    log.record(entry({ path: "/first" }));
    log.record(entry({ path: "/second" }));
    log.record(entry({ path: "/third" }));
    expect(log.list().map((item) => item.path)).toEqual(["/third", "/second"]);
    expect(log.list()).toHaveLength(2);
  });

  it("keeps ids increasing across clear", () => {
    const log = new InMemoryAccessLog();
    log.record(entry());
    log.record(entry());
    log.clear();
    expect(log.list()).toEqual([]);
    expect(log.record(entry()).id).toBe(3);
  });

  it("returns copies so callers cannot mutate stored faults", () => {
    const log = new InMemoryAccessLog();
    const fault = {
      scenario: "TOKEN_TIMEOUT" as const,
      endpoint: "token" as const,
      mode: "CONTINUOUS" as const,
      parameters: { delayMs: 100 },
      remainingBefore: null,
      remainingAfter: null,
    };
    const recorded = log.record(entry({ fault }));
    fault.parameters.delayMs = 999;
    recorded.fault!.parameters.delayMs = 888;
    const listed = log.list()[0]!;
    expect(listed.fault?.parameters.delayMs).toBe(100);
    listed.fault!.parameters.delayMs = 777;
    expect(log.list()[0]!.fault?.parameters.delayMs).toBe(100);
  });
});
