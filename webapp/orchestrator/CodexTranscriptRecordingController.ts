/*
 * CodexTranscriptRecordingControllerOptions: the SQLite recorder port used beside authoritative JSON recording. Keywords: codex, transcript, recording, sqlite.
 * default CodexTranscriptRecordingController: sequence source-owned JSON and SQLite recording without owning admission or a queue. Keywords: codex, transcript, recording, lifecycle.
 */
import type { WorkbenchTranscriptObservation } from "./database/transcript/workbench-transcript-types.ts";

export interface CodexTranscriptRecordingControllerOptions {
  recordSqlite?: (observations: readonly WorkbenchTranscriptObservation[]) => Promise<void>;
}

interface SourceOwnedRecording {
  observations: readonly WorkbenchTranscriptObservation[];
  recordLegacy: () => Promise<void>;
}

export default class CodexTranscriptRecordingController {
  readonly #recordSqlite: NonNullable<CodexTranscriptRecordingControllerOptions["recordSqlite"]>;

  constructor({
    recordSqlite = async () => undefined,
  }: CodexTranscriptRecordingControllerOptions = {}) {
    this.#recordSqlite = recordSqlite;
  }

  async recordProviderFact(recording: SourceOwnedRecording) {
    await this.#recordSourceOwned(recording);
  }

  async recordWorkbenchMutation(recording: SourceOwnedRecording) {
    await this.#recordSourceOwned(recording);
  }

  async importCompatibilityWindow(
    load: () => Promise<readonly WorkbenchTranscriptObservation[]>,
  ) {
    const observations = await load();
    if (observations.length) await this.#recordSqlite(observations);
  }

  async #recordSourceOwned({
    observations,
    recordLegacy,
  }: SourceOwnedRecording) {
    await recordLegacy();
    if (observations.length) await this.#recordSqlite(observations);
  }
}
