/*
 * Exports:
 * - WorkbenchProviderDispatcherOptions: shared message admission, instruction selection and post-admission hooks.
 * - default WorkbenchProviderDispatcher: obtain reload-safe provider handles with one process-wide steer-wait interruption path.
 */
import type WorkbenchProvider from "./WorkbenchProvider";
import type { WorkbenchProviderOperation } from "./WorkbenchProvider";
import type { WorkbenchProviderKey } from "workbench-shared/workbench/provider/provider-registrations";
import type { WorkbenchThreadMessage } from "workbench-shared/workbench/thread/thread-actions";
import type { WorkbenchThreadAdmissionTicket } from "../thread/WorkbenchThreadAdmissionController";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchProviderHandle from "./WorkbenchProviderHandle";
import type { WorkbenchProviderHandleOptions, WorkbenchProviderHiddenTurn } from "./WorkbenchProviderHandle";
import { getProcessWorkbenchAgentMcpRequestRegistry } from "../agent/workbench-agent-mcp-request-registry";

function interruptSteerWaits(threadId: string, senderThreadId?: string) {
  getProcessWorkbenchAgentMcpRequestRegistry().interruptForSteer(WorkbenchThreadIdSchema.parse(threadId), senderThreadId);
}

export type WorkbenchProviderDispatcherOptions = Partial<WorkbenchProviderHandleOptions>;

export default class WorkbenchProviderDispatcher {
  constructor(
    private readonly run: WorkbenchProviderOperation,
    private readonly options: WorkbenchProviderDispatcherOptions = {},
  ) {}

  private handle(key: WorkbenchProviderKey) {
    return new WorkbenchProviderHandle(key, this.run, {
      interruptSteerWaits: this.options.interruptSteerWaits ?? interruptSteerWaits,
      instructionSelection: this.options.instructionSelection,
      messageAdmission: this.options.messageAdmission,
      onAgentMessageAdmitted: this.options.onAgentMessageAdmitted,
      onMessageAdmitted: this.options.onMessageAdmitted,
    });
  }

  get(key: WorkbenchProviderKey): WorkbenchProvider {
    return this.handle(key);
  }

  hydratesUsage(key: WorkbenchProviderKey) {
    return this.handle(key).hydratesUsage();
  }

  admitHiddenTurn(key: WorkbenchProviderKey, turn: WorkbenchProviderHiddenTurn) {
    return this.handle(key).admitHiddenTurn(turn);
  }

  submitWithinAdmission(key: WorkbenchProviderKey, input: WorkbenchThreadMessage, admission: WorkbenchThreadAdmissionTicket) {
    return this.handle(key).submitWithinAdmission(input, admission);
  }
}
