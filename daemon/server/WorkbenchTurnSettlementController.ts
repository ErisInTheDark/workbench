/*
 * Exports:
 * - WorkbenchTurnSettlementOwners: provider liveness, canonical transcript, lifecycle publication and thread-lifecycle listing ports.
 * - default WorkbenchTurnSettlementController: settle turns whose provider runtime is gone, on stop, when a newer turn starts, and once per cold daemon start, where it also repairs working lifecycles whose turn already ended.
 */
import { ThreadReferenceSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchHarness } from "workbench-shared/types";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import type { WorkbenchProviderObservation } from "workbench-shared/workbench/provider/provider-observation";
import { isWorkbenchThreadStatusProviderOwned, type WorkbenchThreadLifecycle } from "workbench-shared/workbench/thread/thread-state";
import type { DaemonTranscriptRegistration } from "./daemon-runtime-objects";
import type WorkbenchProviderDispatcher from "./WorkbenchProviderDispatcher";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import type WorkbenchTranscriptReader from "./WorkbenchTranscriptReader";

export interface WorkbenchTurnSettlementOwners {
  providers: Pick<WorkbenchProviderDispatcher, "get">;
  identities: Pick<WorkbenchThreadIdentityController, "resolve">;
  transcripts: Pick<WorkbenchTranscriptReader, "readPage" | "storedTurnSettlement">;
  transcript: Pick<DaemonTranscriptRegistration, "record">;
  observe(harness: WorkbenchHarness, facts: WorkbenchProviderObservation): Promise<unknown>;
  /** Every non-draft thread with its saved lifecycle. */
  listThreadLifecycles(): Promise<Array<{ threadId: string; lifecycle: WorkbenchThreadLifecycle }>>;
  warn(message: string): void;
}

const bounded = (error: unknown) => (error instanceof Error ? error.message : String(error))
  .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 300);

export default class WorkbenchTurnSettlementController {
  private sweeping: Promise<void> | null = null;
  private retired = false;

  constructor(private readonly owners: WorkbenchTurnSettlementOwners) {}

  /**
   * Retirement stops the sweep from settling anything further. It does not wait for pending checks: a provider
   * liveness check can stall behind its own runtime, and reloads must not be held hostage by it.
   */
  async dispose() {
    this.retired = true;
  }

  /**
   * Settle a turn as interrupted when its provider no longer runs it.
   * Settlement interrupts the turn's in-progress tool items, and the transcript turns its held steers undelivered.
   */
  async settleIfOrphaned(threadId: string, turnId: string) {
    const target = await this.resolve(threadId);
    if (!target) return false;
    if (await this.owners.providers.get(target.key).threads.isTurnLive(target.identity.threadId, turnId)) return false;
    return await this.settle(target, turnId);
  }

  /**
   * A thread runs one turn at a time, so a newer turn proves every earlier turn still marked running lost its
   * runtime, such as a restart while it waited on a questionnaire. No liveness check: providers answer per thread.
   */
  async settleSuperseded(threadId: string, turnId: string) {
    const target = await this.resolve(threadId);
    if (!target || this.retired) return;
    const { thread } = await this.owners.transcripts.readPage({ threadId: target.identity.threadId, cursor: null });
    const index = thread.turns.findIndex(turn => turn.id === turnId);
    for (const turn of thread.turns.slice(0, Math.max(0, index))) {
      if (turn.status === "inProgress") await this.settle(target, turn.id);
    }
  }

  private async settle(target: SettlementTarget, turnId: string) {
    if (this.retired) return false;
    const observations = await this.owners.transcripts.storedTurnSettlement(target.identity.threadId, turnId, Date.now() / 1_000);
    if (observations.length) await this.owners.transcript.record(observations, { source: "workbench" });
    await this.publishCompleted(target, turnId, "interrupted");
    return true;
  }

  /** Cold start only, once: a turn a previous daemon left running is settled unless its provider still runs it. */
  startColdSweep() {
    this.sweeping ??= this.sweep();
    return this.sweeping;
  }

  private async resolve(threadId: string) {
    const identity = await this.owners.identities.resolve({ threadId: ThreadReferenceSchema.parse(threadId) });
    const harness = identity?.bindings[0]?.harness;
    const key = installedProviderKeys.find(candidate => candidate === harness);
    return identity && key ? { identity, key } : null;
  }

  private async publishCompleted(
    { identity, key }: SettlementTarget,
    turnId: string,
    status: "completed" | "interrupted" | "failed",
  ) {
    await this.owners.observe(key, {
      projectId: identity.projectId, turnStarted: null, displayLabel: null,
      lifecycle: {
        threadId: WorkbenchThreadIdSchema.parse(identity.threadId),
        event: { kind: "turnCompleted", turnId: WorkbenchTurnIdSchema.parse(turnId), status },
      },
    });
  }

  private async sweep() {
    let threads: Array<{ threadId: string; lifecycle: WorkbenchThreadLifecycle }>;
    try {
      // A questionnaire wait is provider-owned too: its turn can die with the daemon while the question survives.
      threads = (await this.owners.listThreadLifecycles())
        .filter(({ lifecycle }) => isWorkbenchThreadStatusProviderOwned(lifecycle));
    } catch (error) {
      this.owners.warn(`Orphaned turn sweep could not list working threads: ${bounded(error)}`);
      return;
    }
    if (!threads.length) return;
    // A stalled provider check can keep the summary from ever printing, so the start is logged on its own.
    this.owners.warn(`Orphaned turn sweep checking ${threads.length} working thread(s).`);
    // Threads are independent: one provider's stalled liveness check must not hold the others back.
    const outcomes = await Promise.all(threads.map(({ threadId, lifecycle }) => this.sweepThread(threadId, lifecycle)));
    const count = (outcome: SweepOutcome) => outcomes.filter(candidate => candidate === outcome).length;
    this.owners.warn(`Orphaned turn sweep finished: ${count("settled")} settled, ${count("republished")} ended turn(s) republished, `
      + `${count("live")} still running, ${count("failed")} failed.`);
  }

  private async sweepThread(threadId: string, lifecycle: WorkbenchThreadLifecycle): Promise<SweepOutcome> {
    try {
      const { thread } = await this.owners.transcripts.readPage({ threadId, cursor: null });
      const turn = thread.turns.at(-1);
      if (!turn || this.retired) return "skipped";
      await this.settleSuperseded(threadId, turn.id);
      if (turn.status === "inProgress") {
        if (!await this.settleIfOrphaned(threadId, turn.id)) return this.retired ? "skipped" : "live";
        this.owners.warn(`Settled orphaned turn ${turn.id.slice(0, 8)} of thread ${threadId.slice(0, 8)} as interrupted.`);
        return "settled";
      }
      // A question outlives its ended turn; only a working lifecycle can be stale about a turn that already ended.
      if (lifecycle.kind !== "working") return "skipped";
      // The turn already ended, but its lifecycle never heard. The reducer ignores this unless it is the lifecycle's own turn.
      const target = await this.resolve(threadId);
      if (!target || this.retired) return "skipped";
      await this.publishCompleted(target, turn.id, turn.status);
      return "republished";
    } catch (error) {
      this.owners.warn(`Orphaned turn sweep failed for thread ${threadId.slice(0, 8)}: ${bounded(error)}`);
      return "failed";
    }
  }
}

type SweepOutcome = "settled" | "republished" | "live" | "skipped" | "failed";
type SettlementTarget = NonNullable<Awaited<ReturnType<WorkbenchTurnSettlementController["resolve"]>>>;
