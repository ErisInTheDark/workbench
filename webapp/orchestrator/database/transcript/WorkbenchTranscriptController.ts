/*
 * WorkbenchTranscriptController: owns transcript readiness, recording, reads, active subscriptions, and disposal above the database worker. Keywords: transcript, controller, lifecycle.
 */
import type WorkbenchDatabaseController from "../WorkbenchDatabaseController.ts";
import WorkbenchTranscriptCaptureGapController from "./WorkbenchTranscriptCaptureGapController.ts";
import WorkbenchTranscriptRecorder from "./WorkbenchTranscriptRecorder.ts";
import WorkbenchTranscriptSubscriptionController, {
  type WorkbenchTranscriptSubscription,
} from "./WorkbenchTranscriptSubscriptionController.ts";
import type {
  WorkbenchTranscriptObservation,
  WorkbenchTranscriptReadRequest,
  WorkbenchTranscriptRecordingContext,
  WorkbenchTranscriptSettlement,
} from "./workbench-transcript-types.ts";

function observationIdentity(observations: readonly WorkbenchTranscriptObservation[]) {
  const threadIds = new Set<string>();
  const turnIds = new Set<string>();
  for (const observation of observations) {
    if (observation.kind === "canonicalWindow") {
      threadIds.add(observation.threadId);
      for (const turnId of observation.materializedTurnIds) turnIds.add(turnId);
      continue;
    }
    if (observation.kind === "questionnaire" || observation.kind === "steer") {
      threadIds.add(observation.entry.threadId);
      if (observation.entry.turnId) turnIds.add(observation.entry.turnId);
      continue;
    }
    if (observation.kind === "browse") {
      threadIds.add(observation.entry.threadId);
      turnIds.add(observation.entry.turnId);
      continue;
    }
    if (observation.threadId) threadIds.add(observation.threadId);
    if ("turnId" in observation && observation.turnId) turnIds.add(observation.turnId);
  }
  if (threadIds.size !== 1) {
    throw new Error("One SQLite transcript settlement failure must belong to exactly one thread.");
  }
  return {
    threadId: [...threadIds][0]!,
    turnId: turnIds.size === 1 ? [...turnIds][0]! : null,
  };
}

export default class WorkbenchTranscriptController {
  readonly #captureGaps: WorkbenchTranscriptCaptureGapController;
  readonly #database: Pick<
    WorkbenchDatabaseController,
    "failure" | "readTranscript" | "settleTranscript" | "start"
  > & Partial<Pick<WorkbenchDatabaseController, "readTranscriptMaterializedTurnIds">>;
  readonly #recorder: WorkbenchTranscriptRecorder;
  readonly #subscriptions: WorkbenchTranscriptSubscriptionController;
  #disposed = false;

  constructor(
    database: Pick<
      WorkbenchDatabaseController,
      "failure" | "readTranscript" | "settleTranscript" | "start"
    > & Partial<Pick<WorkbenchDatabaseController, "readTranscriptMaterializedTurnIds">>,
    captureGaps: WorkbenchTranscriptCaptureGapController,
  ) {
    this.#database = database;
    this.#captureGaps = captureGaps;
    this.#recorder = new WorkbenchTranscriptRecorder(database);
    this.#subscriptions = new WorkbenchTranscriptSubscriptionController((request) => this.read(request));
  }

  get failure() {
    return this.#database.failure;
  }

  get cutoverFailure() {
    return this.#captureGaps.cutoverFailure;
  }

  get pendingRecoveryThreadIds() {
    return this.#captureGaps.pendingRecoveryThreadIds;
  }

  assertReady() {
    this.#assertActive();
    if (this.#database.failure) throw this.#database.failure;
  }

  assertCutoverReady() {
    this.assertReady();
    this.#captureGaps.assertCutoverReady();
  }

  async start() {
    this.#assertActive();
    await this.#captureGaps.start();
    await this.#database.start();
  }

  async record(
    observations: readonly WorkbenchTranscriptObservation[],
    context: WorkbenchTranscriptRecordingContext,
  ) {
    this.#assertActive();
    if (observations.length === 0) return { changedThreadIds: [] };
    const identity = observationIdentity(observations);
    if (context.source === "compatibility" && this.#captureGaps.hasGap(identity.threadId)) {
      throw new Error(
        `SQLite transcript compatibility import is disabled for gapped thread ${identity.threadId}.`,
      );
    }
    if (context.recoveryBoundary) {
      if (context.source !== "provider") {
        throw new Error("SQLite transcript recovery must use provider-owned observations.");
      }
      const marker = this.#captureGaps.requireRecovery(identity.threadId);
      const recoveredMarkerTurn = marker.turnId && observations.some((observation) => (
        observation.kind === "turn" && observation.turnId === marker.turnId
      ))
        ? marker.turnId
        : null;
      let settlement: WorkbenchTranscriptSettlement;
      try {
        settlement = await this.#recorder.record([
          ...observations,
          this.#captureGaps.createRecoveryObservation(marker, recoveredMarkerTurn),
        ]);
      } catch (error) {
        throw await this.#captureGaps.captureFailure({
          error,
          recoverability: "provider",
          ...identity,
        });
      }
      try {
        await this.#captureGaps.completeRecovery(marker);
      } catch (error) {
        throw await this.#captureGaps.captureFailure({
          error,
          recoverability: "provider",
          ...identity,
        });
      }
      await this.#subscriptions.settle(settlement.changedThreadIds);
      return settlement;
    }
    let settlement: WorkbenchTranscriptSettlement;
    try {
      settlement = await this.#recorder.record(observations);
    } catch (error) {
      if (context.source === "compatibility") throw error;
      throw await this.#captureGaps.captureFailure({
        error,
        recoverability: context.source === "provider" ? "provider" : "unrecoverable",
        ...identity,
      });
    }
    await this.#subscriptions.settle(settlement.changedThreadIds);
    return settlement;
  }

  async read(request: WorkbenchTranscriptReadRequest) {
    this.#assertActive();
    return this.#database.readTranscript(request);
  }

  async readMaterializedTurnIds(threadId: string, turnIds: readonly string[]) {
    this.#assertActive();
    if (!this.#database.readTranscriptMaterializedTurnIds) {
      throw new Error("Workbench transcript materialization reads are not configured");
    }
    return this.#database.readTranscriptMaterializedTurnIds(threadId, turnIds);
  }

  captureProviderGap(threadId: string, error: unknown) {
    this.#assertActive();
    return this.#captureGaps.captureFailure({
      error,
      recoverability: "provider",
      threadId,
      turnId: null,
    });
  }

  async subscribe(subscription: WorkbenchTranscriptSubscription) {
    this.#assertActive();
    return this.#subscriptions.subscribe(subscription);
  }

  unsubscribe(id: string) {
    this.#subscriptions.unsubscribe(id);
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#subscriptions.dispose();
  }

  #assertActive() {
    if (this.#disposed) throw new Error("Workbench transcript controller is disposed");
  }
}
