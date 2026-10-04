/*
 * Exports:
 * - FileScope: concrete project and daemon context for a rendered file.
 * - FileOpenAction: shared file-opening action signature.
 * - FileActionContext: share one file-open action without DOM delegation.
 * - FileScopeContext: identify the project and daemon owning rendered file controls.
 * - useFileActions: route file opens through Workbench or VS Code policy.
 * - useFile: derive file-pill display and its owner-scoped open action.
 * - resolveFileOpenDestination: choose the destination for a file target.
 * - resolveWorkbenchFileRoute: route a file through its concrete project owner.
 */
"use client";

import { createContext, useCallback, useContext } from "react";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import {
  createFileRoute,
  createLogicalFileRoute,
  type WorkbenchRoute,
} from "workbench-shared/workbench/navigation/workbench-route";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { ProjectLocationReferenceSchema } from "workbench-shared/workbench/project/project-location";
import { isWorkbenchOpenableFile } from "workbench-shared/workbench/project/tree-utils";
import type { WorkbenchFileOpenTarget, WorkbenchLogicalProject } from "workbench-shared/types";
import type { WorkbenchFileOpenBehavior } from "workbench-shared/workbench/settings/workbench-setting-definitions";
import {
  getProjectFilePathDisplay,
  type ProjectFilePathDisplayOptions,
} from "../project/project-file-path";

export interface FileScope {
  daemon?: WorkbenchDaemonClient | null;
  daemonId?: string | null;
  projectId?: string | null;
}

export type FileOpenAction = (target: WorkbenchFileOpenTarget, scope?: FileScope | null) => Promise<boolean>;

export const FileActionContext = createContext<FileOpenAction | null>(null);
export const FileScopeContext = createContext<FileScope | null>(null);

export function resolveFileOpenDestination(
  target: WorkbenchFileOpenTarget,
  behavior: WorkbenchFileOpenBehavior,
): "workbench" | "vscode" | null {
  if (target.absolutePath || behavior === "vscode") return "vscode";
  if (isWorkbenchOpenableFile(target.path)) return "workbench";
  return behavior === "workbench-or-vscode" ? "vscode" : null;
}

export function resolveWorkbenchFileRoute({
  currentProjectId,
  logicalProjects,
  location,
  path,
  projectId,
  route,
}: {
  currentProjectId: string | null;
  logicalProjects: readonly WorkbenchLogicalProject[] | null | undefined;
  location: ProjectLocationReference | null;
  path: string;
  projectId: string;
  route: WorkbenchRoute;
}): WorkbenchRoute {
  if (location) {
    const source = { daemonId: location.daemonId, projectId: ProjectIdSchema.parse(projectId) };
    const owner = logicalProjects?.find(project => project.locations.some(item =>
      item.target.daemonId === source.daemonId && item.target.projectId === source.projectId));
    return owner ? createLogicalFileRoute(owner.id, source, path)
      : {
        ...createFileRoute(projectId, path),
        logical: { projectId: null, threadOwnerProjectId: null, location: source, browseLocation: null },
      };
  }
  if (route.logical?.projectId) return createLogicalFileRoute(route.logical.projectId, null, path);
  return createFileRoute(projectId || currentProjectId || route.projectId, path);
}

export function useFileActions({
  behavior,
  browseLocation,
  currentProjectId,
  defaultDaemon,
  logicalProjects,
  navigateToRoute,
  onInvalidLocation,
  route,
  selectedDaemon,
}: {
  behavior: WorkbenchFileOpenBehavior;
  browseLocation: ProjectLocationReference | null;
  currentProjectId: string | null;
  defaultDaemon: WorkbenchDaemonClient | null;
  logicalProjects: readonly WorkbenchLogicalProject[] | null | undefined;
  navigateToRoute: (route: WorkbenchRoute) => void;
  onInvalidLocation: () => void;
  route: WorkbenchRoute;
  selectedDaemon: WorkbenchDaemonClient | null;
}): FileOpenAction {
  return useCallback(async (target, scope) => {
    const projectId = target.projectId ?? scope?.projectId ?? currentProjectId ?? route.projectId;
    const locationValue = scope?.daemonId
      ? { daemonId: scope.daemonId, projectId }
      : null;
    const parsedLocation = locationValue ? ProjectLocationReferenceSchema.safeParse(locationValue) : null;
    if (parsedLocation && !parsedLocation.success) {
      onInvalidLocation();
      return false;
    }
    const location = parsedLocation?.data ?? browseLocation;
    const destination = resolveFileOpenDestination(target, behavior);
    if (!destination) return false;

    if (destination === "workbench") {
      if (route.view === "file" && target.path === route.filePath
        && (route.logical?.location?.daemonId ?? null) === (location?.daemonId ?? null)
        && (route.logical?.location?.projectId ?? route.projectId) === projectId) return true;
      navigateToRoute(resolveWorkbenchFileRoute({
        currentProjectId, logicalProjects, location, path: target.path, projectId, route,
      }));
      return true;
    }

    const daemon = scope?.daemonId
      ? scope.daemon ?? null
      : scope?.daemon ?? selectedDaemon ?? defaultDaemon;
    if (!daemon) return false;
    try {
      await daemon.nativeFiles.open({
        absolutePath: target.absolutePath ?? null,
        columnNumber: target.columnNumber ?? null,
        lineNumber: target.lineNumber ?? null,
        path: target.path,
        projectId,
      });
      return true;
    } catch {
      console.error("Unable to open file in VS Code.");
      return false;
    }
  }, [behavior, browseLocation, currentProjectId, defaultDaemon, logicalProjects, navigateToRoute,
    onInvalidLocation, route, selectedDaemon]);
}

export function useFile({
  absolutePath,
  columnNumber,
  displayOptions,
  lineNumber,
  openPath,
  path,
  projectId,
  targetType,
}: {
  absolutePath: string | null;
  columnNumber: number | null | undefined;
  displayOptions: ProjectFilePathDisplayOptions;
  lineNumber: number | null | undefined;
  openPath: string | null;
  path: string;
  projectId: string | null;
  targetType: "directory" | "file";
}) {
  const action = useContext(FileActionContext);
  const scope = useContext(FileScopeContext);
  const display = getProjectFilePathDisplay(path, { ...displayOptions, absolutePath });
  const isFileControl = targetType === "file" && Boolean(projectId?.trim() || absolutePath?.trim());
  const open = useCallback(() => {
    if (!action || !isFileControl) return;
    void action({
      absolutePath,
      columnNumber,
      lineNumber,
      path: openPath ?? path,
      projectId,
    }, scope);
  }, [absolutePath, action, columnNumber, isFileControl, lineNumber, openPath, path, projectId, scope]);
  return { display, isFileControl, open };
}
