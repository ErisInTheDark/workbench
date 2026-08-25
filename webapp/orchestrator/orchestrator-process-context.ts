/*
 * Exports:
 * - ORCHESTRATOR_PROCESS_REQUIRED_REGISTRATIONS: live registry keys consumed directly by the stable process shell. Keywords: registry, shell, contract.
 * - OrchestratorProcessContext: stable process-shell ports available to every reloadable node generation. Keywords: process, ports, graph.
 */
import type { OrchestratorReloadScope, WorkbenchHarness, WorkbenchSubagentRelationship } from "../lib/types";
import type { WorkbenchBrowseProjectIdResolver, WorkbenchBrowseProjectResolver } from "../lib/workbench/browse/WorkbenchBrowseRuntime";
import type { OrchestratorReloadScopeDescriptor } from "../lib/workbench/orchestrator-reload";
import type { WorkbenchThreadSidebarEntry, WorkbenchThreadStateSnapshot } from "../lib/workbench/thread/thread-state";
import type { BrowseSessionCleanupSupervisorOptions } from "./BrowseSessionCleanupSupervisor";
import type CodexAppServer from "./CodexAppServer";
import type CodexStdioBridge from "./CodexStdioBridge";
import type { CodexStdioBridgeOptions, CodexStdioBridgeReloadState } from "./CodexStdioBridge";
import type { CodexHealthMonitorOptions } from "./CodexHealthMonitor";
import type { NextDevHealthSupervisorOptions } from "./NextDevHealthSupervisor";
import type { OpenCodeBridgeOptions } from "./opencode-bridge";
import type { OpenCodeAppServerOptions } from "./OpenCodeAppServer";
import type { WorkbenchBrowseResultCallbacks } from "./WorkbenchBrowseResultController";
import type { WorkbenchHardReloadOptions } from "./WorkbenchOrchestratorReloadController";
import type WorkbenchThreadTransitionCoordinator from "./WorkbenchThreadTransitionCoordinator";
import type { WorkbenchHarnessRuntimePort } from "./WorkbenchHarnessController";
import type { OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";

export const ORCHESTRATOR_PROCESS_REQUIRED_REGISTRATIONS = [
  "browseExecution",
  "codexAppServer",
  "codexBridge",
  "harnesses",
  "modules",
  "openCodeBridge",
  "orchestratorHttp",
  "projectCatalog",
  "reloadController",
  "subagents",
  "threadState",
] as const satisfies readonly (keyof OrchestratorRuntimeObjects)[];

export interface OrchestratorProcessContext {
  advanceMcpGeneration(): void;
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
  executeReloadScopes(scopes: OrchestratorReloadScope[]): Promise<void>;
  getReloadScopeCatalog(): readonly OrchestratorReloadScopeDescriptor[];
  getReloadScopesForPaths(paths: readonly string[]): OrchestratorReloadScope[];
  hardReload: WorkbenchHardReloadOptions;
  harnessPorts: Record<WorkbenchHarness, WorkbenchHarnessRuntimePort>;
  installSubagentRelationship(record: WorkbenchSubagentRelationship): Promise<void>;
  legacyMigrationProjectRoot: string;
  localOrchestratorOrigin: string;
  localWorkbenchOrigin: string;
  nextDevHealthOptions: NextDevHealthSupervisorOptions;
  notifyReloadEligibilityChanged(): void;
  notifyThreadLifecycle(projectId: string, entry: WorkbenchThreadSidebarEntry): void;
  onCodexBridgeActivated(restartedAppServer: boolean): Promise<void>;
  onCodexBridgeReady(bridge: CodexStdioBridge): Promise<void>;
  onCodexBridgeUnavailable(restartingAppServer: boolean): void;
  onCodexFatalExit(reason: string, bridge: CodexStdioBridge | null): void;
  openCodeAppServerOptions: OpenCodeAppServerOptions;
  openCodeBridgeOptions: Omit<OpenCodeBridgeOptions, "appServer" | "getReloadableModules" | "initialState">;
  publishThreadState(connectionId: string, snapshot: WorkbenchThreadStateSnapshot): void;
  refreshWorkbenchPromptFiles(): Promise<void>;
  reloadClient(): Promise<void>;
  requestOrchestratorReload(body: Record<string, unknown>, signal: AbortSignal): Promise<Response>;
  threadTransitions: WorkbenchThreadTransitionCoordinator;
}
