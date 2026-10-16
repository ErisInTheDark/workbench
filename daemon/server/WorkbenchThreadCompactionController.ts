/*
 * Exports:
 * - QueuedThreadMessage: one user message waiting behind a compaction.
 * - default WorkbenchThreadCompactionController: own canonical compaction admission, execution, failure settlement and the compaction queue.
 */
import { randomUUID } from "node:crypto";
import type WorkbenchProvider from "./WorkbenchProvider";
import type WorkbenchThreadAdmissionController from "./WorkbenchThreadAdmissionController";
import type { DaemonTranscriptRegistration } from "./daemon-runtime-objects";
import type { WorkbenchThreadMessage } from "workbench-shared/workbench/thread/thread-actions";
import type { WorkbenchMessageContext } from "workbench-shared/workbench/provider/provider-input";
import type { UserInput } from "workbench-shared/workbench/thread/workbench-thread-items";
import {
  WorkbenchItemIdSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema, type WorkbenchTurnId,
} from "workbench-shared/workbench/identity";

type CompactionProvider = {
  threads: Pick<WorkbenchProvider["threads"], "compact" | "latestTurn">;
};

export type QueuedThreadMessage = Pick<Extract<WorkbenchThreadMessage, { intent: "continue" | "newTurn" }>,
  "clientMessageId" | "input" | "intent" | "context">;

type HeldEntry = Extract<Parameters<DaemonTranscriptRegistration["record"]>[0][number], { kind: "steer" }>;

interface QueuedSlot {
  message: QueuedThreadMessage;
  /** The pending held steer once recorded; null while recording or after recording failed. */
  held: HeldEntry["entry"] | null;
  recording: Promise<void>;
}

/** Messages sent while a thread compacts; flushed as one message under `id` when compaction ends. */
interface CompactionQueue {
  id: string;
  turnId: Promise<WorkbenchTurnId>;
  slots: QueuedSlot[];
  deliver: ((message: QueuedThreadMessage) => Promise<unknown>) | null;
  closed: boolean;
}

type CompactionOutcome = "completed" | "failed" | "aborted";

const COMPACTION_FAILED_ERROR = "Context compaction failed, so this message was not sent.";

/** Held steer history stores text elements with explicit placeholders. */
function heldInput(input: QueuedThreadMessage["input"]): UserInput[] {
  return input.map(part => part.type === "text" ? {
    ...part,
    text_elements: part.text_elements.map(element => ({ byteRange: element.byteRange, placeholder: element.placeholder ?? null })),
  } : part);
}

function mergeContexts(messages: readonly QueuedThreadMessage[]): WorkbenchMessageContext | undefined {
  const first = messages[0]?.context;
  const activatedSkillPaths = [...new Set(messages.flatMap(message => message.context?.activatedSkillPaths ?? []))];
  const instructionInjections = Object.assign({}, ...messages.map(message => message.context?.instructionInjections ?? {}));
  if (!first && !activatedSkillPaths.length && !Object.keys(instructionInjections).length) return undefined;
  return {
    ...first,
    ...(activatedSkillPaths.length ? { activatedSkillPaths } : {}),
    ...(Object.keys(instructionInjections).length ? { instructionInjections } : {}),
  };
}

/** The agent receives everything queued as one message, in send order, under the first message's intent. */
function mergeQueuedMessages(clientMessageId: string, messages: readonly QueuedThreadMessage[]): QueuedThreadMessage {
  const context = mergeContexts(messages);
  return {
    clientMessageId,
    intent: messages[0]!.intent,
    input: messages.flatMap(message => message.input),
    ...(context ? { context } : {}),
  };
}

export default class WorkbenchThreadCompactionController {
  private readonly active = new Set<string>();
  private readonly queues = new Map<string, CompactionQueue>();
  private readonly flushes = new Set<Promise<void>>();

  constructor(
    private readonly admission: Pick<WorkbenchThreadAdmissionController, "run">,
    private readonly ports: {
      record: DaemonTranscriptRegistration["record"];
      setCompacting?(threadId: string, compacting: boolean): void;
      now(): number;
      itemId?(): string;
      warn?(message: string): void;
    },
  ) {}

  hasPendingWork() { return this.active.size > 0 || this.flushes.size > 0; }

  compact(threadId: string, provider: CompactionProvider, signal?: AbortSignal) {
    return this.exclusive(threadId, () => this.admission.run(
      threadId,
      () => this.execute(threadId, provider, signal),
    ));
  }

  compactInsideAdmission(threadId: string, provider: CompactionProvider, signal?: AbortSignal) {
    return this.exclusive(threadId, () => this.execute(threadId, provider, signal));
  }

