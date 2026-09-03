/*
 * Exports:
 * - canPersistWorkbenchTranscriptMode: report whether the app-state server admits the transcript mode preference. Keywords: transcript, mode, schema, compatibility.
 * - getNextWorkbenchTranscriptMode: rotate through JSON, comparison, and SQLite transcript projections. Keywords: transcript, mode, rotator.
 * - readWorkbenchTranscriptMode: read one normalised browser-global transcript projection preference. Keywords: transcript, app state, global preference.
 * - writeWorkbenchTranscriptMode: persist one browser-global transcript projection preference. Keywords: transcript, app state, persistence.
 */
import type {
  WorkbenchClientStateRecord,
  WorkbenchTranscriptModeValue,
} from "workbench-shared/state/workbench-client-state";

import WorkbenchClientStateController from "./WorkbenchClientStateController";

const WORKBENCH_TRANSCRIPT_MODES = [
  "json",
  "compare",
  "sqlite",
] as const satisfies readonly WorkbenchTranscriptModeValue[];
const WORKBENCH_TRANSCRIPT_MODE_SCHEMA_VERSION = 6;

function normalizeWorkbenchTranscriptMode(value: unknown): WorkbenchTranscriptModeValue {
  return WORKBENCH_TRANSCRIPT_MODES.find((mode) => mode === value) ?? "json";
}

export function canPersistWorkbenchTranscriptMode(schemaVersion: number) {
  return schemaVersion >= WORKBENCH_TRANSCRIPT_MODE_SCHEMA_VERSION;
}

export function getNextWorkbenchTranscriptMode(
  mode: WorkbenchTranscriptModeValue,
): WorkbenchTranscriptModeValue {
  const index = WORKBENCH_TRANSCRIPT_MODES.indexOf(mode);
  return WORKBENCH_TRANSCRIPT_MODES[(index + 1) % WORKBENCH_TRANSCRIPT_MODES.length] ?? "json";
}

export function readWorkbenchTranscriptMode(
  records: readonly WorkbenchClientStateRecord[] = [],
): WorkbenchTranscriptModeValue {
  for (const record of records) {
    if (
      record.kind === "globalPreference"
      && record.preference.key === "transcriptProjectionMode"
    ) {
      return normalizeWorkbenchTranscriptMode(record.preference.value);
    }
  }
  return "json";
}

export async function writeWorkbenchTranscriptMode(
  controller: WorkbenchClientStateController,
  mode: WorkbenchTranscriptModeValue,
) {
  await controller.put({
    kind: "globalPreference",
    preference: {
      key: "transcriptProjectionMode",
      value: normalizeWorkbenchTranscriptMode(mode),
    },
  });
}
