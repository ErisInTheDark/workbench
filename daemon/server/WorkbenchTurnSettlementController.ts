/*
 * Exports:
 * - WorkbenchTurnSettlementOwners: provider liveness, canonical transcript, lifecycle publication and working-thread ports.
 * - default WorkbenchTurnSettlementController: settle turns whose provider runtime is gone, on stop and once per cold daemon start.
 */
import { ThreadReferenceSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchHarness } from "workbench-shared/types";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import type { WorkbenchProviderObservation } from "workbench-shared/workbench/provider/provider-observation";
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
  /** Threads whose saved lifecycle still says a turn is running. */
  listWorkingThreads(): Promise<string[]>;
  warn(message: string): void;
}

const bounded = (error: unknown) => (error instanceof Error ? error.message : String(error))
  .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 300);

export default class WorkbenchTurnSettlementController {
  private sweeping: Promise<void> | null = null;
  private retired = false;

  constructor(private readonly owners: WorkbenchTurnSettlementOwners) {}

  /**
   * Retirement stops the sweep before its next thread. It does not wait for the current one: a provider liveness
   * check can stall behind its own runtime, and reloads must not be held hostage by it.
   */
  async dispose() {
    this.retired = true;
  }

  /**
   * Settle a turn as interrupted when its provider no longer runs it. Providers that cannot answer keep their turns.
   * Settlement interrupts the turn's in-progress tool items, and the transcript turns its held steers undelivered.
   */
  async settleIfOrphaned(threadId: string, turnId: string) {
    const identity = await this.owners.identities.resolve({ threadId: ThreadReferenceSchema.parse(threadId) });
    const harness = identity?.bindings[0]?.harness;
    const key = installedProviderKeys.find(candidate => candidate === harness);
    if (!identity || !key) return false;
    const threads = this.owners.providers.get(key).threads;
    if (!threads.isTurnLive || await threads.isTurnLive(identity.threadId, turnId)) return false;
    const observations = await this.owners.transcripts.storedTurnSettlement(identity.threadId, turnId, Date.now() / 1_000);
    if (observations.length) await this.owners.transcript.record(observations, { source: "workbench" });
    await this.owners.observe(key, {
      projectId: identity.projectId, turnStarted: null, displayLabel: null,
      lifecycle: {
        threadId: WorkbenchThreadIdSchema.parse(identity.threadId),
        event: { kind: "turnCompleted", turnId: WorkbenchTurnIdSchema.parse(turnId), status: "interrupted" },
      },
    });
    return true;
  }

  /** Cold start only, once: a turn a previous daemon left running is settled unless its provider still runs it. */
  startColdSweep() {
    this.sweeping ??= this.sweep();
    return this.sweeping;
  }

  private async sweep() {
    let threadIds: string[];
    try {
      threadIds = await this.owners.listWorkingThreads();
    } catch (error) {
      this.owners.warn(`Orphaned turn sweep could not list working threads: ${bounded(error)}`);
      return;
    }
    for (const threadId of threadIds) {
      if (this.retired) return;
      try {
        const { thread } = await this.owners.transcripts.readPage({ threadId, cursor: null });
        const turn = thread.turns.at(-1);
        if (turn?.status !== "inProgress") continue;
        if (await this.settleIfOrphaned(threadId, turn.id)) {
          this.owners.warn(`Settled orphaned turn ${turn.id.slice(0, 8)} of thread ${threadId.slice(0, 8)} as interrupted.`);
        }
      } catch (error) {
        this.owners.warn(`Orphaned turn sweep failed for thread ${threadId.slice(0, 8)}: ${bounded(error)}`);
      }
    }
  }
}
