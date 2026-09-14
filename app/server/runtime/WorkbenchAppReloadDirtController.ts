/*
 * Exports:
 * - WorkbenchAppReloadDirtControllerState: shared Git-backed dirt handoff state.
 * - WorkbenchAppReloadDirtControllerOptions/default WorkbenchAppReloadDirtController: discover app server sources and apply the app snapshot ref. Keywords: app, reload, Git.
 */
import { readdirSync } from "node:fs";
import path from "node:path";

import ReloadDirtController, {
  type ReloadDirtControllerState,
  type ReloadDirtSourceDescriptor,
  type ReloadDirtSourceState,
} from "workbench-shared/reload/ReloadDirtController";
import type {
  WorkbenchReloadScope,
  WorkbenchReloadScopeDescriptor,
} from "workbench-shared/reload/workbench-reload";

const APP_RELOAD_SNAPSHOT_REF = "refs/worktree/workbench/app-reload-snapshot";
const SOURCE_ROOTS = ["app", "shared"] as const;

export type WorkbenchAppReloadDirtControllerState = ReloadDirtControllerState;

export interface WorkbenchAppReloadDirtControllerOptions {
  getCatalog(): readonly WorkbenchReloadScopeDescriptor[];
  getDependantClosure(scopes: readonly WorkbenchReloadScope[]): WorkbenchReloadScope[];
  getScopesForPaths(paths: readonly string[]): WorkbenchReloadScope[];
  onChange?(): void;
  repositoryRootPath: string;
  watchSource?: typeof import("node:fs").watch;
}

function isProductionSourcePath(sourcePath: string) {
  return !sourcePath.split("/").some((segment) => segment === "node_modules" || segment === "target")
    && !/(?:^|\/)[^/]+\.test\.[^/]+$/u.test(sourcePath);
}

function listProductionSourcePaths(repositoryRootPath: string) {
  const sourcePaths: string[] = [];
  const visit = (absoluteDirectoryPath: string, relativeDirectoryPath: string) => {
    for (const entry of readdirSync(absoluteDirectoryPath, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "target") continue;
      const sourcePath = path.posix.join(relativeDirectoryPath, entry.name);
      if (entry.isDirectory()) {
        visit(path.join(absoluteDirectoryPath, entry.name), sourcePath);
      } else if (isProductionSourcePath(sourcePath)) {
        sourcePaths.push(sourcePath);
      }
    }
  };
  for (const sourceRoot of SOURCE_ROOTS) {
    visit(path.join(repositoryRootPath, sourceRoot), sourceRoot);
  }
  return sourcePaths.sort();
}

function createSourceState(options: WorkbenchAppReloadDirtControllerOptions): ReloadDirtSourceState {
  const catalog = options.getCatalog();
  const pathsByScope = new Map<WorkbenchReloadScope, Set<string>>(
    catalog.map(({ scope }) => [scope, new Set()]),
  );
  for (const sourcePath of listProductionSourcePaths(options.repositoryRootPath)) {
    for (const scope of options.getScopesForPaths([sourcePath])) {
      pathsByScope.get(scope)?.add(sourcePath);
    }
  }
  return {
    dependantClosure: options.getDependantClosure,
    descriptors: catalog.map((descriptor): ReloadDirtSourceDescriptor => ({
      ...descriptor,
      paths: [...pathsByScope.get(descriptor.scope) ?? []].sort(),
    })),
  };
}

function sharedStateOrNull(state: WorkbenchAppReloadDirtControllerState | object | undefined) {
  return state
    && "baselines" in state
    && state.baselines instanceof Map
    && "descriptors" in state
    && state.descriptors instanceof Map
    ? state as WorkbenchAppReloadDirtControllerState
    : null;
}

export default class WorkbenchAppReloadDirtController extends ReloadDirtController {
  constructor(
    options: WorkbenchAppReloadDirtControllerOptions,
    state?: WorkbenchAppReloadDirtControllerState | object,
  ) {
    super({
      getSourceState: () => createSourceState(options),
      isPotentialSourcePath: (sourcePath) => (
        isProductionSourcePath(sourcePath)
        && options.getScopesForPaths([sourcePath]).length > 0
      ),
      onChange: options.onChange,
      repoRoot: options.repositoryRootPath,
      snapshotRef: APP_RELOAD_SNAPSHOT_REF,
      watchSource: options.watchSource,
    }, sharedStateOrNull(state));
  }
}
