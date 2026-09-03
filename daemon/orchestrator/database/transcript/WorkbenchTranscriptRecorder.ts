/*
 * WorkbenchTranscriptRecorder: forwards ordered semantic observations without turning one rolled-back batch into lifecycle state. Keywords: transcript, recorder, failure.
 */
import type WorkbenchDatabaseController from "../WorkbenchDatabaseController.ts";
import type {
  WorkbenchTranscriptObservation,
  WorkbenchTranscriptSettlement,
} from "./workbench-transcript-types.ts";

export default class WorkbenchTranscriptRecorder {
  readonly #database: Pick<WorkbenchDatabaseController, "settleTranscript">;

  constructor(database: Pick<WorkbenchDatabaseController, "settleTranscript">) {
    this.#database = database;
  }

  async record(observations: readonly WorkbenchTranscriptObservation[]): Promise<WorkbenchTranscriptSettlement> {
    return await this.#database.settleTranscript(observations);
  }
}
