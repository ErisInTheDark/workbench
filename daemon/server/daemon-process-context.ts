/*
 * Exports:
 * - DAEMON_PROCESS_REQUIRED_REGISTRATIONS: live registry keys consumed directly by the stable process shell.
 * - DaemonProcessContext: stable process-shell ports available to every reloadable node generation.
 */
import type { DaemonReloadScope, WorkbenchHarness, WorkbenchSubagentRelationship } from "workbench-shared/types";
import type { WorkbenchBrowseProjectIdResolver, WorkbenchBrowseProjectResolver } from "./lib/workbench/browse/WorkbenchBrowseRuntime";
import type { DaemonReloadScopeDescriptor } from "workbench-shared/workbench/daemon-reload";
import type { WorkbenchThreadStateSnapshot } from "workbench-shared/workbench/thread/thread-state";
import type { BrowseSessionCleanupSupervisorOptions } from "./BrowseSessionCleanupSupervisor";
import type CodexAppServer from "./CodexAppServer";
import type CodexStdioBridge from "./CodexStdioBridge";
import type { CodexStdioBridgeOptions, CodexStdioBridgeReloadState } from "./CodexStdioBridge";
import type { CodexHealthMonitorOptions } from "./CodexHealthMonitor";
import type { WorkbenchBrowseResultCallbacks } from "./WorkbenchBrowseResultController";
import type { WorkbenchHardReloadOptions } from "./WorkbenchDaemonReloadController";
import type WorkbenchThreadTransitionCoordinator from "./WorkbenchThreadTransitionCoordinator";
import type WorkbenchTurnRecoveryController from "./WorkbenchTurnRecoveryController";
import type { WorkbenchHarnessRuntimePort } from "./WorkbenchHarnessController";
import type { DaemonRuntimeObjects } from "./daemon-runtime-objects";
import type { WorkbenchWebSocketDelivery } from "./WorkbenchWebSocketRequestController";

export const DAEMON_PROCESS_REQUIRED_REGISTRATIONS = [
  "browseExecution",
  "codexAppServer",
  "codexBridge",
  "harnesses",
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
  browseCleanupOptions: BrowseSessionCleanupSupervisorOptions;
  browseProjectResolvers: {
    resolveProjectById: WorkbenchBrowseProjectIdResolver;
    resolveProjectFromCwd: WorkbenchBrowseProjectResolver;
  };
  browseResultCallbacks: WorkbenchBrowseResultCallbacks;
  codexAppServerOptions: Omit<ConstructorParameters<typeof CodexAppServer>[0], "onFatalExit" | "onMessage">;
  codexBridgeUrl: string;
  codexHealthOptions: CodexHealthMonitorOptions;
  createCodexBridgeOptions(appServer: CodexAppServer, initialState?: CodexStdioBridgeReloadState): CodexStdioBridgeOptions;
  executeBrowseRequest(body: Buffer, signal: AbortSignal): Promise<Response>;
  executeBrowseSessionRequest(request: { body: Buffer; method: string; url: string }, signal: AbortSignal): Promise<Response>;
  executeReloadScopes(scopes: DaemonReloadScope[]): Promise<void>;
  getReloadScopeCatalog(): readonly DaemonReloadScopeDescriptor[];
  getReloadScopesForPaths(paths: readonly string[]): DaemonReloadScope[];
  hardReload: WorkbenchHardReloadOptions;
  harnessPorts: Record<WorkbenchHarness, WorkbenchHarnessRuntimePort>;
  installSubagentRelationship(record: WorkbenchSubagentRelationship): Promise<void>;
  legacyMigrationProjectRoot: string;
  localDaemonOrigin: string;
  logTurnRecovery(message: string): void;
  onCodexBridgeReady(bridge: CodexStdioBridge): Promise<void>;
  onCodexBridgeUnavailable(restartingAppServer: boolean): void;
  onCodexFatalExit(reason: string, bridge: CodexStdioBridge | null): void;
  publishThreadState(connectionId: string, snapshot: WorkbenchThreadStateSnapshot): void;
  reportWebSocketDelivery(delivery: WorkbenchWebSocketDelivery): void;
  reportTurnRecoveryFailure(cwd: string, harness: WorkbenchHarness, threadId: string): Promise<void>;
  refreshWorkbenchPromptFiles(): Promise<void>;
  runTurnRecoveryTask(owner: WorkbenchTurnRecoveryController, label: string, task: () => Promise<void>): Promise<void>;
  threadTransitions: WorkbenchThreadTransitionCoordinator;
}
