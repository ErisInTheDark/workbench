/*
 * WorkbenchTranscriptController: owns transcript readiness, recording, reads, active subscriptions, and disposal above the database worker. Keywords: transcript, controller, lifecycle.
 */
import type WorkbenchDatabaseController from "../WorkbenchDatabaseController.ts";
import WorkbenchTranscriptRecorder from "./WorkbenchTranscriptRecorder.ts";
import WorkbenchTranscriptSubscriptionController, {
  type WorkbenchTranscriptSubscription,
} from "./WorkbenchTranscriptSubscriptionController.ts";
import type {
  WorkbenchTranscriptObservation,
  WorkbenchTranscriptReadRequest,
} from "./workbench-transcript-types.ts";

export default class WorkbenchTranscriptController {
  readonly #database: Pick<WorkbenchDatabaseController, "failure" | "readTranscript" | "settleTranscript" | "start">;
  readonly #recorder: WorkbenchTranscriptRecorder;
  readonly #subscriptions: WorkbenchTranscriptSubscriptionController;
  #disposed = false;

  constructor(database: Pick<WorkbenchDatabaseController, "failure" | "readTranscript" | "settleTranscript" | "start">) {
    this.#database = database;
    this.#recorder = new WorkbenchTranscriptRecorder(database);
    this.#subscriptions = new WorkbenchTranscriptSubscriptionController((request) => this.read(request));
  }

  get failure() {
    return this.#database.failure;
  }

  async start() {
    this.#assertActive();
    await this.#database.start();
  }

  async record(observations: readonly WorkbenchTranscriptObservation[]) {
    this.#assertActive();
    const settlement = await this.#recorder.record(observations);
    await this.#subscriptions.settle(settlement.changedThreadIds);
    return settlement;
  }

  async read(request: WorkbenchTranscriptReadRequest) {
    this.#assertActive();
    return this.#database.readTranscript(request);
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
