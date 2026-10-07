/*
 * Exports:
 * - REPO_SIDECAR_ARTIFACT: committed virtual repository sidecar description.
 * - default WorkbenchRepoProcess: verify, probe and own one cancellable virtual repository sidecar pipe.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { verifyNativeSidecarArtifact, type NativeSidecarArtifact } from "workbench-shared/native/native-sidecar-artifact";
import type { NativeArtifactStager } from "workbench-shared/process/NativeArtifactStage";
import {
  VirtualRepoPipeResponseSchema, VirtualRepoProbeSchema, type VirtualRepoAvailability,
} from "workbench-shared/workbench/repo/virtual-repo-contract";

export const REPO_SIDECAR_ARTIFACT: NativeSidecarArtifact = {
  label: "repo", buildScript: "build:repo", source: "daemon/repo", executable: "workbench-repo", protocol: 1,
};

const MAX_LINE_BYTES = 1 << 20;

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export default class WorkbenchRepoProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private exited: Promise<void> = Promise.resolve();
  private failure: Error | null = null;
  private closing = false;
  private output = "";
  private readonly pending = new Map<string, Pending>();

  private constructor(private readonly warn: (message: string) => void) {}

  static platform(): VirtualRepoAvailability["platform"] {
    return process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : "other";
  }

  /** Reports the first missing prerequisite. Check failures never claim something is missing. */
  static async probe(root: string, warn: (message: string) => void, stage?: NativeArtifactStager): Promise<VirtualRepoAvailability> {
    const platform = WorkbenchRepoProcess.platform();
    if (platform === "other" || process.arch !== "x64") return { platform, status: "unsupported" };
    let executable: string;
    try {
      executable = await verifyNativeSidecarArtifact(root, REPO_SIDECAR_ARTIFACT, stage);
    } catch (error) {
      warn(error instanceof Error ? error.message : "The repository sidecar could not be verified.");
      return { platform, status: "nativeMissing" };
    }
    const output = await new Promise<string | null>(resolve => {
      execFile(executable, ["probe"], { windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout) => {
        resolve(error ? null : stdout);
      });
    });
    const parsed = output === null ? null : VirtualRepoProbeSchema.safeParse(safeJson(output));
    if (!parsed?.success) {
      warn("The repository sidecar probe failed.");
      return { platform, status: "checkFailed" };
    }
    return { platform, ...parsed.data };
  }

  static async start(root: string, cacheDirectory: string, warn: (message: string) => void, stage?: NativeArtifactStager) {
    const executable = await verifyNativeSidecarArtifact(root, REPO_SIDECAR_ARTIFACT, stage);
    const owner = new WorkbenchRepoProcess(warn);
    const child = spawn(executable, ["serve", "--cache-dir", cacheDirectory], { cwd: root, windowsHide: true, stdio: "pipe" });
    owner.child = child;
    owner.exited = new Promise(resolve => {
      child.once("close", code => {
        if (!owner.closing || code !== 0) owner.fail(new Error(`Repository process exited unexpectedly (${code ?? "signal"}).`));
        owner.child = null;
        owner.rejectPending(owner.failure ?? new Error("Repository process closed."));
        resolve();
      });
    });
    child.once("error", () => owner.fail(new Error("Repository process could not run.")));
    child.stdin.on("error", () => { if (!owner.closing) owner.fail(new Error("Repository command pipe failed.")); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => owner.receive(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      // Git diagnostics may name private remotes; report size only.
      warn(`Repository process emitted a diagnostic (${chunk.length} bytes); raw content was withheld.`);
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => reject(new Error("Repository process could not start.")));
    });
    return owner;
  }

  get failed() {
    return this.failure !== null;
  }

  request(action: string, payload: object, signal?: AbortSignal): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closing || !this.child) return Promise.reject(new Error("Repository process is not running."));
    signal?.throwIfAborted();
    const id = randomUUID();
    const child = this.child;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        if (this.pending.has(id) && this.child) this.child.stdin.write(`${JSON.stringify({ id: randomUUID(), action: "cancel", payload: { id } })}\n`);
      };
      signal?.addEventListener("abort", cancel, { once: true });
      this.pending.set(id, {
        resolve: value => { signal?.removeEventListener("abort", cancel); resolve(value); },
        reject: error => { signal?.removeEventListener("abort", cancel); reject(error); },
      });
      child.stdin.write(`${JSON.stringify({ id, action, payload })}\n`, error => {
        if (error && !this.closing) this.fail(new Error("Repository command could not be sent."));
      });
    });
  }

  /** Closing stdin makes the sidecar unmount everything before it exits. */
  async close() {
    this.closing = true;
    this.child?.stdin.end();
    await this.exited;
  }

  private receive(chunk: string) {
    if (this.failure) return;
    this.output += chunk;
    for (;;) {
      const newline = this.output.indexOf("\n");
      if (newline < 0) break;
      const line = this.output.slice(0, newline);
      this.output = this.output.slice(newline + 1);
      const parsed = VirtualRepoPipeResponseSchema.safeParse(safeJson(line));
      if (!parsed.success) {
        this.fail(new Error("Repository process returned an invalid response; its content was withheld."));
        return;
      }
      const pending = this.pending.get(parsed.data.id);
      // Cancel acknowledgements use their own ids and have no waiter.
      if (!pending) continue;
      this.pending.delete(parsed.data.id);
      if ("error" in parsed.data) pending.reject(new Error(parsed.data.error));
      else pending.resolve(parsed.data.result);
    }
    if (Buffer.byteLength(this.output, "utf8") > MAX_LINE_BYTES) {
      this.fail(new Error("Repository process response exceeded its size limit."));
    }
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    this.warn(error.message);
    this.rejectPending(error);
    this.child?.kill();
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
