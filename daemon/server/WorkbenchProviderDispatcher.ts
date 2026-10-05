/*
 * Exports:
 * - default WorkbenchProviderDispatcher: obtain reload-safe provider handles with one process-wide steer-wait interruption path.
 */
import type WorkbenchProvider from "./WorkbenchProvider";
import type { WorkbenchProviderOperation } from "./WorkbenchProvider";
import type { WorkbenchProviderKey } from "workbench-shared/workbench/provider/provider-registrations";
import type { WorkbenchUnfinishedTurnTarget } from "workbench-shared/workbench/provider/provider-recovery";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchProviderHandle from "./WorkbenchProviderHandle";
import { getProcessWorkbenchAgentMcpRequestRegistry } from "./workbench-agent-mcp-request-registry";
import type WorkbenchThreadAutoCompactController from "./WorkbenchThreadAutoCompactController";
import type { WorkbenchAgentMessage } from "workbench-shared/workbench/thread/thread-agent-message";

function interruptSteerWaits(threadId: string, senderThreadId?: string) {
  getProcessWorkbenchAgentMcpRequestRegistry().interruptThreadWaits(
    WorkbenchThreadIdSchema.parse(threadId),
    senderThreadId ? "Workbench MCP wait was interrupted by an agent message." : undefined,
    senderThreadId ? ["message_wait"] : [],
  );
}

export default class WorkbenchProviderDispatcher {
  constructor(
    private readonly run: WorkbenchProviderOperation,
    private readonly onSteerAdmitted: (threadId: string, senderThreadId?: string) => void = interruptSteerWaits,
    private readonly messageAdmission?: WorkbenchThreadAutoCompactController["run"],
    private readonly onAgentMessageAdmitted?: (threadId: string, message: WorkbenchAgentMessage) => Promise<void> | void,
  ) {}

  get(key: WorkbenchProviderKey): WorkbenchProvider {
    return new WorkbenchProviderHandle(key, this.run, this.onSteerAdmitted, this.messageAdmission, this.onAgentMessageAdmitted);
  }

  hydratesUsage(key: WorkbenchProviderKey) {
    return new WorkbenchProviderHandle(key, this.run, this.onSteerAdmitted).hydratesUsage();
  }

  continueUnfinished(key: WorkbenchProviderKey, target: WorkbenchUnfinishedTurnTarget) {
    return new WorkbenchProviderHandle(key, this.run, this.onSteerAdmitted).continueUnfinishedTurn(target);
  }
}
