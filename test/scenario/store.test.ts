import { describe, expect, it } from "vitest";
import { InMemoryScenarioStore } from "../../src/scenario/store.js";
import { parseScenarioInput } from "../../src/scenario/validation.js";

const timeoutScenarios = [
  "AUTH_TIMEOUT",
  "TOKEN_TIMEOUT",
  "JWKS_TIMEOUT",
  "DISCOVERY_TIMEOUT",
] as const;
const retryAfterRequiredScenarios = [
  "AUTH_429",
  "TOKEN_429",
  "JWKS_429",
  "DISCOVERY_429",
] as const;
const retryAfterOptionalScenarios = [
  "AUTH_500",
  "TOKEN_500",
  "JWKS_500",
  "DISCOVERY_500",
] as const;

describe("InMemoryScenarioStore", () => {
  it("atomically consumes limited failures and returns to normal", async () => {
    const store = new InMemoryScenarioStore();
    store.set({
      scenario: "TOKEN_500",
      mode: "LIMITED",
      failureCount: 3,
      parameters: {},
    });
    expect(store.consume("token")?.remainingAfter).toBe(2);
    expect(store.consume("jwks")).toBeNull();
    expect(store.consume("token")?.remainingAfter).toBe(1);
    expect(store.consume("token")?.remainingAfter).toBe(0);
    expect(store.get()).toMatchObject({
      scenario: "NORMAL",
      lastCompleted: { scenario: "TOKEN_500", triggeredCount: 3 },
    });
    expect(store.consume("token")).toBeNull();
  });

  it("allows one winner when remaining is one", async () => {
    const store = new InMemoryScenarioStore();
    store.set({
      scenario: "TOKEN_500",
      mode: "LIMITED",
      failureCount: 1,
      parameters: {},
    });
    const decisions = await Promise.all(
      Array.from({ length: 20 }, async () => store.consume("token")),
    );
    expect(decisions.filter(Boolean)).toHaveLength(1);
  });

  it("separates authorization protocol and HTTP fault consumption", () => {
    const store = new InMemoryScenarioStore();
    store.set({ scenario: "AUTH_500", mode: "LIMITED", failureCount: 1 });

    expect(store.consume("authorization")).toBeNull();
    expect(store.get().remainingFailures).toBe(1);
    expect(store.consume("authorization-http")?.scenario).toBe("AUTH_500");
    expect(store.get().scenario).toBe("NORMAL");
  });

  it("keeps continuous scenarios active and reset clears state", () => {
    const store = new InMemoryScenarioStore();
    store.set({ scenario: "JWKS_500", mode: "CONTINUOUS", parameters: {} });
    store.consume("jwks");
    store.consume("jwks");
    expect(store.get()).toMatchObject({
      scenario: "JWKS_500",
      triggeredCount: 2,
    });
    expect(store.reset()).toMatchObject({
      scenario: "NORMAL",
      lastCompleted: null,
    });
  });

  it("validates invariants even when the store is called directly", () => {
    const store = new InMemoryScenarioStore();
    expect(() => store.set({ scenario: "TOKEN_500" } as never)).toThrow(
      "mode is required",
    );
    expect(() =>
      store.set({
        scenario: "TOKEN_500",
        mode: "LIMITED",
        failureCount: 0,
      } as never),
    ).toThrow();
    expect(store.get().scenario).toBe("NORMAL");
  });

  it.each(timeoutScenarios)(
    "defaults %s delay and rejects values above the supported maximum",
    (scenario) => {
      expect(
        parseScenarioInput({ scenario, mode: "CONTINUOUS" }),
      ).toMatchObject({ parameters: { delayMs: 30_000 } });
      expect(() =>
        parseScenarioInput({
          scenario,
          mode: "CONTINUOUS",
          parameters: { delayMs: 300_001 },
        }),
      ).toThrow();
    },
  );

  it.each(retryAfterRequiredScenarios)(
    "normalizes required Retry-After parameters for %s",
    (scenario) => {
      expect(
        parseScenarioInput({ scenario, mode: "CONTINUOUS" }),
      ).toMatchObject({ parameters: { retryAfterSeconds: 60 } });
      expect(
        parseScenarioInput({
          scenario,
          mode: "LIMITED",
          failureCount: 1,
          parameters: { retryAfterSeconds: 15 },
        }),
      ).toMatchObject({ parameters: { retryAfterSeconds: 15 } });
    },
  );

  it.each(retryAfterOptionalScenarios)(
    "normalizes optional Retry-After parameters for %s",
    (scenario) => {
      expect(
        parseScenarioInput({ scenario, mode: "CONTINUOUS" }),
      ).toMatchObject({ parameters: {} });
      expect(
        parseScenarioInput({
          scenario,
          mode: "CONTINUOUS",
          parameters: { retryAfterSeconds: 30 },
        }),
      ).toMatchObject({ parameters: { retryAfterSeconds: 30 } });
    },
  );

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "60"])(
    "rejects invalid Retry-After seconds %s",
    (retryAfterSeconds) => {
      for (const scenario of [
        ...retryAfterRequiredScenarios,
        ...retryAfterOptionalScenarios,
      ])
        expect(() =>
          parseScenarioInput({
            scenario,
            mode: "CONTINUOUS",
            parameters: { retryAfterSeconds },
          }),
        ).toThrow();
    },
  );

  it("rejects Retry-After parameters for unrelated scenarios", () => {
    expect(() =>
      parseScenarioInput({
        scenario: "JWKS_TIMEOUT",
        mode: "CONTINUOUS",
        parameters: { retryAfterSeconds: 60 },
      }),
    ).toThrow();
  });

  it.each(["UNKNOWN_GROUPS", "DISCOVERY_INVALID"])(
    "rejects removed scenario %s",
    (scenario) => {
      expect(() =>
        parseScenarioInput({ scenario, mode: "CONTINUOUS" }),
      ).toThrow();
    },
  );

  it("does not apply a scenario activated after a request started", () => {
    const store = new InMemoryScenarioStore();
    const ticket = store.startRequest({});
    store.set({ scenario: "TOKEN_500", mode: "LIMITED", failureCount: 1 });

    expect(store.consumeForRequest("token", ticket)).toBeNull();
    expect(store.get()).toMatchObject({
      scenario: "TOKEN_500",
      remainingFailures: 1,
    });
  });

  it("fails closed when request-bound consumption has no ticket", () => {
    const store = new InMemoryScenarioStore();
    store.set({ scenario: "WRONG_ISSUER", mode: "CONTINUOUS" });

    expect(store.consumeForRequest("token-jwt", undefined)).toBeNull();
    expect(store.get().triggeredCount).toBe(0);
  });

  it("invalidates request tickets when the activation is replaced", () => {
    const store = new InMemoryScenarioStore();
    store.set({ scenario: "TOKEN_500", mode: "CONTINUOUS" });
    const request = {};
    const ticket = store.startRequest(request);
    expect(store.startRequest(request)).toBe(ticket);

    store.set({ scenario: "TOKEN_400", mode: "CONTINUOUS" });
    expect(store.consumeForRequest("token", ticket)).toBeNull();
    expect(store.get()).toMatchObject({
      scenario: "TOKEN_400",
      triggeredCount: 0,
    });
  });

  it("allows one matching stage to consume each request ticket", () => {
    const store = new InMemoryScenarioStore();
    store.set({ scenario: "WRONG_ISSUER", mode: "CONTINUOUS" });
    const ticket = store.startRequest({});

    expect(store.consumeForRequest("token", ticket)).toBeNull();
    expect(store.consumeForRequest("token-jwt", ticket)?.scenario).toBe(
      "WRONG_ISSUER",
    );
    expect(store.consumeForRequest("token-jwt", ticket)).toBeNull();
    expect(store.get().triggeredCount).toBe(1);
  });

  it("separates scenario activation and full reset lifecycle hooks", () => {
    const activated: string[] = [];
    let resetCount = 0;
    const store = new InMemoryScenarioStore({
      onActivate: (scenario) => activated.push(scenario),
      onReset: () => resetCount++,
    });

    store.set({
      scenario: "SIGNING_KEY_ROLLOVER",
      mode: "LIMITED",
      failureCount: 1,
    });
    store.consume("token-jwt");
    store.clear();

    expect(activated).toEqual(["SIGNING_KEY_ROLLOVER"]);
    expect(resetCount).toBe(0);

    store.reset();
    expect(resetCount).toBe(1);
  });
});
