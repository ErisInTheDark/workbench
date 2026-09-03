/*
 * Exports:
 * - default WorkbenchTranscriptModeControl: render the transcript projection mode through the shared click-to-next control. Keywords: transcript, mode, rotator, control.
 */
"use client";

import type { WorkbenchTranscriptModeValue } from "workbench-shared/state/workbench-client-state";

import { getNextWorkbenchTranscriptMode } from "../../workbench/state/workbench-transcript-mode";
import WorkbenchRotatorButton from "./WorkbenchRotatorButton";

const TRANSCRIPT_MODE_LABELS = {
  compare: "JSON / SQL",
  json: "JSON",
  sqlite: "SQL",
} as const satisfies Record<WorkbenchTranscriptModeValue, string>;

export default function WorkbenchTranscriptModeControl({
  mode,
  onRotate,
}: {
  mode: WorkbenchTranscriptModeValue;
  onRotate: () => void;
}) {
  const label = TRANSCRIPT_MODE_LABELS[mode];
  const nextLabel = TRANSCRIPT_MODE_LABELS[getNextWorkbenchTranscriptMode(mode)];
  return (
    <WorkbenchRotatorButton
      ariaLabel={`Transcript projection: ${label}. Click to show ${nextLabel}.`}
      onRotate={onRotate}
      title={`Show ${nextLabel}`}
    >
      <span>{label}</span>
    </WorkbenchRotatorButton>
  );
}
