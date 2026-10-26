/*
 * Exports:
 * - ApprovedCommandOptions: environment, live output listener and the Windows job runner.
 * - default executeApprovedCommand: own one explicitly approved unsandboxed process and its retirement, handing each
 *   captured output chunk to an optional listener as it arrives. Retirement ends its process group (Unix) or job
 *   (Windows), orphans included; it settles once its root exits, even while escaped descendants still hold its pipes.
 */
import { spawn } from "node:child_process";
import type { WorkbenchAdmittedExecution } from "../providers/provider-execution";
import { killProcessTreeAsync, lowerAgentProcessPriority } from "../process-helpers";
import type { CodexExecOutputListener } from "../providers/codex/CodexExecServer";

const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface ApprovedCommandOptions {
  environment?: NodeJS.ProcessEnv;
  onOutput?: CodexExecOutputListener;
  /** Windows: the native binary whose `job-run` mode runs a command in a job of its own, so a stop ends every descendant. */
  windowsJobRunner?: () => Promise<string>;
}

export default async function executeApprovedCommand(
  request: WorkbenchAdmittedExecution,
  signal: AbortSignal,
  { environment = process.env, onOutput, windowsJobRunner }: ApprovedCommandOptions = {},
) {
  if (request.permissions.mode !== "approved-unrestricted") {
    throw new Error("Direct process execution requires an approved Workbench command.");
  }
  signal.throwIfAborted();
  // Unix commands lead their own process group, which their retirement ends; Windows has jobs instead.
  const jobRunner = process.platform === "win32" && windowsJobRunner ? await windowsJobRunner() : null;
  signal.throwIfAborted();
  const [command, args] = jobRunner
    ? [jobRunner, ["job-run", ...request.command]]
    : [request.command[0]!, request.command.slice(1)];
  const options = {
    cwd: request.cwd,
    env: {
      ...environment,
      CODEX_THREAD_ID: "",
      WORKBENCH_THREAD_ID: request.caller.threadId,
      WORKBENCH_HARNESS: request.caller.harness,
    },
    detached: process.platform !== "win32",
    windowsHide: true,
  };
  // The job runner ends the command's whole job once its stdin closes.
  const child = jobRunner
    ? spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] })
    : spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  // Closing a runner that already exited is expected to fail.
  child.stdin?.on("error", () => {});
  lowerAgentProcessPriority(child);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  let closed = false;
  let abortReason: Error | null = null;
  let retirement: Promise<void> | null = null;
  const capture = (stream: "stdout" | "stderr", target: Buffer[]) => (chunk: Buffer) => {
    const accepted = chunk.subarray(0, Math.max(0, MAX_OUTPUT_BYTES - bytes));
    bytes += accepted.byteLength;
    truncated ||= accepted.byteLength < chunk.byteLength;
    if (!accepted.byteLength) return;
    target.push(accepted);
    onOutput?.(stream, accepted);
  };
  child.stdout.on("data", capture("stdout", stdout));
  child.stderr.on("data", capture("stderr", stderr));
  let markRetiring = () => {};
  const retiring = new Promise<null>(resolve => { markRetiring = () => resolve(null); });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  const ended = new Promise<{ code: number | null; error?: Error }>(resolve => {
    child.once("error", error => resolve({ code: null, error }));
    child.once("close", code => {
      closed = true;
      resolve({ code });
    });
  });
  const retire = (reason: Error) => {
    abortReason ??= reason;
    if (closed || retirement) return;
    if (child.stdin) {
      child.stdin.end();
      retirement = Promise.race([exited, ended]).then(() => {});
    } else {
      retirement = killProcessTreeAsync(child.pid);
    }
    markRetiring();
  };
  const onAbort = () => retire(signal.reason instanceof Error ? signal.reason : new Error("Command cancelled."));
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = request.timeoutMs === undefined ? null : setTimeout(() => {
    retire(new Error(`Command exceeded its requested ${request.timeoutMs}ms deadline.`));
  }, request.timeoutMs);
  if (signal.aborted) onAbort();
  try {
    const exit = await Promise.race([ended, retiring]);
    if (retirement) await retirement;
    if (!exit) {
      // A descendant that escaped the tree kill can hold the output pipes open for as long as it lives.
      await Promise.race([ended, exited]);
      child.stdout.destroy();
      child.stderr.destroy();
      throw abortReason ?? new Error("Command cancelled.");
    }
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
