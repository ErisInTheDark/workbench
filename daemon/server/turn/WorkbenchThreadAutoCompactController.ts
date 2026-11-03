/*
 * Exports:
 * - ThreadAutoCompactEvidence: canonical activity and current-context measurement.
 * - ThreadAutoCompactTarget: observed thread identity for status publication.
 * - ThreadAutoCompactRuntime: latest turn, status and liveness a decision weighs.
 * - AutoCompactAdmissionOptions/AutoCompactDueError: a send's compaction policy and expectation, and the bounce when it expected none.
 * - QueuedMessageDelivery: admit one message directly, or inside the admission whose ticket it carries.
 * - default WorkbenchThreadAutoCompactController: own observed eligibility (singly or from batched facts; idle or stale-prefix due) and
 *   compact-before-message policy, including held questionnaire answers, user messages queued behind compaction, queues handed over by a
 *   retiring generation, and bouncing sends that expected no compaction.
 */
import type { ThreadAutoCompactSettings } from "workbench-shared/workbench/settings/thread-auto-compact";
import type { WorkbenchHarness } from "workbench-shared/types";
import type {
  WorkbenchThreadMessageResult, WorkbenchThreadMessageSubmitResult,
} from "workbench-shared/workbench/thread/thread-actions";
import type WorkbenchProvider from "../providers/WorkbenchProvider";
import type WorkbenchThreadAdmissionController from "../thread/WorkbenchThreadAdmissionController";
import { WorkbenchAdmissionDrainingError, type WorkbenchThreadAdmissionTicket } from "../thread/WorkbenchThreadAdmissionController";
import type WorkbenchThreadCompactionController from "./WorkbenchThreadCompactionController";
import type { CompactionQueueHandoff, QueuedThreadMessage } from "./WorkbenchThreadCompactionController";
import { hasThreadActiveFlag, isThreadStatusActive } from "workbench-shared/workbench/thread/thread-runtime-state";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";

export interface ThreadAutoCompactEvidence {
  activityAt: number;
  contextTokens: number | null;
}

export interface ThreadAutoCompactTarget {
  harness: WorkbenchHarness;
  threadId: string;
}

export interface ThreadAutoCompactRuntime {
  latestTurn: Pick<Turn, "id"> | null;
  status: string;
  turnLive: boolean;
}

/** Facts a caller already holds, so a decision needs no port reads. */
interface ThreadAutoCompactFacts {
  settings: ThreadAutoCompactSettings;
  evidence: ThreadAutoCompactEvidence | null;
  runtime: ThreadAutoCompactRuntime;
}

interface ThreadAutoCompactDecision {
  dueAt: number | null;
  willAutoCompact: boolean;
}

interface ObservedThread {
  revision: number;
  target: ThreadAutoCompactTarget;
  timer: unknown | null;
  willAutoCompact: boolean | null;
}

export interface AutoCompactAdmissionOptions {
  skipAutoCompact?: boolean;
  /** What the sender showed; false bounces a send that is due to compact. Absent compacts without asking, as agents do. */
  expectAutoCompact?: boolean;
}

/** A send expected no compaction but one is due; nothing was delivered, and the thread now reports it will compact. */
export class AutoCompactDueError extends Error {
  constructor() {
    super("Context compaction is due before this message; nothing was sent.");
    this.name = "AutoCompactDueError";
  }
}

export type QueuedMessageDelivery = (
  message: QueuedThreadMessage,
  options: { skipAutoCompact?: boolean; admission?: WorkbenchThreadAdmissionTicket },
) => Promise<WorkbenchThreadMessageResult>;

type AdmissionProvider = { threads: Pick<WorkbenchProvider["threads"], "read" | "latestTurn" | "isTurnLive" | "compact"> };

