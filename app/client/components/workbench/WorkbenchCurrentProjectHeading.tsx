/*
 * Exports:
 * - default WorkbenchCurrentProjectHeading: render one project identity and its independent browse folder.
 */

import type { WorkbenchLogicalProject, WorkbenchProjectOption } from "workbench-shared/types";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import WorkbenchProjectLabel from "./WorkbenchProjectLabel";
import WorkbenchProjectLocationMenu from "./WorkbenchProjectLocationMenu";

export default function WorkbenchCurrentProjectHeading({
  project,
  logicalProject,
  browseLocation,
  onBrowseLocationChange,
}: {
  project: WorkbenchProjectOption;
  logicalProject?: WorkbenchLogicalProject | null;
  browseLocation?: ProjectLocationReference | null;
  onBrowseLocationChange?: (location: ProjectLocationReference) => void;
}) {
  return (
    <div className="min-w-0 shrink-0">
      <hr className="mx-4 my-3 border-0 border-t border-[color-mix(in_srgb,var(--text)_12%,transparent)]" />
      <div className="flex min-w-0 items-center gap-2 pl-5 pb-3">
        <span className="min-w-0 flex-1"><WorkbenchProjectLabel project={logicalProject ?? project} variant="heading" /></span>
        {logicalProject && onBrowseLocationChange ? (
          <WorkbenchProjectLocationMenu
            project={logicalProject}
            selected={browseLocation ?? null}
            onSelect={onBrowseLocationChange}
            label={`Browse ${logicalProject.label} at`}
          />
        ) : null}
      </div>
    </div>
  );
}
