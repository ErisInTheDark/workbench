/*
 * Exports:
 * - AtomicJsonStore: queue atomic JSON file mutations through temp-file rename writes and bounded journal compaction. Keywords: orchestrator, disk, json, atomic writes.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MAX_IN_MEMORY_JSON_LINES_COMPACT_BYTES = 8 * 1024 * 1024;

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
    await this.enqueue(filePath, async () => {
      const current = await this.read(filePath, fallback);
      const next = await updater(current);
      await this.write(filePath, next);
    });
  }

  async write(filePath: string, value: unknown) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await fs.writeFile(tempPath, `${JSON.stringify(value)}\n`, "utf8");
      await fs.rename(tempPath, filePath);
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
        await fs.rename(recoveringFilePath, filePath);
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
      await fs.rename(tempPath, recoveringFilePath);
      await fs.rm(filePath, { force: true });
      await fs.rename(recoveringFilePath, filePath);
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
