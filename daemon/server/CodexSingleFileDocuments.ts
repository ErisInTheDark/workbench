/*
 * Exports:
 * - SingleFileJournalTag: Workbench-owned session evidence categories.
 * - default CodexSingleFileDocuments: retained documents, ordered journals and last-ten pruning.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { VoiceStartSchema } from "workbench-shared/workbench/voice/voice-session-contract";
import type { SingleFileDocument } from "./CodexSingleFileController";

export type SingleFileJournalTag = "original" | "instructions" | "tools" | "agent-input" | "agent-output" | "tool-response" | "vtt" | "patch-applied" | "completed" | "cancelled" | "error";

function hasErrorCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}

function timestampedSessionName() {
  const timestamp = new Date().toISOString();
  return `session-${timestamp.slice(2, 10).replaceAll("-", "")}-${timestamp.slice(11, 19).replaceAll(":", "")}`;
}

async function createSessionDirectory(root: string) {
  const directory = path.join(root, timestampedSessionName());
  try {
    await fs.mkdir(directory);
    return directory;
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw error;
    return fs.mkdtemp(`${directory}-`);
  }
}

export default class CodexSingleFileDocuments {
  private readonly active = new Set<string>();
  private pruning: Promise<void> = Promise.resolve();
  constructor(private readonly root: string) {}

  async create(text: string): Promise<SingleFileDocument> {
    await fs.mkdir(this.root, { recursive: true });
    const root = await fs.realpath(this.root);
    if ((await fs.lstat(this.root)).isSymbolicLink()) throw new Error("Voice history directory must not be a symbolic link.");
    const directory = await createSessionDirectory(root);
    this.active.add(directory);
    const file = path.join(directory, "document.txt");
    const journal = path.join(directory, "transcript.md");
    let writes = Promise.resolve();
    let closed = false;
    const append: SingleFileDocument["append"] = (tag, content) => {
      if (closed) return Promise.reject(new Error("Voice session journal is closed."));
      const escaped = content.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      // Retain write failure so subsequent events cannot make a partial journal look complete.
      writes = writes.then(() => fs.appendFile(journal, `<${tag}>\n${escaped}\n</${tag}>\n\n`, "utf8"));
      return writes;
    };
    try {
      await fs.writeFile(file, text, { encoding: "utf8", flag: "wx" });
      await fs.writeFile(journal, "", { encoding: "utf8", flag: "wx" });
      await append("original", text);
      await this.prune(root);
    } catch (error) {
      this.active.delete(directory);
      throw error;
    }
    return {
      directory, file, append,
      async read() {
        const info = await fs.lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 4_000_000) throw new Error("Invalid voice scratch document.");
        return VoiceStartSchema.shape.text.parse(await fs.readFile(file, "utf8"));
      },
      dispose: async () => {
        closed = true;
        try { await writes; }
        finally {
          this.active.delete(directory);
          await this.prune(root);
        }
      },
    };
  }

  private async prune(root: string) {
    const operation = this.pruning.then(() => this.pruneCurrent(root));
    // Each caller receives its failure; subsequent independent retirements can retry.
    this.pruning = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async pruneCurrent(root: string) {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const sessions = await Promise.all(entries
      .filter(entry => entry.isDirectory() && /^session-(?:\d{6}-\d{6}(?:-[A-Za-z0-9]+)?|[A-Za-z0-9]+)$/u.test(entry.name))
      .map(async entry => {
        const directory = path.resolve(root, entry.name);
        if (path.dirname(directory) !== root) throw new Error("Invalid voice history path.");
        return { directory, created: (await fs.lstat(directory, { bigint: true })).birthtimeNs };
      }));
    sessions.sort((a, b) => a.created === b.created ? b.directory.localeCompare(a.directory) : a.created > b.created ? -1 : 1);
    const retained = new Set(this.active);
    for (const session of sessions) {
      if (retained.has(session.directory)) continue;
      if (retained.size < 10) { retained.add(session.directory); continue; }
      if (this.active.has(session.directory)) continue;
      const info = await fs.lstat(session.directory);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Voice history changed during pruning.");
      await fs.rm(session.directory, { recursive: true });
    }
  }
}
