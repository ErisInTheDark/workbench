/*
 * Exports:
 * - AppProcessContext: stable app-shell ports supplied to reloadable generations.
 */
import type { WorkbenchReloadScope, WorkbenchReloadDirtSnapshot } from "workbench-shared/reload/workbench-reload";
import type { InstallationUpdate } from "workbench-shared/workbench/installation-update";
import type { DaemonId } from "workbench-shared/workbench/identity";
import type WorkbenchProcessLogger from "workbench-shared/process/WorkbenchProcessLogger";

import type { WorkbenchAppPortControl } from "../WorkbenchApp.ts";
import type WorkbenchFrontendCompiler from "../WorkbenchFrontendCompiler.ts";
import type WorkbenchAppStateRepository from "../state/WorkbenchAppStateRepository.ts";
import type WorkbenchNetworkController from "../network/WorkbenchNetworkController.ts";
import type { projectWorkbenchAppRuntimeSnapshot } from "./workbench-app-runtime-snapshot.ts";
import type { AppRuntimeObjects } from "./app-runtime-objects";
import type WorkbenchAppReloadOrchestrator from "./WorkbenchAppReloadOrchestrator";
import type { WorkbenchAppReloadAdmission } from "./WorkbenchAppReloadController";

export interface AppProcessContext {
  daemonEndpointPath: string;
  appPort: WorkbenchAppPortControl;
  captureReactDevelopmentMode(readRequested: () => boolean): boolean;
  createCompiler?(logger: WorkbenchProcessLogger, readReactDevelopmentMode: () => boolean): WorkbenchFrontendCompiler;
  createDatabase(Repository: typeof WorkbenchAppStateRepository): WorkbenchAppStateRepository;
  createNetwork?: (options: ConstructorParameters<typeof WorkbenchNetworkController>[0]) => WorkbenchNetworkController;
  executeReloadScopes(scopes: WorkbenchReloadScope[]): Promise<WorkbenchReloadScope[]>;
  runRuntimeObject<Key extends keyof AppRuntimeObjects, Result>(
    key: Key, operation: (owner: AppRuntimeObjects[Key]) => Promise<Result> | Result,
  ): Promise<Result>;
  admitAppReload(scopes: string[], options?: { installFromSha?: string }): WorkbenchAppReloadAdmission;
  reloadOperations: Pick<WorkbenchAppReloadOrchestrator, "read" | "subscribe" | "admitReloadAll" | "admitPull">;
  readControlDaemonFacts(): { dirt: WorkbenchReloadDirtSnapshot | null; update: InstallationUpdate | null };
  isLocalDaemon(daemonId: DaemonId): boolean;
  outputDirectoryPath: string;
  processLogger: WorkbenchProcessLogger;
  readAppRuntimeSnapshot(): ReturnType<typeof projectWorkbenchAppRuntimeSnapshot>;
  readAppliedReactDevelopmentMode(): boolean;
  repositoryRootPath: string;
  supportsAppWebSockets?: true;
  subscribeAppRuntimeChanges(listener: () => void): () => void;
}
