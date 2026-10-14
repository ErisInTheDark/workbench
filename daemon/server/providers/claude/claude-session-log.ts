/*
 * Exports:
 * - ClaudeSessionLogRecord: one main-conversation user or assistant line of a Claude session log.
 * - default ClaudeSessionLog: locate a native session log under Claude's data root and stream its lines.
 */
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

export interface ClaudeSessionLogRecord {
  type: "user" | "assistant";
  uuid: string;
  occurredAt: number;
  /** Raw line fields; the transcript adapter owns their meaning. */
  line: Record<string, unknown>;
}

export default class ClaudeSessionLog {
  private readonly files = new Map<string, string>();

  /** `dataRoot` is Claude's real data root; session logs live at `projects/<project dir>/<session id>.jsonl`. */
  constructor(private readonly dataRoot: string) {}

  /** Claude names project directories after a sanitized cwd; scanning avoids re-deriving its encoding. */
  async locate(sessionId: string) {
    const known = this.files.get(sessionId);
    if (known && await exists(known)) return known;
    const projects = path.join(this.dataRoot, "projects");
    let directories: string[];
    try {
      directories = await fs.readdir(projects);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    for (const directory of directories) {
      const candidate = path.join(projects, directory, `${sessionId}.jsonl`);
      if (await exists(candidate)) {
        this.files.set(sessionId, candidate);
        return candidate;
      }
    }
    return null;
  }

  lines(file: string) {
    return createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  }

  /** Main-conversation user and assistant lines with `from <= occurredAt < until`, in log order. */
  async read(file: string, window: { from: number; until: number }, signal?: AbortSignal) {
    const records: ClaudeSessionLogRecord[] = [];
    for await (const text of this.lines(file)) {
      signal?.throwIfAborted();
      if (!text.includes("\"type\":\"user\"") && !text.includes("\"type\":\"assistant\"")) continue;
      let line: Record<string, unknown>;
      try { line = JSON.parse(text) as Record<string, unknown>; } catch { continue; }
      if ((line.type !== "user" && line.type !== "assistant") || line.isSidechain === true) continue;
      const occurredAt = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : Number.NaN;
      if (typeof line.uuid !== "string" || !Number.isFinite(occurredAt)) continue;
      if (occurredAt < window.from || occurredAt >= window.until) continue;
      records.push({ type: line.type, uuid: line.uuid, occurredAt, line });
    }
    return records;
  }
}

async function exists(file: string) {
  try {
    return (await fs.stat(file)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
