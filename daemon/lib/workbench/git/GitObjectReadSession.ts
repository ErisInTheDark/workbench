/*
 * Exports:
 * - default GitObjectReadSession: own operation-scoped Git object streams and deterministic disposal.
 * - GitObjectReadResult: object identity and optional raw contents; null means missing.
 * - GitObjectReadProcess: injectable process boundary for protocol/lifecycle tests.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type GitObjectReadResult = {
  objectId: string;
  type: string;
  size: number;
  contents: Buffer | null;
} | null;

export type GitObjectReadProcess = Pick<ChildProcessWithoutNullStreams, "stdin" | "stdout" | "stderr" | "once" | "kill">;
type Request = {
  expression: string;
  mode: "contents" | "info";
  resolve: (result: GitObjectReadResult) => void;
  reject: (error: Error) => void;
};
type Scope = { readers: Map<string, GitObjectReadSession>; closed: boolean };
type State = { kind: "open" | "closing" | "closed" } | { kind: "failed"; error: Error };

const scopes = new AsyncLocalStorage<Scope>();

function startGit(root: string): GitObjectReadProcess {
  return spawn("git", ["cat-file", "--batch-command"], {
    cwd: root, env: process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
}

export default class GitObjectReadSession {
  static async run<T>(callback: () => Promise<T>): Promise<T> {
    const current = scopes.getStore();
    if (current) {
      if (current.closed) throw new Error("Git object read scope is closed.");
      return await callback();
    }
    const scope: Scope = { readers: new Map(), closed: false };
    return await scopes.run(scope, async () => {
      let result: T;
      try {
        result = await callback();
      } catch (error) {
        scope.closed = true;
        const cause = error instanceof Error ? error : new Error(String(error));
        for (const reader of scope.readers.values()) reader.abort(cause);
        const cleanup = await Promise.allSettled([...scope.readers.values()].map((reader) => reader.close()));
        const failures = cleanup.flatMap((entry) => entry.status === "rejected" && entry.reason !== cause ? [entry.reason] : []);
        if (failures.length) throw new AggregateError([error, ...failures], "Git operation and object-reader cleanup failed.");
        throw error;
      }
      scope.closed = true;
      const cleanup = await Promise.allSettled([...scope.readers.values()].map((reader) => reader.close()));
      const failures = cleanup.flatMap((entry) => entry.status === "rejected" ? [entry.reason] : []);
      if (failures.length) throw new AggregateError(failures, "Git object-reader cleanup failed.");
      return result;
    });
  }

  static async read(root: string, expressions: string[], mode: Request["mode"] = "contents") {
    return await this.run(async () => {
      const scope = scopes.getStore()!;
      let reader = scope.readers.get(root);
      if (!reader) {
        reader = new GitObjectReadSession(root);
        scope.readers.set(root, reader);
      }
      return await reader.read(expressions, mode);
    });
  }

  private readonly child: GitObjectReadProcess;
  private readonly closed: Promise<void>;
  private state: State = { kind: "open" };
  private readonly pending: Request[] = [];
  private header = Buffer.alloc(0);
  private payload: { result: NonNullable<GitObjectReadResult>; chunks: Buffer[]; remaining: number } | null = null;
  private stderr = "";

  constructor(root: string, start: (root: string) => GitObjectReadProcess = startGit) {
    try {
      this.child = start(root);
    } catch (error) {
      console.warn("[git-object-reader] spawn failed");
      throw error;
    }
    this.closed = new Promise<void>((resolve) => {
      this.child.once("close", (code: number | null) => {
        if (this.state.kind !== "failed") {
          if (code !== 0 || this.state.kind !== "closing" || this.pending.length || this.header.length || this.payload) {
            this.fail("closed", new Error(`Git object stream closed unexpectedly (exit ${code}).${this.stderr ? ` ${this.stderr}` : ""}`), false);
          } else this.state = { kind: "closed" };
        }
        resolve();
      });
    });
    this.child.once("error", (error: Error) => this.fail("process", error));
    this.child.stdin.on("error", (error: Error) => this.fail("stdin", error));
    this.child.stdout.on("error", (error: Error) => this.fail("stdout", error));
    this.child.stderr.on("error", (error: Error) => this.fail("stderr", error));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8").replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?")).slice(0, 500);
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      try {
        this.consume(chunk);
      } catch (error) {
        this.fail("protocol", error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async read(expressions: string[], mode: Request["mode"] = "contents"): Promise<GitObjectReadResult[]> {
    if (this.state.kind !== "open") throw this.state.kind === "failed" ? this.state.error : new Error("Git object stream is closed.");
    if (expressions.some((value) => !value.trim() || /[\r\n]/u.test(value))) {
      throw new Error("A valid Git object expression is required.");
    }
    if (!expressions.length) return [];
    const results = expressions.map((expression) => new Promise<GitObjectReadResult>((resolve, reject) => {
      this.pending.push({ expression, mode, resolve, reject });
    }));
    const completed = Promise.all(results);
    try {
      this.child.stdin.write(expressions.map((expression) => `${mode} ${expression}\n`).join(""), (error) => {
        if (error) this.fail("stdin", error);
      });
    } catch (error) {
      this.fail("stdin", error instanceof Error ? error : new Error(String(error)));
    }
    return await completed;
  }

  async close() {
    if (this.state.kind === "open") {
      this.state = { kind: "closing" };
      try {
        this.child.stdin.end();
      } catch (error) {
        this.fail("stdin", error instanceof Error ? error : new Error(String(error)));
      }
    }
    await this.closed;
    if (this.state.kind === "failed") throw this.state.error;
  }

  private abort(error: Error) {
    if (this.state.kind === "closed" || this.state.kind === "failed") return;
    this.state = { kind: "failed", error };
    for (const request of this.pending.splice(0)) request.reject(error);
    this.header = Buffer.alloc(0);
    this.payload = null;
    this.child.kill();
  }

  private fail(stage: string, error: Error, kill = true) {
    if (this.state.kind === "failed" || this.state.kind === "closed") return;
    console.warn(`[git-object-reader] ${stage} failed`);
    this.state = { kind: "failed", error };
    for (const request of this.pending.splice(0)) request.reject(error);
    this.header = Buffer.alloc(0);
    this.payload = null;
    if (kill) this.child.kill();
  }

  private consume(chunk: Buffer) {
    if (this.state.kind === "failed" || this.state.kind === "closed") return;
    let offset = 0;
    while (offset < chunk.length) {
      const request = this.pending[0];
      if (!request) throw new Error("Git object stream returned an unsolicited response.");
      if (this.payload) {
        const take = Math.min(this.payload.remaining, chunk.length - offset);
        if (take) {
          this.payload.chunks.push(chunk.subarray(offset, offset + take));
          this.payload.remaining -= take;
          offset += take;
        }
        if (this.payload.remaining || offset === chunk.length) return;
        if (chunk[offset++] !== 0x0a) throw new Error("Git cat-file batch payload terminator is missing.");
        const { result, chunks } = this.payload;
        this.payload = null;
        this.pending.shift();
        request.resolve({ ...result, contents: Buffer.concat(chunks, result.size) });
        continue;
      }
      const end = chunk.indexOf(0x0a, offset);
      if (end < 0) {
        this.header = Buffer.concat([this.header, chunk.subarray(offset)]);
        return;
      }
      const header = Buffer.concat([this.header, chunk.subarray(offset, end)]).toString("utf8");
      this.header = Buffer.alloc(0);
      offset = end + 1;
      if (header === `${request.expression} missing`) {
        this.pending.shift();
        request.resolve(null);
        continue;
      }
      const match = /^([a-f0-9]+) (\S+) (\d+)$/iu.exec(header);
      const size = match ? Number(match[3]) : NaN;
      if (!match || !Number.isSafeInteger(size) || size < 0) throw new Error("Git cat-file returned an invalid object header.");
      const result = { objectId: match[1]!, type: match[2]!, size, contents: null };
      if (request.mode === "info") {
        this.pending.shift();
        request.resolve(result);
      } else {
        this.payload = { result, chunks: [], remaining: size };
      }
    }
  }
}
