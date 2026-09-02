/*
 * Exports:
 * - AppProcessContext: stable app-shell ports supplied to reloadable generations. Keywords: app, process, graph.
 */
import type { WorkbenchReloadScope, WorkbenchReloadScopeDescriptor } from "workbench-shared/reload/workbench-reload";

import type WorkbenchAppLogger from "../WorkbenchAppLogger.ts";
import type { WorkbenchAppPortControl } from "../WorkbenchApp.ts";
import type WorkbenchFrontendCompiler from "../WorkbenchFrontendCompiler.ts";
import type WorkbenchAppStateRepository from "../state/WorkbenchAppStateRepository.ts";

export interface AppProcessContext {
  appPort: WorkbenchAppPortControl;
  createCompiler(): WorkbenchFrontendCompiler;
  createDatabase(Repository: typeof WorkbenchAppStateRepository): WorkbenchAppStateRepository;
  executeReloadScopes(scopes: WorkbenchReloadScope[]): Promise<WorkbenchReloadScope[]>;
  getReloadDependantClosure(scopes: readonly WorkbenchReloadScope[]): WorkbenchReloadScope[];
  getReloadScopeCatalog(): readonly WorkbenchReloadScopeDescriptor[];
  getReloadScopesForPaths(paths: readonly string[]): WorkbenchReloadScope[];
  logger: WorkbenchAppLogger;
  outputDirectoryPath: string;
  repositoryRootPath: string;
}
