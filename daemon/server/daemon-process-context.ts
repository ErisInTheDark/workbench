/*
 * Exports:
 * - DAEMON_PROCESS_REQUIRED_REGISTRATIONS: live registry keys consumed directly by the stable process shell.
 * - DaemonProcessContext: stable process-shell ports available to every reloadable node generation.
 */
import type { DaemonReloadScope, WorkbenchHarness, WorkbenchSubagentRelationship } from "workbench-shared/types";
import type { WorkbenchBrowseProjectIdResolver, WorkbenchBrowseProjectResolver } from "./lib/workbench/browse/WorkbenchBrowseRuntime";
import type { DaemonReloadScopeDescriptor } from "workbench-shared/workbench/daemon-reload";
import type { WorkbenchThreadStateSnapshot } from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchHardReloadOptions } from "./WorkbenchDaemonReloadController";
import type WorkbenchThreadTransitionCoordinator from "./WorkbenchThreadTransitionCoordinator";
import type WorkbenchTurnRecoveryController from "./WorkbenchTurnRecoveryController";
import type { DaemonRuntimeObjects } from "./daemon-runtime-objects";
import type { WorkbenchWebSocketDelivery } from "./WorkbenchWebSocketRequestController";

export const DAEMON_PROCESS_REQUIRED_REGISTRATIONS = [
  "browseExecution",
  "modules",
  "daemonHttp",
  "projectCatalog",
  "reloadController",
  "subagents",
  "threadState",
  "turnRecovery",
  "webSocketRequests",
] as const satisfies readonly (keyof DaemonRuntimeObjects)[];

export interface DaemonProcessContext {
  daemonPackageRoot: string;
  webSocketUrl: string;
  isShuttingDown(): boolean;
  isHardReloadPending(): boolean;
  broadcastProviderNotification(harness: WorkbenchHarness, message: import("./bridge-types").JsonRpcNotification): void;
  browseProjectResolvers: {
    resolveProjectById: WorkbenchBrowseProjectIdResolver;
    resolveProjectFromCwd: WorkbenchBrowseProjectResolver;
  };
  executeBrowseRequest(body: Buffer, signal: AbortSignal): Promise<Response>;
  executeBrowseSessionRequest(request: { body: Buffer; method: string; url: string }, signal: AbortSignal): Promise<Response>;
  executeReloadScopes(scopes: DaemonReloadScope[]): Promise<void>;
  getReloadScopeCatalog(): readonly DaemonReloadScopeDescriptor[];
  getReloadScopesForPaths(paths: readonly string[]): DaemonReloadScope[];
  hardReload: WorkbenchHardReloadOptions;
  installSubagentRelationship(record: WorkbenchSubagentRelationship): Promise<void>;
  legacyMigrationProjectRoot: string;
  localDaemonOrigin: string;
  logTurnRecovery(message: string): void;
  publishThreadState(connectionId: string, snapshot: WorkbenchThreadStateSnapshot): void;
  reportWebSocketDelivery(delivery: WorkbenchWebSocketDelivery): void;
  reportTurnRecoveryFailure(cwd: string, harness: WorkbenchHarness, threadId: string): Promise<void>;
  refreshWorkbenchPromptFiles(): Promise<void>;
  runTurnRecoveryTask(owner: WorkbenchTurnRecoveryController, label: string, task: () => Promise<void>): Promise<void>;
  threadTransitions: WorkbenchThreadTransitionCoordinator;
}
