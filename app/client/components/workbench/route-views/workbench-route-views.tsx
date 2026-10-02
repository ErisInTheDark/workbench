/*
 * Exports:
 * - WorkbenchRouteViewProps: current route and navigation callback every registered route view receives.
 * - WorkbenchRouteViewEntry: shell title and component for one full-page main-pane route view.
 * - workbenchRouteViews: registry of full-page route views keyed by route view.
 */
"use client";

import type { ComponentType } from "react";

import type { WorkbenchRoute, WorkbenchRouteView } from "workbench-shared/workbench/navigation/workbench-route";
import WorkbenchNewProjectView from "../new-project/WorkbenchNewProjectView";

export interface WorkbenchRouteViewProps {
  route: WorkbenchRoute;
  navigateToRoute (route: WorkbenchRoute, options?: { replace?: boolean }): void;
}

export interface WorkbenchRouteViewEntry {
  title: string;
  Component: ComponentType<WorkbenchRouteViewProps>;
}

/**
 * Full-page main-pane views. Components read app state through hooks and receive only route and navigation.
 * Settings, stats and git still render as dedicated branches in workbench.tsx; migrate them here.
 */
export const workbenchRouteViews: Partial<Record<WorkbenchRouteView, WorkbenchRouteViewEntry>> = {
  "new-project": { title: "New project", Component: WorkbenchNewProjectView },
};
