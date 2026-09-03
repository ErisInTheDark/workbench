/*
 * Exports:
 * - default WorkbenchTranscriptModeControl: render the transcript projection mode through the shared click-to-next control. Keywords: transcript, mode, rotator, control.
 */
"use client";

import type { WorkbenchTranscriptModeValue } from "workbench-shared/state/workbench-client-state";

import WorkbenchRotatorButton from "./WorkbenchRotatorButton";

const TRANSCRIPT_MODE_LABELS = {
  compare: "JSON / SQL",
  json: "JSON",
  sqlite: "SQL",
} as const satisfies Record<WorkbenchTranscriptModeValue, string>;

export default function WorkbenchTranscriptModeControl({
  disabled = false,
  mode,
  nextMode,
  onRotate,
}: {
  disabled?: boolean;
  mode: WorkbenchTranscriptModeValue;
  nextMode: WorkbenchTranscriptModeValue;
  onRotate: (mode: WorkbenchTranscriptModeValue) => void;
}) {
  const label = TRANSCRIPT_MODE_LABELS[mode];
  const nextLabel = TRANSCRIPT_MODE_LABELS[nextMode];
  return (
    <WorkbenchRotatorButton
      ariaLabel={`Transcript view: ${label}. Click to show ${nextLabel}.`}
      disabled={disabled}
      onRotate={() => onRotate(nextMode)}
      title={`Show ${nextLabel}`}
    >
      <span>{label}</span>
    </WorkbenchRotatorButton>
  );
}