export default class WorkbenchThreadAutoCompactController {
  private readonly lifetime = new AbortController();
  private readonly observed = new Map<string, ObservedThread>();
  private readonly refreshes = new Set<Promise<boolean>>();
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancel: (timer: unknown) => void;
  hasPendingWork() { return this.refreshes.size > 0; }
  constructor(
    private readonly admission: Pick<WorkbenchThreadAdmissionController, "run" | "admits">,
    private readonly compaction: Pick<WorkbenchThreadCompactionController, "compactInsideAdmission" | "enqueue" | "adopt" | "retireStranded">,
    private readonly ports: {
    readSettings(): Promise<ThreadAutoCompactSettings>;
    readEvidence(threadId: string): Promise<ThreadAutoCompactEvidence | null>;
    readRuntime(target: ThreadAutoCompactTarget): Promise<ThreadAutoCompactRuntime>;
    publish(target: ThreadAutoCompactTarget, willAutoCompact: boolean): void;
    /** Exact: rebuilds when needed. Only sends pay for it. Absent: prefixes are never stale. */
    prefixStale?(threadId: string): Promise<boolean>;
    /** What the last exact check found; observation reads only this. */
    knownPrefixStale?(threadId: string): boolean;
    schedule?(callback: () => void, delayMs: number): unknown;
    cancel?(timer: unknown): void;
    now(): number;
    warn(message: string): void;
  }) {
    this.schedule = ports.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel = ports.cancel ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  async observe(target: ThreadAutoCompactTarget) {
    return await this.observeWith(target);
  }

  /** Observe many threads from facts the caller already read: one settings read, no per-thread port reads. */
  async observeMany(entries: ReadonlyArray<{ target: ThreadAutoCompactTarget; evidence: ThreadAutoCompactEvidence | null; runtime: ThreadAutoCompactRuntime }>) {
    this.lifetime.signal.throwIfAborted();
    if (!entries.length) return new Map<string, boolean>();
    const settings = await this.ports.readSettings();
    return new Map(await Promise.all(entries.map(async ({ evidence, runtime, target }) => (
      [target.threadId, await this.observeWith(target, { evidence, runtime, settings })] as const
    ))));
  }

  private async observeWith(target: ThreadAutoCompactTarget, facts?: ThreadAutoCompactFacts) {
    this.lifetime.signal.throwIfAborted();
    const current = this.observed.get(target.threadId);
    const observed = current ?? {
      revision: 0,
      target,
      timer: null,
      willAutoCompact: null,
    };
    observed.target = target;
    this.observed.set(target.threadId, observed);
    try {
      return await this.trackRefresh(observed, undefined, facts);
    } catch (error) {
      if (this.lifetime.signal.aborted) throw error;
      this.warn(target.threadId, error);
      return false;
    }
  }

  async refreshObserved(threadIds?: readonly string[]) {
    const selected = threadIds
      ? [...new Set(threadIds)].flatMap(threadId => {
          const observed = this.observed.get(threadId);
          return observed ? [observed] : [];
        })
      : [...this.observed.values()];
    await Promise.all(selected.map(async observed => {
      try {
        await this.trackRefresh(observed);
      } catch (error) {
        if (!this.lifetime.signal.aborted) this.warn(observed.target.threadId, error);
      }
    }));
  }

  /**
   * The thread's message admission. A ticket admits inside the lane its holder already owns: a compaction queue's
   * delivery would otherwise wait on its own compaction.
   */
  async run<T>(
    threadId: string,
    provider: AdmissionProvider,
    admit: () => Promise<T>,
    options: AutoCompactAdmissionOptions & { admission?: WorkbenchThreadAdmissionTicket } = {},
  ): Promise<T> {
    this.lifetime.signal.throwIfAborted();
    if (options.admission) {
      if (!this.admission.admits(threadId, options.admission)) {
        throw new Error("This admission ticket no longer holds the thread's message admission.");
      }
      return await admit();
    }
    return await this.admission.run(threadId, async ticket => {
      const signal = this.lifetime.signal;
      signal.throwIfAborted();
      await this.compaction.retireStranded(threadId);
      const compacts = !options.skipAutoCompact && (await this.decide(threadId, provider, undefined, true)).willAutoCompact;
      if (compacts && options.expectAutoCompact === false) {
        await this.refreshAfterAdmission(threadId, provider);
        throw new AutoCompactDueError();
      }
      const result = compacts
        ? await this.compaction.compactInsideAdmission(threadId, provider, ticket, {
          signal, then: async () => { signal.throwIfAborted(); return await admit(); },
        }) as T
        : await admit();
      await this.refreshAfterAdmission(threadId, provider);
      return result;
    });
  }

  /**
   * A user message joins a running compaction's queue, or starts a due compaction as that queue's first message;
   * either way the sender is released at once while compaction keeps admission. Otherwise it is delivered now.
   */
  async submit(
    threadId: string,
    provider: AdmissionProvider,
    message: QueuedThreadMessage,
    deliver: QueuedMessageDelivery,
    options: AutoCompactAdmissionOptions & { mark?: (phase: string) => void } = {},
  ): Promise<WorkbenchThreadMessageSubmitResult> {
    this.lifetime.signal.throwIfAborted();
    const mark = options.mark ?? (() => {});
    const deliverQueued = (merged: QueuedThreadMessage, ticket: WorkbenchThreadAdmissionTicket) => deliver(merged, { admission: ticket });
    const joinedQueue = await this.compaction.enqueue(threadId, message, deliverQueued);
    mark("compaction-queue");
    if (joinedQueue) return { kind: "queued" };
    if (options.skipAutoCompact) return await deliver(message, { skipAutoCompact: true });
    const queued = Promise.withResolvers<boolean | "due">();
    const compaction = this.admission.run(threadId, async ticket => {
      mark("admission");
      const signal = this.lifetime.signal;
      signal.throwIfAborted();
      await this.compaction.retireStranded(threadId);
      mark("stranded");
      const decision = await this.decide(threadId, provider, undefined, true);
      mark("decision");
      if (!decision.willAutoCompact) {
        queued.resolve(false);
        return;
      }
      if (options.expectAutoCompact === false) {
        await this.refreshAfterAdmission(threadId, provider);
        queued.resolve("due");
        return;
      }
      const compacting = this.compaction.compactInsideAdmission(threadId, provider, ticket, { signal });
      try {
        queued.resolve(await this.compaction.enqueue(threadId, message, deliverQueued));
      } catch (error) {
        queued.reject(error);
      }
      await compacting;
      await this.refreshAfterAdmission(threadId, provider);
    });
    // A failure after queueing is settled by the queue itself: delivered by another generation, or left undelivered.
    void compaction.catch(error => {
      queued.reject(error);
      if (!this.lifetime.signal.aborted && !(error instanceof WorkbenchAdmissionDrainingError)) this.warn(threadId, error);
    });
    const outcome = await queued.promise;
    if (outcome === "due") return { kind: "autoCompactDue" };
    if (outcome) return { kind: "queued" };
    return await deliver(message, {});
  }

  /**
   * A retiring generation's queue, always under its original queue id: it joins a running compaction, or in one
   * admission compacts first when still due and then is delivered.
   */
  async adopt(threadId: string, provider: AdmissionProvider, handoff: CompactionQueueHandoff, deliver: QueuedMessageDelivery) {
    this.lifetime.signal.throwIfAborted();
    const deliverQueued = (merged: QueuedThreadMessage, ticket: WorkbenchThreadAdmissionTicket) => deliver(merged, { admission: ticket });
    const waiting = [...handoff.messages];
    while (waiting.length && await this.compaction.enqueue(threadId, waiting[0]!, deliverQueued)) waiting.shift();
    if (!waiting.length) return;
    const remaining = { ...handoff, messages: waiting };
    await this.admission.run(threadId, async ticket => {
      const signal = this.lifetime.signal;
      signal.throwIfAborted();
      if (!remaining.compacted && (await this.decide(threadId, provider, undefined, true)).willAutoCompact) {
        // The adopted queue settles its own holds even when compaction fails, so the handoff itself succeeded.
        await this.compaction.compactInsideAdmission(threadId, provider, ticket, {
          signal, adopted: { handoff: remaining, deliver: deliverQueued },
        }).catch(error => { this.warn(threadId, error); });
      } else {
        await this.compaction.adopt(threadId, provider, ticket, remaining, deliverQueued);
      }
      await this.refreshAfterAdmission(threadId, provider);
    });
  }

  beginRuntimeDrain() {
    if (!this.lifetime.signal.aborted) this.lifetime.abort(new WorkbenchAdmissionDrainingError("Auto-compaction admission"));
    for (const observed of this.observed.values()) this.clearTimer(observed);
    this.observed.clear();
  }
  async dispose() {
    this.beginRuntimeDrain();
    await Promise.allSettled(this.refreshes);
  }

  private async decide(
    threadId: string,
    provider?: { threads: Pick<WorkbenchProvider["threads"], "read" | "latestTurn" | "isTurnLive"> },
    facts?: ThreadAutoCompactFacts,
    checkPrefix = false,
  ): Promise<ThreadAutoCompactDecision> {
    const signal = this.lifetime.signal;
    signal.throwIfAborted();
    const settings = facts?.settings ?? await this.ports.readSettings();
    const evidence = !settings.enabled ? null : facts ? facts.evidence : await this.ports.readEvidence(threadId);
    signal.throwIfAborted();
    if (!evidence || evidence.contextTokens === null || evidence.contextTokens < settings.tokenThreshold) {
      return { dueAt: null, willAutoCompact: false };
    }
    const idleDueAt = evidence.activityAt + settings.idleMinutes * 60_000;
    // A prefix that changed since the last build misses the provider's cache just like an expired one.
    const stale = this.ports.now() < idleDueAt
      && (checkPrefix ? await this.ports.prefixStale?.(threadId) ?? false : this.ports.knownPrefixStale?.(threadId) ?? false);
    signal.throwIfAborted();
    const dueAt = stale ? evidence.activityAt : idleDueAt;
    if (this.ports.now() < dueAt) return { dueAt, willAutoCompact: false };
    const target = this.observed.get(threadId)?.target;
    const runtime = facts ? facts.runtime : provider
      ? await this.readProviderRuntime(threadId, provider)
      : target ? await this.ports.readRuntime(target) : null;
    signal.throwIfAborted();
    // A held questionnaire keeps the thread waiting on input after its turn ended; only a live turn blocks compaction.
    const settled = runtime && (!isThreadStatusActive(runtime.status) || hasThreadActiveFlag(runtime.status, "waitingOnUserInput"));
    return {
      dueAt,
      willAutoCompact: Boolean(runtime?.latestTurn && settled && !runtime.turnLive),
    };
  }

  private async refreshAfterAdmission(
    threadId: string,
    provider: { threads: Pick<WorkbenchProvider["threads"], "read" | "latestTurn" | "isTurnLive"> },
  ) {
    const observed = this.observed.get(threadId);
    if (!observed) return;
    try {
      await this.refresh(observed, provider);
    } catch (error) {
      if (!this.lifetime.signal.aborted) this.warn(threadId, error);
    }
  }

  private async readProviderRuntime(
    threadId: string,
    provider: { threads: Pick<WorkbenchProvider["threads"], "read" | "latestTurn" | "isTurnLive"> },
  ): Promise<ThreadAutoCompactRuntime> {
    const thread = await provider.threads.read(threadId);
    const latestTurn = await provider.threads.latestTurn(threadId);
    const turnLive = latestTurn ? await provider.threads.isTurnLive(threadId, latestTurn.id) : false;
    return { latestTurn, status: thread.status, turnLive };
  }

  private async refresh(
    observed: ObservedThread,
    provider?: { threads: Pick<WorkbenchProvider["threads"], "read" | "latestTurn" | "isTurnLive"> },
    facts?: ThreadAutoCompactFacts,
  ) {
    this.clearTimer(observed);
    const revision = ++observed.revision;
    const decision = await this.decide(observed.target.threadId, provider, facts);
    if (this.lifetime.signal.aborted || this.observed.get(observed.target.threadId) !== observed
      || observed.revision !== revision) return observed.willAutoCompact ?? false;
    const previous = observed.willAutoCompact;
    observed.willAutoCompact = decision.willAutoCompact;
    if (previous !== null && previous !== decision.willAutoCompact) {
      this.ports.publish(observed.target, decision.willAutoCompact);
    }
    if (decision.dueAt !== null && decision.dueAt > this.ports.now()) {
      let timer: unknown;
      timer = this.schedule(() => {
        if (observed.timer !== timer) return;
        observed.timer = null;
        void this.trackRefresh(observed).catch(error => {
          if (!this.lifetime.signal.aborted) this.warn(observed.target.threadId, error);
        });
      }, decision.dueAt - this.ports.now());
      observed.timer = timer;
    }
    return decision.willAutoCompact;
  }

  private trackRefresh(
    observed: ObservedThread,
    provider?: { threads: Pick<WorkbenchProvider["threads"], "read" | "latestTurn" | "isTurnLive"> },
    facts?: ThreadAutoCompactFacts,
  ) {
    const refresh = this.refresh(observed, provider, facts);
    this.refreshes.add(refresh);
    void refresh.then(
      () => { this.refreshes.delete(refresh); },
      () => { this.refreshes.delete(refresh); },
    );
    return refresh;
  }

  private clearTimer(observed: ObservedThread) {
    if (observed.timer === null) return;
    this.cancel(observed.timer);
    observed.timer = null;
  }

  private warn(threadId: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.ports.warn(`Auto-compact status refresh failed for ${threadId.slice(0, 120)}: ${message.slice(0, 300)}`);
  }
}
