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

  /**
   * Reserves the id for a request as it arrives. Entries are only recorded
   * once the response settles, so a request held by a timeout scenario would
   * otherwise be numbered after faster requests that arrived later. Ids are
   * a monotonic arrival sequence, not wall-clock time, so the listing stays in
   * arrival order even if the system clock moves.
   */
  nextId(): number {
    return this.#nextId++;
  }

  record(input: AccessLogInput, id: number = this.nextId()): AccessLogEntry {
    const entry = copy({ ...input, id });
    // Entries usually settle in arrival order; a late settle walks back from
    // the end to its slot so the array stays sorted by id.
    let index = this.#entries.length;
    while (index > 0 && (this.#entries[index - 1]?.id ?? 0) > id) index--;
    this.#entries.splice(index, 0, entry);
    if (this.#entries.length > this.#capacity) this.#entries.splice(0, this.#entries.length - this.#capacity);
    return copy(entry);
  }

  /** Newest arrival first. */
  list(): AccessLogEntry[] {
    return this.#entries.map(copy).reverse();
  }

  clear(): void {
    this.#entries = [];
  }
}
