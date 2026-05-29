/*
 * Exports:
 * - AtomicJsonStore: queue atomic JSON file mutations through temp-file rename writes and bounded journal compaction. Keywords: orchestrator, disk, json, atomic writes.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MAX_IN_MEMORY_JSON_LINES_COMPACT_BYTES = 8 * 1024 * 1024;
const WINDOWS_RENAME_RETRY_ERROR_CODES = new Set(["EBUSY", "EPERM"]);
const WINDOWS_RENAME_RETRY_ATTEMPTS = 5;
const WINDOWS_RENAME_RETRY_BASE_DELAY_MS = 20;

export type AtomicJsonUpdateResult = {
  changed: boolean;
  written: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function canonicalizeJson(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }

  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nestedValue]) => [key, canonicalizeJson(nestedValue)]));
}

function stableJsonStringify(value: unknown) {
  return `${JSON.stringify(canonicalizeJson(value))}\n`;
}

function isWindowsRenameRetryError(error: unknown) {
  return process.platform === "win32"
    && isRecord(error)
    && typeof error.code === "string"
    && WINDOWS_RENAME_RETRY_ERROR_CODES.has(error.code);
}

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createRenameRetryDelay(attempt: number) {
  return WINDOWS_RENAME_RETRY_BASE_DELAY_MS * (attempt + 1)
    + Math.floor(Math.random() * WINDOWS_RENAME_RETRY_BASE_DELAY_MS);
}

export default class AtomicJsonStore {
  private readonly queues = new Map<string, Promise<void>>();

  async read<TValue>(filePath: string, fallback: TValue) {
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8")) as TValue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return fallback;
      }

      throw error;
    }
  }

  async update<TValue>(
    filePath: string,
    fallback: TValue,
    updater: (current: TValue) => TValue | Promise<TValue>,
  ) {
    await this.updateIfChanged(filePath, fallback, updater);
  }

  async updateIfChanged<TValue>(
    filePath: string,
    fallback: TValue,
    updater: (current: TValue) => TValue | Promise<TValue>,
  ): Promise<AtomicJsonUpdateResult> {
    let result: AtomicJsonUpdateResult = {
      changed: false,
      written: false,
    };
    await this.enqueue(filePath, async () => {
      const current = await this.read(filePath, fallback);
      const next = await updater(current);
      result = {
        changed: stableJsonStringify(current) !== stableJsonStringify(next),
        written: false,
      };
      if (!result.changed) {
        return;
      }

      await this.write(filePath, next);
      result = {
        changed: true,
        written: true,
      };
    });
    return result;
  }

  async write(filePath: string, value: unknown) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await fs.writeFile(tempPath, stableJsonStringify(value), "utf8");
      await this.renameWithRetry(tempPath, filePath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async appendLine(filePath: string, value: unknown) {
    await this.enqueue(filePath, async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
    });
  }

  async compactJsonLines<TValue extends { id?: unknown; receivedAt?: unknown }>(filePath: string) {
    await this.enqueue(filePath, async () => {
      const stats = await fs.stat(filePath).catch((error) => {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          return null;
        }

        throw error;
      });
      if (stats && stats.size > MAX_IN_MEMORY_JSON_LINES_COMPACT_BYTES) {
        return;
      }

      const events = await this.readJsonLines<TValue>(filePath);
      if (!events.length) {
        const recoveringFilePath = this.recoveringJsonLinesPath(filePath);
        const recoveringEvents = await this.readJsonLines<TValue>(recoveringFilePath);
        if (!recoveringEvents.length) {
          return;
        }
        await this.renameWithRetry(recoveringFilePath, filePath);
        return;
      }

      const eventsById = new Map(events.map((event, index) => [
        typeof event.id === "string" ? event.id : `${index}`,
        event,
      ]));
      const compactedEvents = Array.from(eventsById.values()).sort((left, right) => (
        this.readReceivedAt(left) - this.readReceivedAt(right)
      ));
      const recoveringFilePath = this.recoveringJsonLinesPath(filePath);
      const tempPath = `${recoveringFilePath}.tmp-${process.pid}-${randomUUID()}`;
      await fs.writeFile(tempPath, `${compactedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
      await this.renameWithRetry(tempPath, recoveringFilePath);
      await fs.rm(filePath, { force: true });
      await this.renameWithRetry(recoveringFilePath, filePath);
    });
  }

  private readReceivedAt(value: { receivedAt?: unknown }) {
    return typeof value.receivedAt === "number" && Number.isFinite(value.receivedAt)
      ? value.receivedAt
      : 0;
  }

  private recoveringJsonLinesPath(filePath: string) {
    return filePath.replace(/\.ndjson$/u, ".new.ndjson");
  }

  private async renameWithRetry(sourcePath: string, targetPath: string) {
    for (let attempt = 0; attempt <= WINDOWS_RENAME_RETRY_ATTEMPTS; attempt += 1) {
      try {
        await fs.rename(sourcePath, targetPath);
        return;
      } catch (error) {
        if (!isWindowsRenameRetryError(error) || attempt >= WINDOWS_RENAME_RETRY_ATTEMPTS) {
          if (isWindowsRenameRetryError(error)) {
            process.stderr.write(`[atomic-json] rename retry exhausted source=${sourcePath} target=${targetPath}\n`);
          }
          throw error;
        }

        await delay(createRenameRetryDelay(attempt));
      }
    }
  }

  async readJsonLines<TValue>(filePath: string) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return raw
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as TValue;
          } catch {
            return null;
          }
        })
        .filter((value): value is TValue => value !== null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  private async enqueue(filePath: string, task: () => Promise<void>) {
    const previous = this.queues.get(filePath) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.queues.set(filePath, next);

    try {
      await next;
    } finally {
      if (this.queues.get(filePath) === next) {
        this.queues.delete(filePath);
      }
    }
  }

  async waitForIdle() {
    await Promise.allSettled(Array.from(this.queues.values()));
  }
}
