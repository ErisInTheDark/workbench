/*
 * Exports:
 * - WorkbenchShellRunnerOptions: the exec node's executor, expensive-command slots and direct-spawn ports.
 * - default WorkbenchShellRunner: run one prepared agent command where its process lives, outside every provider generation.
 */
import type CodexExecServer from "./CodexExecServer";
import executeApprovedCommand from "./WorkbenchApprovedCommandExecutor";
import type WorkbenchCommandCapacity from "./WorkbenchCommandCapacity";
import type { WorkbenchCommandQueueTicket } from "./WorkbenchCommandCapacity";
import type { WorkbenchShellRun, WorkbenchShellRunResult } from "./provider-execution";

export interface WorkbenchShellRunnerOptions {
  executor: Pick<CodexExecServer, "execute">;
  /** Machine-wide slots for expensive commands; absent means every command runs immediately. */
  capacity?: Pick<WorkbenchCommandCapacity, "run">;
  executeApproved?: typeof executeApprovedCommand;
  environment?: NodeJS.ProcessEnv;
}

export default class WorkbenchShellRunner {
  constructor(private readonly options: WorkbenchShellRunnerOptions) {}

  /**
   * Expensive commands wait for a shared slot before starting, so their own timeout measures only running time.
   * A command that waited reports its queue time as `queuedMs`.
   */
  async run(run: WorkbenchShellRun, signal: AbortSignal, ticket?: WorkbenchCommandQueueTicket): Promise<WorkbenchShellRunResult> {
    const start = () => this.start(run, signal);
    if (!run.expensive || !this.options.capacity) return await start();
    const queue: { queuedAt: number | null; admittedAt: number | null } = { queuedAt: null, admittedAt: null };
    const result = await this.options.capacity.run(run.label, signal, start, {
      queued: at => { queue.queuedAt = at; ticket?.queued(at); },
      admitted: at => { queue.admittedAt = at; ticket?.admitted(at); },
      ...(ticket?.skip ? { skip: ticket.skip } : {}),
    });
    return queue.queuedAt === null || queue.admittedAt === null
      ? result
      : { ...result, queuedMs: Math.max(0, queue.admittedAt - queue.queuedAt) };
  }

  private async start(run: WorkbenchShellRun, signal: AbortSignal): Promise<WorkbenchShellRunResult> {
    signal.throwIfAborted();
    if (run.kind === "approved") {
      return await (this.options.executeApproved ?? executeApprovedCommand)(run.request, signal, this.options.environment ?? process.env);
    }
    return await this.options.executor.execute(run.request, signal);
  }
}
