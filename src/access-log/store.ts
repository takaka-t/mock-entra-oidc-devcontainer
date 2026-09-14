import type { AccessLogEntry } from "./types.js";

export const accessLogCapacity = 200;

export type AccessLogInput = Omit<AccessLogEntry, "id">;

function copy(entry: AccessLogEntry): AccessLogEntry {
  return {
    ...entry,
    fault: entry.fault ? { ...entry.fault, parameters: { ...entry.fault.parameters } } : null,
  };
}

/**
 * Fixed-capacity, newest-first request history. In-memory only, like the
 * scenario store: a restart drops it.
 */
export class InMemoryAccessLog {
  #entries: AccessLogEntry[] = [];
  #nextId = 1;
  readonly #capacity: number;

  constructor(capacity: number = accessLogCapacity) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new RangeError("Access log capacity must be a positive integer");
    this.#capacity = capacity;
  }

  get capacity(): number {
    return this.#capacity;
  }

  record(input: AccessLogInput): AccessLogEntry {
    const entry = copy({ ...input, id: this.#nextId++ });
    this.#entries.push(entry);
    if (this.#entries.length > this.#capacity) this.#entries.splice(0, this.#entries.length - this.#capacity);
    return copy(entry);
  }

  list(): AccessLogEntry[] {
    return this.#entries.map(copy).reverse();
  }

  clear(): void {
    this.#entries = [];
  }
}
