/*
 * Exports:
 * - ThreadAutoCompactEvidence: canonical activity and current-context measurement.
 * - ThreadAutoCompactTarget: observed thread identity for status publication.
 * - default WorkbenchThreadAutoCompactController: own observed eligibility and compact-before-message policy.
 */
import type { ThreadAutoCompactSettings } from "workbench-shared/workbench/settings/thread-auto-compact";
import type { WorkbenchHarness } from "workbench-shared/types";
import type WorkbenchProvider from "./WorkbenchProvider";
import type WorkbenchThreadAdmissionController from "./WorkbenchThreadAdmissionController";
import type WorkbenchThreadCompactionController from "./WorkbenchThreadCompactionController";
import { isThreadStatusActive } from "workbench-shared/workbench/thread/thread-runtime-state";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";

export interface ThreadAutoCompactEvidence {
  activityAt: number;
  contextTokens: number | null;
}

export interface ThreadAutoCompactTarget {
  harness: WorkbenchHarness;
  threadId: string;
}

interface ThreadAutoCompactRuntime {
  latestTurn: Pick<Turn, "id"> | null;
  status: string;
  turnLive: boolean;
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

export default class WorkbenchThreadAutoCompactController {
  private readonly lifetime = new AbortController();
  private readonly observed = new Map<string, ObservedThread>();
  private readonly refreshes = new Set<Promise<boolean>>();
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancel: (timer: unknown) => void;
  hasPendingWork() { return this.refreshes.size > 0; }
  constructor(
    private readonly admission: Pick<WorkbenchThreadAdmissionController, "run">,
    private readonly compaction: Pick<WorkbenchThreadCompactionController, "compactInsideAdmission">,
    private readonly ports: {
    readSettings(): Promise<ThreadAutoCompactSettings>;
    readEvidence(threadId: string): Promise<ThreadAutoCompactEvidence | null>;
    readRuntime(target: ThreadAutoCompactTarget): Promise<ThreadAutoCompactRuntime>;
    publish(target: ThreadAutoCompactTarget, willAutoCompact: boolean): void;
    schedule?(callback: () => void, delayMs: number): unknown;
    cancel?(timer: unknown): void;
    now(): number;
    warn(message: string): void;
  }) {
    this.schedule = ports.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel = ports.cancel ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  async observe(target: ThreadAutoCompactTarget) {
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
      return await this.trackRefresh(observed);
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

  async run<T>(
    threadId: string,
    provider: { threads: Pick<WorkbenchProvider["threads"], "read" | "latestTurn" | "isTurnLive" | "compact"> },
    admit: () => Promise<T>,
    options: { skipAutoCompact?: boolean } = {},
  ): Promise<T> {
    this.lifetime.signal.throwIfAborted();
    return await this.admission.run(threadId, async () => {
      const signal = this.lifetime.signal;
      signal.throwIfAborted();
      if (!options.skipAutoCompact && (await this.decide(threadId, provider)).willAutoCompact) {
        await this.compaction.compactInsideAdmission(threadId, provider, signal);
      }
      signal.throwIfAborted();
      const result = await admit();
      const observed = this.observed.get(threadId);
      if (observed) {
        try {
          await this.refresh(observed, provider);
        } catch (error) {
          if (!signal.aborted) this.warn(threadId, error);
        }
      }
      return result;
    });
  }

  beginRuntimeDrain() {
    if (!this.lifetime.signal.aborted) this.lifetime.abort(new Error("Auto-compaction admission is reloading."));
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
  ): Promise<ThreadAutoCompactDecision> {
    const signal = this.lifetime.signal;
    signal.throwIfAborted();
    const settings = await this.ports.readSettings();
    const evidence = settings.enabled ? await this.ports.readEvidence(threadId) : null;
    signal.throwIfAborted();
    if (!evidence || evidence.contextTokens === null || evidence.contextTokens < settings.tokenThreshold) {
      return { dueAt: null, willAutoCompact: false };
    }
    const dueAt = evidence.activityAt + settings.idleMinutes * 60_000;
    if (this.ports.now() < dueAt) return { dueAt, willAutoCompact: false };
    const target = this.observed.get(threadId)?.target;
    const runtime = provider
      ? await this.readProviderRuntime(threadId, provider)
      : target ? await this.ports.readRuntime(target) : null;
    signal.throwIfAborted();
    return {
      dueAt,
      willAutoCompact: Boolean(runtime?.latestTurn && !isThreadStatusActive(runtime.status) && !runtime.turnLive),
    };
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
  ) {
    this.clearTimer(observed);
    const revision = ++observed.revision;
    const decision = await this.decide(observed.target.threadId, provider);
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
  ) {
    const refresh = this.refresh(observed, provider);
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
