/*
 * Exports:
 * - default executeApprovedCommand: own one explicitly approved unsandboxed process and its retirement.
 */
import { spawn } from "node:child_process";
import type { WorkbenchAdmittedExecution } from "workbench-shared/workbench/provider/provider-execution";
import { killProcessTreeAsync } from "./process-helpers";

const MAX_OUTPUT_BYTES = 1024 * 1024;

export default async function executeApprovedCommand(
  request: WorkbenchAdmittedExecution,
  signal: AbortSignal,
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (request.permissions.mode !== "approved-unrestricted") {
    throw new Error("Direct process execution requires an approved Workbench command.");
  }
  signal.throwIfAborted();
  const child = spawn(request.command[0]!, request.command.slice(1), {
    cwd: request.cwd,
    env: {
      ...environment,
      CODEX_THREAD_ID: "",
      WORKBENCH_THREAD_ID: request.caller.threadId,
      WORKBENCH_HARNESS: request.caller.harness,
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  let closed = false;
  let abortReason: Error | null = null;
  let retirement: Promise<void> | null = null;
  const capture = (target: Buffer[]) => (chunk: Buffer) => {
    const accepted = chunk.subarray(0, Math.max(0, MAX_OUTPUT_BYTES - bytes));
    bytes += accepted.byteLength;
    truncated ||= accepted.byteLength < chunk.byteLength;
    if (accepted.byteLength) target.push(accepted);
  };
  child.stdout.on("data", capture(stdout));
  child.stderr.on("data", capture(stderr));
  const retire = (reason: Error) => {
    abortReason ??= reason;
    if (!closed && !retirement) retirement = killProcessTreeAsync(child.pid);
  };
  const onAbort = () => retire(signal.reason instanceof Error ? signal.reason : new Error("Command cancelled."));
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = request.timeoutMs === undefined ? null : setTimeout(() => {
    retire(new Error(`Command exceeded its requested ${request.timeoutMs}ms deadline.`));
  }, request.timeoutMs);
  if (signal.aborted) onAbort();
  try {
    const exit = await new Promise<{ code: number | null; error?: Error }>(resolve => {
      child.once("error", error => resolve({ code: null, error }));
      child.once("close", code => {
        closed = true;
        resolve({ code });
      });
    });
    if (retirement) await retirement;
    if (abortReason) throw abortReason;
    if (exit.error) throw exit.error;
    if (exit.code === null) throw new Error("Approved command exited without a status.");
    return {
      exitCode: exit.code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8") + (truncated ? "\n[command output truncated]\n" : ""),
    };
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
