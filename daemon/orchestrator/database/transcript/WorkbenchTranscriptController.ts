/*
 * Exports:
 * - default WorkbenchTranscriptController: own readiness, recording, recovery, reads, subscriptions and disposal.
 */
import { logError } from "../../process-helpers.ts";
import type { WorkbenchThreadId, WorkbenchTurnId } from "workbench-shared/workbench/identity";
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
  const threadIds = new Set<WorkbenchThreadId>();
  const turnIds = new Set<WorkbenchTurnId>();
  for (const observation of observations) {
    if (observation.kind === "usageWindow" || observation.kind === "turnCatalog") {
      threadIds.add(observation.threadId);
      continue;
    }
    if (observation.kind === "canonicalWindow" || observation.kind === "providerTurnScope") {
      threadIds.add(observation.threadId);
      for (const turnId of observation.kind === "canonicalWindow"
        ? observation.materializedTurnIds
        : observation.completeTurnIds) {
        turnIds.add(turnId);
      }
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

function reportSubscriptionFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  logError(
    "workbench-transcript-subscription",
    `latest-window refresh failed: ${message.slice(0, 500)}`,
  );
}

function requestsSubscriptionRefresh(
  observations: readonly WorkbenchTranscriptObservation[],
  source: WorkbenchTranscriptRecordingContext["source"],
) {
  return observations.some((observation) => {
    switch (observation.kind) {
      case "canonicalWindow":
      case "providerTurnScope":
      case "thread":
      case "questionnaire":
      case "browse":
        return true;
      case "turn":
        return observation.state === "completed"
          || observation.state === "interrupted"
          || observation.state === "failed";
      case "steer":
        return observation.entry.resolvedAt !== null;
      case "item":
        return source === "workbench";
      case "captureGap":
      case "nativeEvidence":
      case "usageWindow":
      case "turnCatalog":
      case "turnUsageContext":
      case "turnTokenUsage":
      case "threadContextUsage":
        return false;
    }
  });
}

function observedTurnId(
  observation: WorkbenchTranscriptObservation,
  turnId: string,
) {
  if (observation.kind === "turn") return observation.turnId === turnId ? observation.turnId : null;
  if (observation.kind === "canonicalWindow") {
    return observation.materializedTurnIds.find(id => id === turnId) ?? null;
  }
  if (observation.kind === "providerTurnScope") {
    return observation.completeTurnIds.find(id => id === turnId) ?? null;
  }
  return null;
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
    this.#subscriptions = new WorkbenchTranscriptSubscriptionController(
      (request) => this.read(request),
      reportSubscriptionFailure,
    );
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
    await this.#database.start();
    await this.#captureGaps.start();
  }

  async record(
    observations: readonly WorkbenchTranscriptObservation[],
    context: WorkbenchTranscriptRecordingContext,
  ) {
    this.#assertActive();
    if (observations.length === 0) return { changedThreadIds: [] };
    await this.#captureGaps.prepareReferences();
    const identity = observationIdentity(observations);
    if (context.recoveryBoundary) {
      if (context.source !== "provider") {
        throw new Error("SQLite transcript recovery must use provider-owned observations.");
      }
      const marker = this.#captureGaps.requireRecovery(identity.threadId);
      const recoveredMarkerTurn = marker.turnId
        ? observations.map(observation => observedTurnId(observation, marker.turnId!)).find(turnId => turnId !== null) ?? null
        : null;
      const recoveryObservations = [
        ...observations,
        this.#captureGaps.createRecoveryObservation(marker, recoveredMarkerTurn),
      ];
      let settlement: WorkbenchTranscriptSettlement;
      try {
        settlement = await this.#recorder.record(recoveryObservations);
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
      if (requestsSubscriptionRefresh(recoveryObservations, context.source)) {
        this.#subscriptions.settle(settlement.changedThreadIds);
      }
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
    if (requestsSubscriptionRefresh(observations, context.source)) {
      this.#subscriptions.settle(settlement.changedThreadIds);
    }
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
