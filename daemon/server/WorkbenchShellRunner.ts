/*
 * Exports:
 * - WorkbenchShellRunnerOptions: the exec node's executor, expensive-command slots and direct-spawn ports.
 * - default WorkbenchShellRunner: run one prepared agent command where its process lives, outside every provider generation.
 */
import type CodexExecServer from "./CodexExecServer";
import executeApprovedCommand from "./WorkbenchApprovedCommandExecutor";
import type WorkbenchCommandCapacity from "./WorkbenchCommandCapacity";
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

  /** Expensive commands wait for a shared slot before starting, so their own timeout measures only running time. */
  async run(run: WorkbenchShellRun, signal: AbortSignal): Promise<WorkbenchShellRunResult> {
    const start = () => this.start(run, signal);
    return run.expensive && this.options.capacity ? await this.options.capacity.run(run.label, signal, start) : await start();
  }

  private async start(run: WorkbenchShellRun, signal: AbortSignal): Promise<WorkbenchShellRunResult> {
    signal.throwIfAborted();
    if (run.kind === "approved") {
      return await (this.options.executeApproved ?? executeApprovedCommand)(run.request, signal, this.options.environment ?? process.env);
    }
    return await this.options.executor.execute(run.request, signal);
  }
}
