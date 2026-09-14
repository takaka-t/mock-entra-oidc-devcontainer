import { scenarios } from "./registry.js";
import { parseScenarioInput } from "./validation.js";
import type {
  FaultDecision,
  FaultEndpoint,
  FaultScenarioName,
  ScenarioConfig,
  ScenarioHistory,
  ScenarioRequestTicket,
  ScenarioView,
  SetScenarioInput,
} from "./types.js";

export interface ScenarioStoreHooks {
  onActivate?: (scenario: FaultScenarioName) => void;
  onReset?: () => void;
}

const normal = (): ScenarioConfig => ({
  scenario: "NORMAL",
  mode: null,
  initialFailureCount: null,
  remainingFailures: null,
  triggeredCount: 0,
  parameters: {},
});

export class InMemoryScenarioStore {
  #current: ScenarioConfig = normal();
  #lastCompleted: ScenarioHistory | null = null;
  #activationId: number | null = null;
  #nextActivationId = 1;
  #requestTickets = new WeakMap<object, ScenarioRequestTicket>();
  #consumedTickets = new WeakSet<ScenarioRequestTicket>();
  #requestDecisions = new WeakMap<ScenarioRequestTicket, FaultDecision>();
  readonly #hooks: ScenarioStoreHooks;

  constructor(hooks: ScenarioStoreHooks = {}) {
    this.#hooks = hooks;
  }

  get(): ScenarioView {
    return {
      ...this.#current,
      parameters: { ...this.#current.parameters },
      status: this.#current.scenario === "NORMAL" ? "NORMAL" : "ACTIVE",
      lastCompleted: this.#lastCompleted
        ? {
            ...this.#lastCompleted,
            parameters: { ...this.#lastCompleted.parameters },
          }
        : null,
    };
  }

  set(input: SetScenarioInput): ScenarioView {
    const parsed = parseScenarioInput(input);
    if (parsed.scenario === "NORMAL") return this.clear();
    const count = parsed.mode === "LIMITED" ? parsed.failureCount : null;
    this.#current = {
      scenario: parsed.scenario,
      mode: parsed.mode,
      initialFailureCount: count,
      remainingFailures: count,
      triggeredCount: 0,
      parameters: { ...parsed.parameters },
    };
    this.#hooks.onActivate?.(parsed.scenario);
    this.#activationId = this.#nextActivationId++;
    return this.get();
  }

  clear(): ScenarioView {
    this.#current = normal();
    this.#activationId = null;
    return this.get();
  }
  reset(): ScenarioView {
    this.#lastCompleted = null;
    const view = this.clear();
    this.#hooks.onReset?.();
    return view;
  }

  startRequest(request: object): ScenarioRequestTicket {
    const existing = this.#requestTickets.get(request);
    if (existing) return existing;
    const ticket = Object.freeze({ activationId: this.#activationId });
    this.#requestTickets.set(request, ticket);
    return ticket;
  }

  getRequestTicket(request: object): ScenarioRequestTicket | undefined {
    return this.#requestTickets.get(request);
  }

  /**
   * The fault this request consumed, if any. Faults are consumed from several
   * places (the HTTP fault middleware and the provider's claim, authorization
   * and token hooks), but every one of them goes through consumeForRequest, so
   * the store is the one place that can tie a decision back to its request.
   */
  getRequestDecision(request: object): FaultDecision | null {
    const ticket = this.#requestTickets.get(request);
    return ticket ? (this.#requestDecisions.get(ticket) ?? null) : null;
  }

  /**
   * Consumes a fault without binding to a specific in-flight request.
   *
   * Test-only. Every production caller goes through consumeForRequest so that
   * a single request cannot consume the same activation twice; this bypasses
   * that guard and exists only to keep the store's own unit tests readable.
   */
  consume(endpoint: FaultEndpoint): FaultDecision | null {
    return this.#consume(endpoint, false, undefined);
  }

  /**
   * Consumes a fault only if the ticket's activation is still current and has
   * not already been consumed by this request. Passing `undefined` (e.g. a
   * request that never called `startRequest`) fails closed.
   */
  consumeForRequest(endpoint: FaultEndpoint, ticket: ScenarioRequestTicket | undefined): FaultDecision | null {
    return this.#consume(endpoint, true, ticket);
  }

  #consume(
    endpoint: FaultEndpoint,
    requestBound: boolean,
    ticket: ScenarioRequestTicket | undefined,
  ): FaultDecision | null {
    const current = this.#current;
    if (
      (requestBound &&
        (ticket === undefined ||
          ticket.activationId === null ||
          ticket.activationId !== this.#activationId ||
          this.#consumedTickets.has(ticket))) ||
      current.scenario === "NORMAL" ||
      scenarios[current.scenario].endpoint !== endpoint ||
      !current.mode
    )
      return null;
    const before = current.remainingFailures;
    // A LIMITED scenario always has a positive remainingFailures: `set()`
    // requires a positive failureCount, and consume() resets to NORMAL the
    // instant it would reach zero, so it can never be observed here.
    if (current.mode === "LIMITED" && before === null) return null;
    const after = current.mode === "LIMITED" ? (before as number) - 1 : null;
    const triggered = current.triggeredCount + 1;
    const decision: FaultDecision = {
      scenario: current.scenario,
      endpoint,
      mode: current.mode,
      parameters: { ...current.parameters },
      remainingBefore: before,
      remainingAfter: after,
    };
    if (ticket) {
      this.#consumedTickets.add(ticket);
      this.#requestDecisions.set(ticket, decision);
    }
    if (current.mode === "LIMITED" && after === 0) {
      this.#lastCompleted = {
        ...current,
        remainingFailures: 0,
        triggeredCount: triggered,
        completed: true,
        completedAt: new Date().toISOString(),
      };
      this.#current = normal();
      this.#activationId = null;
    } else {
      this.#current = {
        ...current,
        remainingFailures: after,
        triggeredCount: triggered,
      };
    }
    return decision;
  }
}
