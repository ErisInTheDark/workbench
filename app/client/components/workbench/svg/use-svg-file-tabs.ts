/*
 * Exports:
 * - SvgOpenTab: one open svg tab with its resolved folder.
 * - SvgFileTabs: open svg tabs plus tab navigation actions for the workspace view.
 * - useSvgFileTabs: own svg tab routing: explorer opens add tabs, tabs remember themselves per project selection, and each tab's folder address stays canonical.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { WorkbenchLogicalProject } from "workbench-shared/types";
import {
  createLogicalProjectRoute,
  createProjectRoute,
  getWorkbenchFileTabs,
  withFileTabs,
  type WorkbenchFileTab,
  type WorkbenchRoute,
} from "workbench-shared/workbench/navigation/workbench-route";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { isSvgFile } from "workbench-shared/workbench/project/tree-utils";
import { resolveWorkbenchFileRoute } from "../../../workbench/file/use-file";
import type WorkbenchProjectNavigation from "../../../workbench/navigation/workbench-project-navigation";
import { closeFileTab, openFileTab, replaceFileTab, type SvgTabList } from "../../../workbench/svg/svg-file-tabs";

export interface SvgOpenTab {
  key: string;
  tab: WorkbenchFileTab;
  location: ProjectLocationReference | null;
}

export interface SvgFileTabs {
  tabs: SvgOpenTab[];
  index: number;
  select(index: number): void;
  close(index: number): void;
  open(location: ProjectLocationReference | null, filePath: string): void;
  replace(index: number, location: ProjectLocationReference | null, filePath: string): void;
}

const sameLocation = (left: ProjectLocationReference | null, right: ProjectLocationReference | null) =>
  left?.daemonId === right?.daemonId && left?.projectId === right?.projectId;

function svgTabList(route: WorkbenchRoute): SvgTabList | null {
  return route.view === "file" && isSvgFile(route.filePath) ? getWorkbenchFileTabs(route) : null;
}

export function useSvgFileTabs({
  browseLocation,
  currentProjectId,
  logicalProjects,
  navigateToRoute,
  navigator,
  route,
}: {
  browseLocation: ProjectLocationReference | null;
  currentProjectId: string | null;
  logicalProjects: readonly WorkbenchLogicalProject[] | null | undefined;
  navigateToRoute: (route: WorkbenchRoute) => void;
  navigator: WorkbenchProjectNavigation | null;
  route: WorkbenchRoute;
}) {
  const memory = useRef(new Map<string, SvgTabList>());
  const memoryKey = JSON.stringify(route.selectedProjectIds ?? []);
  const current = useMemo(() => svgTabList(route), [route]);
  useEffect(() => { if (current) memory.current.set(memoryKey, current); }, [current, memoryKey]);

  const locate = useCallback((tab: WorkbenchFileTab, base: WorkbenchRoute) =>
    tab.folderAddress?.length ? navigator?.folderForAddress(tab.folderAddress) ?? null
      : navigator?.folderForRoute(base) ?? browseLocation,
  [browseLocation, navigator]);

  /** A tab in the route's own folder carries no folder address; that is the canonical url. */
  const tabFor = useCallback((location: ProjectLocationReference | null, filePath: string, base: WorkbenchRoute): WorkbenchFileTab => {
    const routeFolder = navigator?.folderForRoute(base) ?? browseLocation;
    if (!location || !navigator || sameLocation(location, routeFolder)) return { filePath, folderAddress: null };
    return { filePath, folderAddress: navigator.folderAddressFor(location, { ...base, folderAddress: undefined }) };
  }, [browseLocation, navigator]);

  const routeFor = useCallback((list: SvgTabList, base: WorkbenchRoute) => {
    const focused = list.tabs[list.index]!;
    const location = locate(focused, base);
    const fileRoute = resolveWorkbenchFileRoute({
      currentProjectId, logicalProjects, location, path: focused.filePath,
      projectId: location?.projectId ?? currentProjectId ?? base.projectId, route: base,
    });
    return withFileTabs({ ...fileRoute, folderAddress: base.folderAddress }, list.tabs, list.index);
  }, [currentProjectId, locate, logicalProjects]);

  const routeForWorkbenchFile = useCallback((input: Parameters<typeof resolveWorkbenchFileRoute>[0]) => {
    if (!isSvgFile(input.path)) return resolveWorkbenchFileRoute(input);
    const list = svgTabList(input.route) ?? memory.current.get(JSON.stringify(input.route.selectedProjectIds ?? []))
      ?? { tabs: [], index: 0 };
    return routeFor(openFileTab(list, tabFor(input.location ?? browseLocation, input.path, input.route)), input.route);
  }, [browseLocation, routeFor, tabFor]);

  const tabs = useMemo((): SvgFileTabs | null => {
    if (!current) return null;
    const go = (list: SvgTabList | null) => {
      if (list) {
        navigateToRoute(routeFor(list, route));
        return;
      }
      memory.current.delete(memoryKey);
      navigateToRoute(route.logical?.projectId ? createLogicalProjectRoute(route.logical.projectId) : createProjectRoute(route.projectId));
    };
    return {
      tabs: current.tabs.map(tab => {
        const location = locate(tab, route);
        return { key: `${location?.daemonId ?? ""}/${location?.projectId ?? ""}/${tab.filePath}`, tab, location };
      }),
      index: current.index,
      select: index => go({ tabs: current.tabs, index }),
      close: index => go(closeFileTab(current, index)),
      open: (location, filePath) => go(openFileTab(current, tabFor(location, filePath, route))),
      replace: (index, location, filePath) => go(replaceFileTab(current, index, tabFor(location, filePath, route))),
    };
  }, [current, locate, memoryKey, navigateToRoute, route, routeFor, tabFor]);

  return { routeForWorkbenchFile, tabs };
}
