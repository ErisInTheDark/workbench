/*
 * Exports:
 * - WorkbenchExecReaperOptions: the executor, root store and sandboxed runner a reaper works through.
 * - buildExecReapScript: the pwsh that stops surviving command roots, checked against their start times.
 * - default WorkbenchExecReaper: record every command root of the current executor, and stop the roots an earlier
 *   generation left running.
 *
 * Commands run as the sandbox account, so only a sandboxed process can stop them; a hard-killed daemon never got to.
 */
import type CodexExecServer from "../CodexExecServer";
import type WorkbenchExecRootStore from "../database/exec/WorkbenchExecRootStore";
import type { ExecRootRecord } from "../database/exec/WorkbenchExecRootStore";

export interface WorkbenchExecReaperOptions {
  executor: Pick<CodexExecServer, "generation" | "onRoot">;
  store: Pick<WorkbenchExecRootStore, "record" | "forget" | "takeStale">;
  /** Runs argv as the sandbox identity in `root`. */
  runSandboxed(command: string[], root: string, signal: AbortSignal): Promise<{ code: number; stdout: string }>;
  /** Existing directory the reap script runs in. */
  root: string;
  platform?: NodeJS.Platform;
  log(message: string): void;
}

function message(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 400);
}

/** Stops each still-running root whose start time matches, leaves first, and prints `reaped <pid>` per root. */
export function buildExecReapScript(roots: readonly Pick<ExecRootRecord, "pid" | "startedAt">[]) {
  const targets = roots.map(root => `@{ Id = ${Math.trunc(root.pid)}; Start = '${root.startedAt.replace(/\D/gu, "")}' }`).join(", ");
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$all = @(Get-Process)",
    "function Stop-Tree([int]$Id) { foreach ($child in @($all | Where-Object { $_.Parent.Id -eq $Id })) { Stop-Tree $child.Id }; Stop-Process -Id $Id -Force }",
    `foreach ($target in @(${targets})) {`,
    "  $process = $all | Where-Object { $_.Id -eq $target.Id }",
    "  if ($process -and $process.StartTime.ToFileTimeUtc().ToString() -eq $target.Start) { Stop-Tree $target.Id; \"reaped $($target.Id)\" }",
    "}",
  ].join("\n");
}

export default class WorkbenchExecReaper {
  private stopListening: (() => void) | null = null;
  private readonly lifetime = new AbortController();

  constructor(private readonly options: WorkbenchExecReaperOptions) {}

  /** Starts recording this generation's roots, then reaps what earlier generations left. */
  async start() {
    const { executor, store } = this.options;
    this.stopListening = executor.onRoot(event => {
      const write = event.kind === "root"
        ? store.record({ processId: event.processId, generation: executor.generation, pid: event.pid, startedAt: event.startedAt })
        : store.forget(event.processId);
      void write.catch(error => this.options.log(`Command root ${event.kind === "root" ? "record" : "removal"} failed: ${message(error)}`));
    });
    const stale = await store.takeStale(executor.generation);
    if (!stale.length || (this.options.platform ?? process.platform) !== "win32") return;
    const result = await this.options.runSandboxed(
      ["pwsh", "-NoProfile", "-NonInteractive", "-Command", buildExecReapScript(stale)], this.options.root, this.lifetime.signal,
    );
    const reaped = result.stdout.split(/\r?\n/u).filter(line => line.startsWith("reaped ")).length;
    if (result.code !== 0) this.options.log(`Reaping ${stale.length} leftover command(s) exited with ${result.code}.`);
    if (reaped) this.options.log(`Stopped ${reaped} command(s) left running by an earlier executor.`);
  }

  dispose() {
    this.stopListening?.();
    this.stopListening = null;
    this.lifetime.abort(new Error("Command reaping is reloading."));
  }
}
