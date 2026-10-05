/*
 * Exports:
 * - WorkbenchMessageWaitHandoff: data retained while message waits re-enter replacement generations.
 * - default WorkbenchMessageWaitController: own sender-filtered message readiness, cancellation, and reload handoff.
 */
import type { WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type { WorkbenchAgentMessage } from "workbench-shared/workbench/thread/thread-agent-message";
import {
  createWorkbenchAgentMcpRuntimeReloadInterruption,
  isWorkbenchAgentMcpRuntimeReloadInterruption,
} from "./lib/workbench/commands/workbench-agent-command-definition";

interface MessageWaitState {
  callerThreadId: WorkbenchThreadId;
  senderThreadIds: readonly WorkbenchThreadId[];
  received: WorkbenchAgentMessage | null;
}

export interface WorkbenchMessageWaitHandoff {
  readonly waits: Map<string, MessageWaitState>;
}

function createInvocationCleanup(waits: WorkbenchMessageWaitHandoff["waits"], waitId: string) {
  // Isolate this retained callback's closure from the generation's controller and promise.
  return () => { waits.delete(waitId); };
}

export default class WorkbenchMessageWaitController {
  private readonly handoff: WorkbenchMessageWaitHandoff;
  private readonly lifetime = new AbortController();
  private readonly listeners = new Map<string, () => void>();

  constructor(handoff?: WorkbenchMessageWaitHandoff) {
    this.handoff = handoff ?? { waits: new Map() };
  }

  captureReloadState() { return this.handoff; }

  hasWait(waitId: string) { return this.handoff.waits.has(waitId); }

  receive(threadId: string, message: WorkbenchAgentMessage) {
    for (const [waitId, state] of this.handoff.waits) {
      if (state.received || state.callerThreadId !== threadId
        || !state.senderThreadIds.some(id => id === message.senderThreadId)) continue;
      state.received = { ...message };
      this.listeners.get(waitId)?.();
    }
  }

  async wait(
    input: { waitId: string; callerThreadId: WorkbenchThreadId; senderThreadIds: readonly WorkbenchThreadId[] },
    signal: AbortSignal,
    invocationSignal = signal,
  ): Promise<WorkbenchAgentMessage> {
    invocationSignal.throwIfAborted();
    signal.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    if (this.listeners.has(input.waitId)) throw new Error("That message wait is already attached.");
    const waits = this.handoff.waits;
    const state = waits.get(input.waitId) ?? {
      callerThreadId: input.callerThreadId, senderThreadIds: input.senderThreadIds, received: null,
    };
    if (state.callerThreadId !== input.callerThreadId) throw new Error("That message wait belongs to another caller.");
    waits.set(input.waitId, state);
    const waitId = input.waitId;
    // Retained cleanup closes only shared data, never a retired controller or its listeners.
    const cancelInvocation = createInvocationCleanup(waits, waitId);
    invocationSignal.addEventListener("abort", cancelInvocation, { once: true });
    const generationSignal = AbortSignal.any([signal, this.lifetime.signal, invocationSignal]);
    let cancel: (() => void) | undefined;
    try {
      if (state.received) return state.received;
      return await new Promise<WorkbenchAgentMessage>((resolve, reject) => {
        cancel = () => { reject(generationSignal.reason); };
        this.listeners.set(waitId, () => {
          if (state.received) resolve(state.received);
        });
        generationSignal.addEventListener("abort", cancel, { once: true });
        // No await between installing listeners and checking readiness.
        if (generationSignal.aborted) cancel();
      });
    } finally {
      if (cancel) generationSignal.removeEventListener("abort", cancel);
      this.listeners.delete(waitId);
      const reloading = generationSignal.aborted
        && isWorkbenchAgentMcpRuntimeReloadInterruption(generationSignal.reason)
        && !invocationSignal.aborted;
      if (!reloading) {
        invocationSignal.removeEventListener("abort", cancelInvocation);
        waits.delete(waitId);
      }
    }
  }

  dispose() {
    this.lifetime.abort(createWorkbenchAgentMcpRuntimeReloadInterruption());
    this.listeners.clear();
  }
}
