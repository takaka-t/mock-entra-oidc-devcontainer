import { describe, expect, it } from "vitest";
import { InMemoryScenarioStore } from "../../src/scenario/store.js";
import { parseScenarioInput } from "../../src/scenario/validation.js";

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

  it("defaults timeout delay and rejects values above the supported maximum", () => {
    expect(
      parseScenarioInput({
        scenario: "TOKEN_TIMEOUT",
        mode: "CONTINUOUS",
      }),
    ).toMatchObject({ parameters: { delayMs: 30_000 } });
    expect(() =>
      parseScenarioInput({
        scenario: "TOKEN_TIMEOUT",
        mode: "CONTINUOUS",
        parameters: { delayMs: 300_001 },
      }),
    ).toThrow();
  });

  it("does not apply a scenario activated after a request started", () => {
    const store = new InMemoryScenarioStore();
    const ticket = store.startRequest({});
    store.set({ scenario: "TOKEN_500", mode: "LIMITED", failureCount: 1 });

    expect(store.consume("token", ticket)).toBeNull();
    expect(store.get()).toMatchObject({
      scenario: "TOKEN_500",
      remainingFailures: 1,
    });
  });

  it("fails closed when request-bound consumption has no ticket", () => {
    const store = new InMemoryScenarioStore();
    store.set({ scenario: "WRONG_ISSUER", mode: "CONTINUOUS" });

    expect(store.consume("token-jwt", undefined)).toBeNull();
    expect(store.get().triggeredCount).toBe(0);
  });

  it("invalidates request tickets when the activation is replaced", () => {
    const store = new InMemoryScenarioStore();
    store.set({ scenario: "TOKEN_500", mode: "CONTINUOUS" });
    const request = {};
    const ticket = store.startRequest(request);
    expect(store.startRequest(request)).toBe(ticket);

    store.set({ scenario: "TOKEN_400", mode: "CONTINUOUS" });
    expect(store.consume("token", ticket)).toBeNull();
    expect(store.get()).toMatchObject({
      scenario: "TOKEN_400",
      triggeredCount: 0,
    });
  });

  it("allows one matching stage to consume each request ticket", () => {
    const store = new InMemoryScenarioStore();
    store.set({ scenario: "WRONG_ISSUER", mode: "CONTINUOUS" });
    const ticket = store.startRequest({});

    expect(store.consume("token", ticket)).toBeNull();
    expect(store.consume("token-jwt", ticket)?.scenario).toBe("WRONG_ISSUER");
    expect(store.consume("token-jwt", ticket)).toBeNull();
    expect(store.get().triggeredCount).toBe(1);
  });
});
