import { scenarios } from "./registry.js";
import { parseScenarioInput } from "./validation.js";
import type {
  FaultDecision,
  FaultEndpoint,
  ScenarioConfig,
  ScenarioHistory,
  ScenarioRequestTicket,
  ScenarioView,
  SetScenarioInput,
} from "./types.js";

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
    return this.clear();
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

  consume(
    endpoint: FaultEndpoint,
    ticket?: ScenarioRequestTicket,
  ): FaultDecision | null {
    const current = this.#current;
    const requestBound = arguments.length >= 2;
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
    if (current.mode === "LIMITED" && (before === null || before <= 0))
      return null;
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
    if (ticket) this.#consumedTickets.add(ticket);
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
