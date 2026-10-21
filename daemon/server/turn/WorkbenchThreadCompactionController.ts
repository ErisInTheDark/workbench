/*
 * Exports:
 * - QueuedThreadMessage: one user message waiting behind a compaction.
 * - CompactionQueueDelivery: admit one merged queued message inside the admission its compaction holds.
 * - CompactionQueueHandoff: queued messages a retiring generation hands to the current one.
 * - heldSteerInput: convert message input to held-steer history input with explicit placeholders.
 * - default WorkbenchThreadCompactionController: own canonical compaction admission, execution, failure settlement and the
 *   compaction queue: in-admission delivery, generation handoff and stranded-hold retirement.
 */
import { randomUUID } from "node:crypto";
import type WorkbenchProvider from "../providers/WorkbenchProvider";
import type WorkbenchThreadAdmissionController from "../thread/WorkbenchThreadAdmissionController";
import { WorkbenchAdmissionDrainingError, type WorkbenchThreadAdmissionTicket } from "../thread/WorkbenchThreadAdmissionController";
import type { DaemonTranscriptRegistration } from "../daemon-runtime-objects";
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

export type CompactionQueueDelivery = (message: QueuedThreadMessage, ticket: WorkbenchThreadAdmissionTicket) => Promise<unknown>;

export interface CompactionQueueHandoff {
  queueId: string;
  messages: QueuedThreadMessage[];
  /** The retiring generation finished native compaction, so the adopter must not compact again for these messages. */
  compacted: boolean;
}

type HeldEntry = Extract<Parameters<DaemonTranscriptRegistration["record"]>[0][number], { kind: "steer" }>;

interface QueuedSlot {
  message: QueuedThreadMessage;
  /** The pending held steer once recorded; null while recording or after recording failed. */
  held: HeldEntry["entry"] | null;
  recording: Promise<void>;
}

/** Messages held for one thread's compaction; delivered as one message under `id` before its admission ends. */
interface CompactionQueue {
  id: string;
  turnId: Promise<WorkbenchTurnId>;
  slots: QueuedSlot[];
  deliver: CompactionQueueDelivery | null;
  closed: boolean;
}

type CompactionOutcome = "completed" | "failed" | "aborted";

interface QueueRun<T> {
  /** Run native compaction first; false only for a handed-off queue whose compaction already finished. */
  native: boolean;
  signal?: AbortSignal;
  /** The admission that triggered compaction; it runs after compaction and before the queue, in send order. */
  then?: () => Promise<T>;
  adopted?: { handoff: CompactionQueueHandoff; deliver: CompactionQueueDelivery };
}

const COMPACTION_FAILED_ERROR = "Context compaction failed, so this message was not sent.";

/** Held steer history stores text elements with explicit placeholders. */
export function heldSteerInput(input: QueuedThreadMessage["input"]): UserInput[] {
  return input.map(part => part.type === "text" ? {
    ...part,
    text_elements: part.text_elements.map(element => ({ byteRange: element.byteRange, placeholder: element.placeholder ?? null })),
  } : part);
}

