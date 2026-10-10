/*
 * Exports:
 * - WorkbenchProviderDispatcherOptions: shared message admission and post-admission hooks.
 * - default WorkbenchProviderDispatcher: obtain reload-safe provider handles with one process-wide steer-wait interruption path.
 */
import type WorkbenchProvider from "./WorkbenchProvider";
import type { WorkbenchProviderOperation } from "./WorkbenchProvider";
import type { WorkbenchProviderKey } from "workbench-shared/workbench/provider/provider-registrations";
import type { WorkbenchUnfinishedTurnTarget } from "workbench-shared/workbench/provider/provider-recovery";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchProviderHandle from "./WorkbenchProviderHandle";
import type { WorkbenchProviderHandleOptions } from "./WorkbenchProviderHandle";
import { getProcessWorkbenchAgentMcpRequestRegistry } from "./workbench-agent-mcp-request-registry";

function interruptSteerWaits(threadId: string, senderThreadId?: string) {
  getProcessWorkbenchAgentMcpRequestRegistry().interruptThreadWaits(
    WorkbenchThreadIdSchema.parse(threadId),
    senderThreadId ? "Workbench MCP wait was interrupted by an agent message." : undefined,
    senderThreadId ? ["message_wait"] : [],
  );
}

export type WorkbenchProviderDispatcherOptions = Partial<WorkbenchProviderHandleOptions>;

export default class WorkbenchProviderDispatcher {
  constructor(
    private readonly run: WorkbenchProviderOperation,
    private readonly options: WorkbenchProviderDispatcherOptions = {},
  ) {}

  get(key: WorkbenchProviderKey): WorkbenchProvider {
    return new WorkbenchProviderHandle(key, this.run, {
      interruptSteerWaits: this.options.interruptSteerWaits ?? interruptSteerWaits,
      messageAdmission: this.options.messageAdmission,
      onAgentMessageAdmitted: this.options.onAgentMessageAdmitted,
      onMessageAdmitted: this.options.onMessageAdmitted,
    });
  }

  hydratesUsage(key: WorkbenchProviderKey) {
    return new WorkbenchProviderHandle(key, this.run, {
      interruptSteerWaits: this.options.interruptSteerWaits ?? interruptSteerWaits,
    }).hydratesUsage();
  }

  continueUnfinished(key: WorkbenchProviderKey, target: WorkbenchUnfinishedTurnTarget) {
    return new WorkbenchProviderHandle(key, this.run, {
      interruptSteerWaits: this.options.interruptSteerWaits ?? interruptSteerWaits,
    }).continueUnfinishedTurn(target);
  }
}
