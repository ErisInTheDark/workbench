/*
 * Exports:
 * - CodexTranscriptRecordingControllerOptions: native-fact port used beside source-owned JSON recording.
 * - CodexTranscriptSqliteRecordingFailure: SQLite-side failure after legacy recording.
 * - default CodexTranscriptRecordingController: sequence source-owned recording without owning admission or a queue.
 */
import type { NativeTranscriptObservation } from "./database/transcript/workbench-transcript-types.ts";
import type { WorkbenchTranscriptRecordingContext } from "./database/transcript/workbench-transcript-types.ts";

export interface CodexTranscriptRecordingControllerOptions {
  recordSqlite?: (
    observations: readonly NativeTranscriptObservation[],
    context: WorkbenchTranscriptRecordingContext,
  ) => Promise<void>;
}

interface SourceOwnedRecording {
  observations: readonly NativeTranscriptObservation[];
  recordLegacy: () => Promise<void>;
}

export class CodexTranscriptSqliteRecordingFailure extends Error {
  override readonly name = "CodexTranscriptSqliteRecordingFailure";

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

export default class CodexTranscriptRecordingController {
  readonly #recordSqlite: NonNullable<CodexTranscriptRecordingControllerOptions["recordSqlite"]>;

  constructor({
    recordSqlite = async () => undefined,
  }: CodexTranscriptRecordingControllerOptions = {}) {
    this.#recordSqlite = recordSqlite;
  }

  async recordProviderFact(
    recording: SourceOwnedRecording & {
      recordCrossedWorkbenchFacts?: () => Promise<readonly NativeTranscriptObservation[]>;
      recoveryBoundary?: boolean;
    },
  ) {
    await recording.recordLegacy();
    const workbenchObservations = await recording.recordCrossedWorkbenchFacts?.() ?? [];
    const observations = [...recording.observations, ...workbenchObservations];
    if (observations.length) {
      await this.#recordSqliteFact(observations, {
        ...(recording.recoveryBoundary ? { recoveryBoundary: true } : {}),
        source: workbenchObservations.length ? "workbench" : "provider",
      });
    }
  }

  async recordWorkbenchMutation(recording: SourceOwnedRecording) {
    await this.recordCrossedWorkbenchMutation(recording);
  }

  async recordCrossedWorkbenchMutation(recording: SourceOwnedRecording) {
    await recording.recordLegacy();
    if (recording.observations.length) {
      await this.#recordSqliteFact(recording.observations, { source: "workbench" });
    }
  }

  async importCompatibilityWindow(
    load: () => Promise<readonly NativeTranscriptObservation[]>,
  ) {
    const observations = await load();
    if (observations.length) await this.#recordSqliteFact(observations, { source: "compatibility" });
  }

  async #recordSqliteFact(
    observations: readonly NativeTranscriptObservation[],
    context: WorkbenchTranscriptRecordingContext,
  ) {
    try {
      await this.#recordSqlite(observations, context);
    } catch (error) {
      throw new CodexTranscriptSqliteRecordingFailure(error);
    }
  }
}