/** Admission activates the skills the merged input names, so only instruction choices merge here. */
function mergeContexts(messages: readonly QueuedThreadMessage[]): WorkbenchMessageContext | undefined {
  const first = messages[0]?.context;
  const instructionInjections = Object.assign({}, ...messages.map(message => message.context?.instructionInjections ?? {}));
  if (!first && !Object.keys(instructionInjections).length) return undefined;
  const { activatedSkillPaths: _named, ...selection } = first ?? {};
  return {
    ...selection,
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

function errorText(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export default class WorkbenchThreadCompactionController {
  private readonly active = new Set<string>();
  /** Queues this generation owns, from compaction start until their messages are delivered, failed or handed off. */
  private readonly queues = new Map<string, CompactionQueue>();
  private retiring = false;

  constructor(
    private readonly admission: Pick<WorkbenchThreadAdmissionController, "run">,
    private readonly ports: {
      record: DaemonTranscriptRegistration["record"];
      setCompacting?(threadId: string, compacting: boolean): void;
      now(): number;
      itemId?(): string;
      warn?(message: string): void;
      /** Give queued messages to the current generation's admission; rejects when none can take them. */
      handoff?(threadId: string, handoff: CompactionQueueHandoff): Promise<void>;
      /** Threads holding pending compaction-queue holds attempted before `before`. */
      readStrandedThreadIds?(before: number): Promise<readonly string[]>;
    },
  ) {}

  hasPendingWork() { return this.active.size > 0 || this.queues.size > 0; }

  /** A retiring generation hands its queues to the current one instead of delivering into its own drained admission. */
  beginRuntimeDrain() { this.retiring = true; }

  compact(threadId: string, provider: CompactionProvider, signal?: AbortSignal) {
    return this.exclusive(threadId, () => this.admission.run(
      threadId,
      ticket => this.runQueue(threadId, provider, ticket, { native: true, signal }),
    ));
  }

  /** Compact inside the caller's admission, run `then`, and deliver what queued before the admission ends. */
  compactInsideAdmission<T = void>(
    threadId: string,
    provider: CompactionProvider,
    ticket: WorkbenchThreadAdmissionTicket,
    options: Omit<QueueRun<T>, "native"> = {},
  ) {
    return this.exclusive(threadId, () => this.runQueue(threadId, provider, ticket, { ...options, native: true }));
  }

  /** Deliver a handed-off queue whose compaction already finished, inside the caller's admission. */
  async adopt(
    threadId: string,
    provider: CompactionProvider,
    ticket: WorkbenchThreadAdmissionTicket,
    handoff: CompactionQueueHandoff,
    deliver: CompactionQueueDelivery,
  ) {
    await this.runQueue(threadId, provider, ticket, { native: false, adopted: { handoff, deliver } });
  }

  /**
   * Hold a message behind the thread's running compaction as a pending held steer; false when nothing compacts.
   * `deliver` admits the merged queue inside that compaction's admission.
   */
  async enqueue(threadId: string, message: QueuedThreadMessage, deliver: CompactionQueueDelivery) {
    const queue = this.queues.get(threadId);
    if (!queue || queue.closed) return false;
    await this.hold(threadId, queue, message, deliver);
    return true;
  }

  /** Compaction holds nobody in this generation owns become undelivered, so none waits forever. */
  async retireStranded(threadId: string) {
    if (this.queues.has(threadId)) return;
    await this.retireBefore(threadId, this.ports.now());
  }

  /** A starting generation owns no earlier queue, so every compaction hold from before `before` it does not own is stranded. */
  async retireStrandedBefore(before: number) {
    let threadIds: readonly string[];
    try {
      threadIds = await this.ports.readStrandedThreadIds?.(before) ?? [];
    } catch (error) {
      this.ports.warn?.(`Stranded compaction hold sweep could not list threads: ${errorText(error)}`);
      return;
    }
    for (const threadId of threadIds) {
      if (!this.queues.has(threadId)) await this.retireBefore(threadId, before);
    }
  }

  /** A safety net: failing to write it never blocks the admission that runs it. */
  private async retireBefore(threadId: string, before: number) {
    try {
      await this.ports.record([{
        kind: "abandonedHolds", scope: "compactionQueue",
        threadId: WorkbenchThreadIdSchema.parse(threadId), before, endedAt: before,
      }], { source: "workbench" });
    } catch (error) {
      this.warn(threadId, `could not retire stranded holds: ${errorText(error)}`);
    }
  }

  private hold(threadId: string, queue: CompactionQueue, message: QueuedThreadMessage, deliver: CompactionQueueDelivery) {
    queue.deliver ??= deliver;
    const dispatchSequence = queue.slots.length;
    const slot: QueuedSlot = { message, held: null, recording: Promise.resolve() };
    const recording = (async () => {
      const entry: HeldEntry["entry"] = {
        threadId: WorkbenchThreadIdSchema.parse(threadId),
        turnId: await queue.turnId,
        entryKey: `compaction:${message.clientMessageId}`,
        input: heldSteerInput(message.input),
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
    return recording;
  }

  private async exclusive<T>(threadId: string, operation: () => Promise<T>) {
    if (this.active.has(threadId)) throw new Error("This thread is already compacting.");
    this.active.add(threadId);
    try {
      return await operation();
    } finally {
      this.active.delete(threadId);
    }
  }

  private async runQueue<T>(
    threadId: string,
    provider: CompactionProvider,
    ticket: WorkbenchThreadAdmissionTicket,
    options: QueueRun<T>,
  ): Promise<T | undefined> {
    const { native, signal, adopted } = options;
    const before = this.ports.now();
    const turnId = Promise.withResolvers<WorkbenchTurnId>();
    turnId.promise.catch(() => {});
    const queue: CompactionQueue = {
      id: adopted?.handoff.queueId ?? randomUUID(), turnId: turnId.promise, slots: [], deliver: null, closed: false,
    };
    this.queues.set(threadId, queue);
    for (const message of adopted?.handoff.messages ?? []) void this.hold(threadId, queue, message, adopted!.deliver).catch(() => {});
    if (native) this.ports.setCompacting?.(threadId, true);
    let outcome: CompactionOutcome = "failed";
    let failure: unknown = null;
    try {
      // A handed-off queue's own holds are older than this run; everything else left pending has no owner.
      if (!adopted) await this.retireBefore(threadId, before);
      signal?.throwIfAborted();
      const turn = await provider.threads.latestTurn(threadId);
      signal?.throwIfAborted();
      if (!turn) throw new Error("Compaction requires an existing turn.");
      turnId.resolve(WorkbenchTurnIdSchema.parse(turn.id));
      if (native) await this.compactNative(threadId, provider, WorkbenchTurnIdSchema.parse(turn.id), signal);
      outcome = "completed";
    } catch (error) {
      turnId.reject(error);
      failure = error;
      outcome = signal?.aborted || this.retiring || error instanceof WorkbenchAdmissionDrainingError ? "aborted" : "failed";
    }
    queue.closed = true;
    if (native) this.ports.setCompacting?.(threadId, false);
    let result: T | undefined;
    try {
      if (!failure && options.then) result = await options.then();
    } finally {
      try {
        await this.settle(threadId, queue, outcome, ticket);
      } finally {
        if (this.queues.get(threadId) === queue) this.queues.delete(threadId);
      }
    }
    if (failure) throw failure;
    return result;
  }

  private async compactNative(threadId: string, provider: CompactionProvider, turnId: WorkbenchTurnId, signal?: AbortSignal) {
    const scope = { itemId: WorkbenchItemIdSchema.parse(this.ports.itemId?.() ?? randomUUID()), turnId };
    const canonicalThreadId = WorkbenchThreadIdSchema.parse(threadId);
    const marker = (phase: "started" | "failed") => this.ports.record([{
      kind: "contextCompaction", itemId: scope.itemId, threadId: canonicalThreadId, turnId,
      phase, observedAt: this.ports.now(), reference: null,
    }], { source: "workbench" });
    await marker("started");
    try {
      await provider.threads.compact(threadId, { scope, signal });
    } catch (error) {
      await marker("failed");
      throw error;
    }
  }

  /** Completed compaction delivers the queue in its own admission; failure leaves it undelivered; retirement hands it off. */
  private async settle(threadId: string, queue: CompactionQueue, outcome: CompactionOutcome, ticket: WorkbenchThreadAdmissionTicket) {
    await Promise.all(queue.slots.map(slot => slot.recording));
    const lost = queue.slots.filter(slot => !slot.held).length;
    if (lost) this.warn(threadId, `${lost} queued message(s) could not be held; their senders were refused`);
    const held = queue.slots.flatMap(slot => slot.held ? [{ message: slot.message, entry: slot.held }] : []);
    if (!held.length) return;
    const entries = held.map(({ entry }) => entry);
    const messages = held.map(({ message }) => message);
    if (outcome === "failed") {
      await this.resolveHeld(threadId, entries, "failed", COMPACTION_FAILED_ERROR);
      return;
    }
    if (outcome === "completed" && !this.retiring) {
      let failure: unknown = null;
      try {
        if (!queue.deliver) throw new Error("Queued message delivery is unavailable.");
        await queue.deliver(mergeQueuedMessages(queue.id, messages), ticket);
      } catch (error) {
        failure = error;
      }
      if (!failure) {
        await this.resolveHeld(threadId, entries, "dismissed", null);
        return;
      }
      if (!(failure instanceof WorkbenchAdmissionDrainingError) && !this.retiring) {
        await this.resolveHeld(threadId, entries, "failed", errorText(failure) || "Message delivery failed.");
        return;
      }
    }
    this.handOff(threadId, entries, { queueId: queue.id, messages, compacted: outcome === "completed" });
  }

  /** The current generation adopts the queue; only when nothing can is it left undelivered for resend. */
  private handOff(threadId: string, entries: readonly HeldEntry["entry"][], handoff: CompactionQueueHandoff) {
    const adopted = this.ports.handoff?.(threadId, handoff)
      ?? Promise.reject(new Error("No current admission can adopt this compaction queue."));
    void adopted.catch(async (error: unknown) => {
      this.warn(threadId, `could not hand its queue to the current generation: ${errorText(error)}`);
      await this.resolveHeld(threadId, entries, "interrupted", null);
    });
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
      // The queue is released after settlement, so the thread's next admission retires holds this left pending.
      this.warn(threadId, `could not record ${status}: ${errorText(recordError)}`);
    }
  }

  private warn(threadId: string, message: string) {
    this.ports.warn?.(`Compaction queue for ${threadId.slice(0, 120)} ${message.slice(0, 400)}`);
  }
}
