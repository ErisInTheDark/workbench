"use client";

/*
 * Exports:
 * - default WorkbenchWorkspace: subscribe to workspace state and render the split panel composition boundary.
 */

import { useSyncExternalStore, type ComponentProps } from "react";

import type WorkbenchWorkspaceController from "../../workbench/layout/WorkbenchWorkspaceController";
import WorkbenchMainLayoutView from "./layout/WorkbenchMainLayoutView";

type WorkbenchWorkspaceProps = Omit<
  ComponentProps<typeof WorkbenchMainLayoutView>,
  "layout"
> & {
  controller: WorkbenchWorkspaceController;
};

export default function WorkbenchWorkspace({
  controller,
  ...props
}: WorkbenchWorkspaceProps) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  if (!snapshot.renderLayout) return null;
  return <WorkbenchMainLayoutView {...props} layout={snapshot.renderLayout} />;
}
