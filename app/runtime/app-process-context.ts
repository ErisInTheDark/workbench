/*
 * Exports:
 * - AppProcessContext: stable app-shell ports supplied to reloadable generations. Keywords: app, process, graph.
 */
import type { WorkbenchReloadScope, WorkbenchReloadScopeDescriptor } from "workbench-shared/reload/workbench-reload";

import type WorkbenchAppLogger from "../WorkbenchAppLogger.ts";
import type WorkbenchFrontendCompiler from "../WorkbenchFrontendCompiler.ts";
import type WorkbenchAppStateRepository from "../state/WorkbenchAppStateRepository.ts";

export interface AppProcessContext {
  createCompiler(): WorkbenchFrontendCompiler;
  createDatabase(): WorkbenchAppStateRepository;
  executeReloadScopes(scopes: WorkbenchReloadScope[]): Promise<WorkbenchReloadScope[]>;
  getReloadScopeCatalog(): readonly WorkbenchReloadScopeDescriptor[];
  getReloadScopesForPaths(paths: readonly string[]): WorkbenchReloadScope[];
  legacyOrigin: string;
  logger: WorkbenchAppLogger;
  outputDirectoryPath: string;
  repositoryRootPath: string;
}
