/*
 * Exports:
 * - WorkbenchMessageWaitHandoff: data retained while message waits and undelivered mail re-enter replacement generations.
 * - WorkbenchMessageWaitOutcome: a selected sender's message, or an interruption by another sender's message.
 * - default WorkbenchMessageWaitController: own sender-filtered message readiness, undelivered mail, cancellation, and reload handoff.
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
  /** Another sender's message arrived; absent on states from older generations. */
  interrupted?: true;
}

export interface WorkbenchMessageWaitHandoff {
  readonly waits: Map<string, MessageWaitState>;
  /** Admitted messages the recipient's model has not seen yet, keyed by recipient thread; absent on older generations. */
  inbox?: Map<string, WorkbenchAgentMessage[]>;
}

export type WorkbenchMessageWaitOutcome =
  | { kind: "message"; message: WorkbenchAgentMessage }
  | { kind: "interrupted" };

function createInvocationCleanup(waits: WorkbenchMessageWaitHandoff["waits"], waitId: string) {
  // Isolate this retained callback's closure from the generation's controller and promise.
  return () => { waits.delete(waitId); };
}

function outcome(state: MessageWaitState): WorkbenchMessageWaitOutcome | null {
  if (state.received) return { kind: "message", message: state.received };
  return state.interrupted ? { kind: "interrupted" } : null;
}

function sameMessage(left: WorkbenchAgentMessage, right: WorkbenchAgentMessage) {
  return left.senderThreadId === right.senderThreadId && left.message.trim() === right.message.trim();
}

export default class WorkbenchMessageWaitController {
  private readonly handoff: WorkbenchMessageWaitHandoff;
  private readonly inbox: Map<string, WorkbenchAgentMessage[]>;
  private readonly lifetime = new AbortController();
  private readonly listeners = new Map<string, () => void>();

  constructor(handoff?: WorkbenchMessageWaitHandoff) {
    this.handoff = handoff ?? { waits: new Map() };
    this.inbox = this.handoff.inbox ??= new Map();
  }

  captureReloadState() { return this.handoff; }

  hasWait(waitId: string) { return this.handoff.waits.has(waitId); }

  /**
   * An admitted message wakes every unsettled wait that selects its sender. Otherwise it stays undelivered
   * mail and interrupts the recipient's other waits, because providers hold it until the waiting tool returns.
   */
  receive(threadId: string, message: WorkbenchAgentMessage) {
    const recipientWaits = [...this.handoff.waits].filter(([, state]) => (
      state.callerThreadId === threadId && !outcome(state)
    ));
    const selecting = recipientWaits.filter(([, state]) => state.senderThreadIds.some(id => id === message.senderThreadId));
    if (!selecting.length) {
      this.inbox.set(threadId, [...this.inbox.get(threadId) ?? [], { ...message }]);
    }
    for (const [waitId, state] of selecting.length ? selecting : recipientWaits) {
      if (selecting.length) state.received = { ...message };
      else state.interrupted = true;
      this.listeners.get(waitId)?.();
    }
  }

  /** The recipient's model has seen the message, so no later wait may return it. */
  delivered(threadId: string, message: WorkbenchAgentMessage) {
    const pending = this.inbox.get(threadId);
    const index = pending?.findIndex(candidate => sameMessage(candidate, message)) ?? -1;
    if (!pending || index < 0) return;
    const remaining = pending.filter((_, candidate) => candidate !== index);
    if (remaining.length) this.inbox.set(threadId, remaining);
    else this.inbox.delete(threadId);
  }

  private takeUndelivered(state: MessageWaitState) {
    const pending = this.inbox.get(state.callerThreadId);
    const index = pending?.findIndex(candidate => state.senderThreadIds.some(id => id === candidate.senderThreadId)) ?? -1;
    if (!pending || index < 0) return;
    state.received = pending[index]!;
    const remaining = pending.filter((_, candidate) => candidate !== index);
    if (remaining.length) this.inbox.set(state.callerThreadId, remaining);
    else this.inbox.delete(state.callerThreadId);
  }

  async wait(
    input: { waitId: string; callerThreadId: WorkbenchThreadId; senderThreadIds: readonly WorkbenchThreadId[] },
    signal: AbortSignal,
    invocationSignal = signal,
  ): Promise<WorkbenchMessageWaitOutcome> {
    invocationSignal.throwIfAborted();
    signal.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    if (this.listeners.has(input.waitId)) throw new Error("That message wait is already attached.");
    const waits = this.handoff.waits;
    const state = waits.get(input.waitId) ?? {
      callerThreadId: input.callerThreadId, senderThreadIds: input.senderThreadIds, received: null,
    };
    if (state.callerThreadId !== input.callerThreadId) throw new Error("That message wait belongs to another caller.");
    if (!outcome(state)) this.takeUndelivered(state);
    waits.set(input.waitId, state);
    const waitId = input.waitId;
    // Retained cleanup closes only shared data, never a retired controller or its listeners.
    const cancelInvocation = createInvocationCleanup(waits, waitId);
    invocationSignal.addEventListener("abort", cancelInvocation, { once: true });
    const generationSignal = AbortSignal.any([signal, this.lifetime.signal, invocationSignal]);
    let cancel: (() => void) | undefined;
    try {
      const ready = outcome(state);
      if (ready) return ready;
      return await new Promise<WorkbenchMessageWaitOutcome>((resolve, reject) => {
        cancel = () => { reject(generationSignal.reason); };
        this.listeners.set(waitId, () => {
          const settled = outcome(state);
          if (settled) resolve(settled);
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
