/*
 * Exports:
 * - WorkbenchShellRunnerOptions: the exec node's executor, expensive-command slots, direct-spawn ports and Windows job runner.
 * - WorkbenchShellObserver: one shell's expensive-queue ticket plus its live output listener.
 * - default WorkbenchShellRunner: run one prepared agent command where its process lives, outside every provider generation;
 *   a failed or stopped command carries what it printed on its failure.
 */
import type CodexExecServer from "../providers/codex/CodexExecServer";
import type { CodexExecOutputListener } from "../providers/codex/CodexExecServer";
import executeApprovedCommand from "../interactions/WorkbenchApprovedCommandExecutor";
import type WorkbenchCommandCapacity from "./WorkbenchCommandCapacity";
import type { WorkbenchCommandQueueTicket } from "./WorkbenchCommandCapacity";
import type { WorkbenchShellRun, WorkbenchShellRunResult } from "../providers/provider-execution";
import { withWorkbenchShellPartialOutput } from "./workbench-shell-partial-output";

export interface WorkbenchShellRunnerOptions {
  executor: Pick<CodexExecServer, "execute">;
  /** Machine-wide slots for expensive commands; absent means every command runs immediately. */
  capacity?: Pick<WorkbenchCommandCapacity, "run">;
  executeApproved?: typeof executeApprovedCommand;
  environment?: NodeJS.ProcessEnv;
  /** Windows: stages the native binary that runs approved commands in jobs of their own. */
  windowsJobRunner?: () => Promise<string>;
}

export interface WorkbenchShellObserver extends WorkbenchCommandQueueTicket {
  /** Each captured output chunk while the command runs; the result still carries all of it. */
  output?: CodexExecOutputListener;
}

export default class WorkbenchShellRunner {
  constructor(private readonly options: WorkbenchShellRunnerOptions) {}

  /**
   * Expensive commands wait for a shared slot before starting, so their own timeout measures only running time.
   * A command that waited reports its queue time as `queuedMs`.
   */
  async run(run: WorkbenchShellRun, signal: AbortSignal, observer?: WorkbenchShellObserver): Promise<WorkbenchShellRunResult> {
    const start = () => this.start(run, signal, observer?.output);
    if (!run.expensive || !this.options.capacity) return await start();
    const queue: { queuedAt: number | null; admittedAt: number | null } = { queuedAt: null, admittedAt: null };
    const result = await this.options.capacity.run(run.label, signal, start, {
      queued: at => { queue.queuedAt = at; observer?.queued(at); },
      admitted: at => { queue.admittedAt = at; observer?.admitted(at); },
      ...(observer?.skip ? { skip: observer.skip } : {}),
    });
    return queue.queuedAt === null || queue.admittedAt === null
      ? result
      : { ...result, queuedMs: Math.max(0, queue.admittedAt - queue.queuedAt) };
  }

  /** A run that fails or is stopped carries everything it printed on that failure, so its result can still show it. */
  private async start(run: WorkbenchShellRun, signal: AbortSignal, output?: CodexExecOutputListener): Promise<WorkbenchShellRunResult> {
    signal.throwIfAborted();
    const printed: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] };
    const capture: CodexExecOutputListener = (stream, chunk) => {
      printed[stream].push(chunk);
      output?.(stream, chunk);
    };
    try {
      if (run.kind === "approved") {
        return await (this.options.executeApproved ?? executeApprovedCommand)(run.request, signal, {
          environment: this.options.environment ?? process.env,
          onOutput: capture,
          ...(this.options.windowsJobRunner ? { windowsJobRunner: this.options.windowsJobRunner } : {}),
        });
      }
      return await this.options.executor.execute(run.request, signal, capture);
    } catch (error) {
      throw withWorkbenchShellPartialOutput(error, {
        stdout: Buffer.concat(printed.stdout).toString("utf8"),
        stderr: Buffer.concat(printed.stderr).toString("utf8"),
      });
    }
  }
}
