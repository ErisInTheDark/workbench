/*
 * Exports:
 * - default WorkbenchCurrentProjectHeading: render the prominent, non-interactive current-project landmark and its sidebar divider. Keywords: project, heading, sidebar, divider, path.
 */

import type { WorkbenchProjectOption } from "../../lib/types";
import WorkbenchProjectLabel from "./WorkbenchProjectLabel";

export default function WorkbenchCurrentProjectHeading({
  project,
}: {
  project: WorkbenchProjectOption;
}) {
  return (
    <div className="min-w-0 shrink-0">
      <hr className="mx-4 my-3 border-0 border-t border-[color-mix(in_srgb,var(--text)_12%,transparent)]" />
      <div className="min-w-0 px-2 pb-3">
        <WorkbenchProjectLabel project={project} variant="heading" />
      </div>
    </div>
  );
}
