import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

/** The file's text, or `undefined` when there is no file. */
export async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function readJson(path: string): Promise<unknown | undefined> {
  const raw = await readText(path);
  if (raw === undefined) return undefined;
  return JSON.parse(raw) as unknown;
}

/**
 * Writes through a sibling temp file and rename, so readers never see a partial file. When
 * `durable`, the data is on disk before the rename and the rename after it, so a crash leaves the
 * old file or the new one, never an empty one. (On macOS each of those syncs is a full flush that
 * takes milliseconds, so files that are only a spare copy skip them.)
 */
export async function writeJsonAtomic(path: string, value: unknown, { mode = 0o600, durable = true } = {}): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const file = await open(temporary, "wx", mode);
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      if (durable) await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  if (durable) await syncDirectory(directory);
}

/** Makes a rename in `directory` durable. Where a directory can't be opened or synced, it's skipped. */
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r").catch(() => null);
  if (!handle) return;
  await handle.sync().catch(() => undefined);
  await handle.close();
}

/** Runs async sections one at a time, in call order. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(section: () => Promise<T>): Promise<T> {
    const result = this.tail.then(section, section);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
