/*
 * Exports:
 * - default WorkbenchTranscriptRecorder: forward ordered semantic observations, with oversized item text bounded, without turning one rolled-back batch into lifecycle state.
 */
import type WorkbenchDatabaseController from "../WorkbenchDatabaseController.ts";
import { boundTranscriptObservations } from "./transcript-item-bounds.ts";
import type {
  WorkbenchTranscriptObservation,
  WorkbenchTranscriptSettlement,
  WorkbenchTranscriptSettlementMode,
} from "./workbench-transcript-types.ts";

export default class WorkbenchTranscriptRecorder {
  readonly #database: Pick<WorkbenchDatabaseController, "settleTranscript">;

  constructor(database: Pick<WorkbenchDatabaseController, "settleTranscript">) {
    this.#database = database;
  }

  async record(
    observations: readonly WorkbenchTranscriptObservation[],
    mode: WorkbenchTranscriptSettlementMode = "live",
  ): Promise<WorkbenchTranscriptSettlement> {
    // Bounded before the worker boundary, so oversized text never crosses into, or replays through, the writer.
    return await this.#database.settleTranscript(boundTranscriptObservations(observations), mode);
  }
}