  /**
   * Hold a message behind the thread's running compaction as a pending held steer; false when nothing compacts.
   * `deliver` sends the merged queue later, outside this compaction's admission.
   */
  async enqueue(threadId: string, message: QueuedThreadMessage, deliver: (message: QueuedThreadMessage) => Promise<unknown>) {
    const queue = this.queues.get(threadId);
    if (!queue || queue.closed) return false;
    queue.deliver ??= deliver;
    const dispatchSequence = queue.slots.length;
    const slot: QueuedSlot = { message, held: null, recording: Promise.resolve() };
    const recording = (async () => {
      const entry: HeldEntry["entry"] = {
        threadId: WorkbenchThreadIdSchema.parse(threadId),
        turnId: await queue.turnId,
        entryKey: `compaction:${message.clientMessageId}`,
        input: heldInput(message.input),
        status: "pending",
        attemptedAt: this.ports.now(),
        resolvedAt: null,
        requestId: null,
        canonicalItemId: null,
        // Delivery carries the queue's id, so every held copy hides once the merged message lands.
        clientUserMessageId: queue.id,
        dispatchSequence,
        error: null,
      };
      await this.ports.record([{ kind: "steer", entry, observedAt: this.ports.now() }], { source: "workbench" });
      slot.held = entry;
    })();
    slot.recording = recording.catch(() => {});
    queue.slots.push(slot);
    await recording;
    return true;
  }

  private async exclusive(threadId: string, operation: () => Promise<void>) {
    if (this.active.has(threadId)) throw new Error("This thread is already compacting.");
    this.active.add(threadId);
    try {
      await operation();
    } finally {
      this.active.delete(threadId);
    }
  }

  private async execute(threadId: string, provider: CompactionProvider, signal?: AbortSignal) {
    const turnId = Promise.withResolvers<WorkbenchTurnId>();
    turnId.promise.catch(() => {});
    const queue: CompactionQueue = { id: randomUUID(), turnId: turnId.promise, slots: [], deliver: null, closed: false };
    this.queues.set(threadId, queue);
    this.ports.setCompacting?.(threadId, true);
    let outcome: CompactionOutcome = "failed";
    try {
      signal?.throwIfAborted();
      const turn = await provider.threads.latestTurn(threadId);
      signal?.throwIfAborted();
      if (!turn) throw new Error("Compaction requires an existing turn.");
      const scope = {
        itemId: WorkbenchItemIdSchema.parse(this.ports.itemId?.() ?? randomUUID()),
        turnId: WorkbenchTurnIdSchema.parse(turn.id),
      };
      turnId.resolve(scope.turnId);
      const canonicalThreadId = WorkbenchThreadIdSchema.parse(threadId);
      await this.ports.record([{
        kind: "contextCompaction",
        itemId: scope.itemId,
        threadId: canonicalThreadId,
        turnId: scope.turnId,
        phase: "started",
        observedAt: this.ports.now(),
        reference: null,
      }], { source: "workbench" });
      try {
        await provider.threads.compact(threadId, { scope, signal });
      } catch (error) {
        await this.ports.record([{
          kind: "contextCompaction",
          itemId: scope.itemId,
          threadId: canonicalThreadId,
          turnId: scope.turnId,
          phase: "failed",
          observedAt: this.ports.now(),
          reference: null,
        }], { source: "workbench" });
        throw error;
      }
      outcome = "completed";
    } catch (error) {
      turnId.reject(error);
      if (signal?.aborted) outcome = "aborted";
      throw error;
    } finally {
      queue.closed = true;
      if (this.queues.get(threadId) === queue) this.queues.delete(threadId);
      this.ports.setCompacting?.(threadId, false);
      // Delivery re-enters message admission, which this compaction still holds; it runs detached.
      this.track(this.settleQueue(threadId, queue, outcome));
    }
  }

  private track(flush: Promise<void>) {
    this.flushes.add(flush);
    void flush.finally(() => { this.flushes.delete(flush); });
  }

  /** Completed compaction delivers the queue; failure and reload leave each message undelivered for resend. */
  private async settleQueue(threadId: string, queue: CompactionQueue, outcome: CompactionOutcome) {
    await Promise.all(queue.slots.map(slot => slot.recording));
    const held = queue.slots.flatMap(slot => slot.held ? [{ message: slot.message, entry: slot.held }] : []);
    if (!held.length) return;
    if (outcome !== "completed" || !queue.deliver) {
      await this.resolveHeld(threadId, held.map(({ entry }) => entry),
        outcome === "aborted" ? "interrupted" : "failed", COMPACTION_FAILED_ERROR);
      return;
    }
    try {
      await queue.deliver(mergeQueuedMessages(queue.id, held.map(({ message }) => message)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.resolveHeld(threadId, held.map(({ entry }) => entry), "failed", message.slice(0, 500) || "Message delivery failed.");
      return;
    }
    await this.resolveHeld(threadId, held.map(({ entry }) => entry), "dismissed", null);
  }

  private async resolveHeld(
    threadId: string,
    entries: readonly HeldEntry["entry"][],
    status: "dismissed" | "failed" | "interrupted",
    error: string | null,
  ) {
    const now = this.ports.now();
    try {
      await this.ports.record(entries.map(entry => ({
        kind: "steer" as const,
        entry: { ...entry, status, resolvedAt: now, error: status === "failed" ? error : null },
        observedAt: now,
      })), { source: "workbench" });
    } catch (recordError) {
      const message = recordError instanceof Error ? recordError.message : String(recordError);
      this.ports.warn?.(`Compaction queue for ${threadId.slice(0, 120)} could not record ${status}: ${message.slice(0, 300)}`);
    }
  }
}
