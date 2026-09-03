/*
 * Exports:
 * - default WorkbenchProjectControl: render the home draft's click-to-next project rotator beside the harness control. Keywords: thread, composer, project, rotator.
 */
"use client";

import type { WorkbenchProjectOption } from "workbench-shared/types";
import { ProjectIcon } from "./workbench-icons";
import WorkbenchRotatorButton from "./WorkbenchRotatorButton";

export default function WorkbenchProjectControl({
  disabled = false,
  onRotate,
  project,
}: {
  disabled?: boolean;
  onRotate: () => void;
  project: WorkbenchProjectOption;
}) {
  const label = project.name || project.id;
  return (
    <WorkbenchRotatorButton
      ariaLabel={`Create thread in ${label}. Click to use the next recent project.`}
      disabled={disabled}
      onRotate={onRotate}
      title={label}
    >
      <ProjectIcon className="size-4 shrink-0" />
      <span className="truncate">{label}</span>
    </WorkbenchRotatorButton>
  );
}
