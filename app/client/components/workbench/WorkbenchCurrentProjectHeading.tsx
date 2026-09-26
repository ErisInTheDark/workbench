/*
 * Exports:
 * - default WorkbenchCurrentProjectHeading: render one project identity without selecting a view-wide folder.
 */

import type { WorkbenchLogicalProject, WorkbenchProjectOption } from "workbench-shared/types";
import WorkbenchProjectLabel from "./WorkbenchProjectLabel";

export default function WorkbenchCurrentProjectHeading({
  project,
  logicalProject,
}: {
  project?: WorkbenchProjectOption | null;
  logicalProject?: WorkbenchLogicalProject | null;
}) {
  const displayedProject = logicalProject ?? project;
  if (!displayedProject) return null;
  return (
    <div className="min-w-0 shrink-0">
      <hr className="mx-4 my-3 border-0 border-t border-[color-mix(in_srgb,var(--text)_12%,transparent)]" />
      <div className="flex min-w-0 items-center gap-2 pl-5 pb-3">
        <span className="min-w-0 flex-1"><WorkbenchProjectLabel project={displayedProject} variant="heading" /></span>
      </div>
    </div>
  );
}
