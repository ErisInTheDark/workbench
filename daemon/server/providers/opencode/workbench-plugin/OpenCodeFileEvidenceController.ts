/*
 * Exports:
 * - default OpenCodeFileEvidenceController: own bounded write observations across native execution hooks.
 */
import type { Result, Error as ToolError } from "@opencode/plugin/promise/tool";
import fs from "node:fs/promises";
import path from "node:path";
import { diffGitContents } from "../../../lib/workbench/git/git-content-diff";

interface FileCall {
  tool: string;
  sessionID: string;
  id: string;
  input: unknown;
}
type FileSettlement = FileCall & (
  | { status: "completed"; result: Result }
  | { status: "error"; error: ToolError }
);

interface Observation {
  lifetime: AbortController;
  work?: Promise<void>;
  file?: string;
  before?: string | null;
}

const TEXT_LIMIT = 8 * 1024 * 1024;

export default class OpenCodeFileEvidenceController {
  private readonly sessions = new Map<string, Map<string, Observation>>();
  private disposed = false;

  constructor(private readonly options: {
    isManagedSession(sessionID: string): Promise<boolean>;
    resolveCwd(sessionID: string): Promise<string>;
    readText?(file: string, signal: AbortSignal): Promise<string | null>;
    warn(message: string): void;
  }) {}

  async isNewWrite(sessionID: string, file: string) {
    if (this.disposed) throw new Error("File observation is disposed.");
    const target = path.resolve(await this.options.resolveCwd(sessionID), file);
    try {
      await fs.stat(target);
      return false;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
      throw error;
    }
  }

  async before(input: FileCall) {
    if (this.disposed || input.tool !== "write" || typeof input.input !== "object" || input.input === null
      || !("path" in input.input) || typeof input.input.path !== "string" || !input.input.path.trim()) return;
    let calls = this.sessions.get(input.sessionID);
    if (!calls) this.sessions.set(input.sessionID, calls = new Map());
    const previous = calls.get(input.id);
    previous?.lifetime.abort();
    const observation: Observation = { lifetime: new AbortController() };
    calls.set(input.id, observation);
    observation.work = this.captureBaseline(input, observation, input.input.path, previous?.work);
    await observation.work;
  }

  private async captureBaseline(input: FileCall, observation: Observation, file: string, previous?: Promise<void>) {
    try {
      await previous;
      observation.lifetime.signal.throwIfAborted();
      if (!await this.options.isManagedSession(input.sessionID)) {
        this.release(input, observation);
        return;
      }
      const cwd = await this.options.resolveCwd(input.sessionID);
      observation.lifetime.signal.throwIfAborted();
      observation.file = path.resolve(cwd, file);
      const before = await this.read(observation.file, observation.lifetime.signal);
      observation.lifetime.signal.throwIfAborted();
      observation.before = before;
    } catch {
      if (!observation.lifetime.signal.aborted) {
        this.options.warn("OpenCode write baseline could not be observed; native execution is unchanged.");
      }
      this.release(input, observation);
    }
  }

  async after(input: FileSettlement) {
    const observation = this.sessions.get(input.sessionID)?.get(input.id);
    if (!observation || observation.before === undefined || !observation.file) return;
    observation.work = this.captureResult(input, observation, observation.file, observation.before);
    await observation.work;
  }

  private async captureResult(input: FileSettlement, observation: Observation, file: string, before: string | null) {
    const { signal } = observation.lifetime;
    try {
      let status = before === null ? "added" : "modified";
      let patch = "";
      if (input.status === "completed") {
        const after = await this.read(file, signal);
        signal.throwIfAborted();
        if (after === null) throw new Error("Completed write target is missing.");
        const output = input.result.output;
        const existed = typeof output === "object" && output !== null && "existed" in output
          && typeof output.existed === "boolean" ? output.existed : undefined;
        status = existed === undefined ? status : existed ? "modified" : "added";
        if (existed === true && before === null) {
          this.options.warn("OpenCode write target appeared after baseline capture; applied diff is unavailable.");
        } else {
          patch = await diffGitContents(existed === false ? "" : before ?? "", after, { signal });
        }
      }
      signal.throwIfAborted();
      const metadata = { ...(input.status === "completed" ? input.result.metadata : input.error.metadata),
        files: [{ file, status, patch }] };
      if (input.status === "completed") input.result = { ...input.result, metadata };
      else Object.assign(input.error, { metadata });
    } catch {
      if (!signal.aborted) this.options.warn("OpenCode write evidence could not be captured; native outcome is unchanged.");
    } finally {
      this.release(input, observation);
    }
  }

  async settleSession(sessionID: string) {
    const calls = this.sessions.get(sessionID);
    this.sessions.delete(sessionID);
    for (const observation of calls?.values() ?? []) observation.lifetime.abort();
    await Promise.all([...(calls?.values() ?? [])].map(observation => observation.work));
  }

  async dispose() {
    this.disposed = true;
    await Promise.all([...this.sessions.keys()].map(sessionID => this.settleSession(sessionID)));
  }

  private release(input: FileCall, observation: Observation) {
    observation.lifetime.abort();
    const calls = this.sessions.get(input.sessionID);
    if (calls?.get(input.id) !== observation) return;
    calls.delete(input.id);
    if (!calls.size) this.sessions.delete(input.sessionID);
  }

  private async read(file: string, signal: AbortSignal) {
    if (this.options.readText) return this.options.readText(file, signal);
    signal.throwIfAborted();
    let handle;
    try {
      handle = await fs.open(file, "r");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > TEXT_LIMIT) throw new Error("Write observation is not bounded text.");
      const buffer = Buffer.alloc(Math.min(stat.size + 1, TEXT_LIMIT + 1));
      let length = 0;
      while (length < buffer.length) {
        signal.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > stat.size) throw new Error("Write observation grew while being read.");
      const contents = buffer.subarray(0, length);
      if (contents.includes(0)) throw new Error("Write observation is binary.");
      return new TextDecoder("utf-8", { fatal: true }).decode(contents);
    } finally {
      await handle.close();
    }
  }
}
