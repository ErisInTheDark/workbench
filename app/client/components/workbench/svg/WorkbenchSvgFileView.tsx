/*
 * Exports:
 * - NEW_SVG_SOURCE: the empty icon-sized drawing a new svg file starts as.
 * - default WorkbenchSvgFileView: one svg file's editor in the main pane's file tab, which a saved copy replaces and a
 *   discarded new file leaves for its folder index.
 */
"use client";

import type { WorkbenchControls } from "workbench-shared/types";
import { withFileDestination, type WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { useWorkbenchSwapTab } from "../../../workbench/navigation/use-workbench-project-navigation";
import WorkbenchSvgEditorView from "./WorkbenchSvgEditorView";

export const NEW_SVG_SOURCE = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
</svg>
`;

export default function WorkbenchSvgFileView({ controls, location, path, route }: {
  controls: WorkbenchControls | null;
  location: ProjectLocationReference | null;
  path: string;
  /** The main pane's file tab showing `path`. */
  route: WorkbenchRoute;
}) {
  const swapTab = useWorkbenchSwapTab();
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col md:h-full">
      <WorkbenchSvgEditorView
        key={path}
        controls={controls}
        location={location}
        onDiscarded={() => swapTab(withFileDestination(route, path, true))}
        onOpenCopy={copy => swapTab(withFileDestination(route, copy))}
        path={path}
      />
    </div>
  );
}
