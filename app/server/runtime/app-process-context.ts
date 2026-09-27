/*
 * Exports:
 * - AppProcessContext: stable app-shell ports supplied to reloadable generations.
 */
import type { WorkbenchReloadScope } from "workbench-shared/reload/workbench-reload";
import type WorkbenchProcessLogger from "workbench-shared/process/WorkbenchProcessLogger";

import type { WorkbenchAppPortControl } from "../WorkbenchApp.ts";
import type WorkbenchFrontendCompiler from "../WorkbenchFrontendCompiler.ts";
import type WorkbenchAppStateRepository from "../state/WorkbenchAppStateRepository.ts";
import type WorkbenchNetworkController from "../network/WorkbenchNetworkController.ts";
import type { projectWorkbenchAppRuntimeSnapshot } from "./workbench-app-runtime-snapshot.ts";

export interface AppProcessContext {
  daemonEndpointPath: string;
  appPort: WorkbenchAppPortControl;
  captureReactDevelopmentMode(readRequested: () => boolean): boolean;
  createCompiler?(logger: WorkbenchProcessLogger, readReactDevelopmentMode: () => boolean): WorkbenchFrontendCompiler;
  createDatabase(Repository: typeof WorkbenchAppStateRepository): WorkbenchAppStateRepository;
  createNetwork?: (options: ConstructorParameters<typeof WorkbenchNetworkController>[0]) => WorkbenchNetworkController;
  executeReloadScopes(scopes: WorkbenchReloadScope[]): Promise<WorkbenchReloadScope[]>;
  outputDirectoryPath: string;
  processLogger: WorkbenchProcessLogger;
  readAppRuntimeSnapshot(): ReturnType<typeof projectWorkbenchAppRuntimeSnapshot>;
  readAppliedReactDevelopmentMode(): boolean;
  repositoryRootPath: string;
  supportsAppWebSockets?: true;
  subscribeAppRuntimeChanges(listener: () => void): () => void;
}
