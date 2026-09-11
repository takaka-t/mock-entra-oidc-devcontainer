import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

export type JsonFileContents =
  { exists: true; value: unknown } | { exists: false };

/** Reads and parses a JSON file. A missing file is reported, not thrown. */
export async function readJsonFile(
  filePath: string,
): Promise<JsonFileContents> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { exists: false };
  }
  return { exists: true, value: JSON.parse(raw) as unknown };
}

/**
 * Writes `value` to a private (0600) temporary file next to `filePath` so the
 * caller can finish other work before making it visible with
 * commitStagedFile(). The temporary file is removed again on failure.
 */
export async function stageJsonFile(
  filePath: string,
  value: unknown,
): Promise<string> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    return temporary;
  } catch (error) {
    try {
      await discardStagedFile(temporary);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `failed to stage ${filePath}`,
        { cause: error },
      );
    }
    throw error;
  }
}

export function commitStagedFile(
  temporary: string,
  filePath: string,
): Promise<void> {
  return rename(temporary, filePath);
}

export async function discardStagedFile(temporary: string): Promise<void> {
  try {
    await unlink(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Runs asynchronous operations one at a time, in submission order. */
export class SerialQueue {
  #queue: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#queue;
    let release!: () => void;
    this.#queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
