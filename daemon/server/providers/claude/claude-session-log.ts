/*
 * Exports:
 * - ClaudeSessionLogRecord: one main-conversation user or assistant line of a Claude session log.
 * - default ClaudeSessionLog: locate a native session log under Claude's data root, copy it under another cwd's project directory,
 *   and stream its lines.
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

  /**
   * Makes the session's log resumable from `cwd`: Claude resumes only from the project directory named after the cwd, so a
   * log found elsewhere is copied there. The original stays for anything still reading it. Returns the log at `cwd`.
   */
  async ensureAt(sessionId: string, cwd: string) {
    const target = path.join(this.dataRoot, "projects", claudeProjectDirectory(cwd), `${sessionId}.jsonl`);
    if (await exists(target)) return target;
    const source = await this.locate(sessionId);
    if (!source) throw new Error("Claude session log is missing, so the session cannot move.");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    this.files.set(sessionId, target);
    return target;
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

/** Claude's project directory name for a cwd: every character outside ASCII letters and digits becomes `-`. */
function claudeProjectDirectory(cwd: string) {
  return cwd.replace(/[^A-Za-z0-9]/gu, "-");
}

async function exists(file: string) {
  try {
    return (await fs.stat(file)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
