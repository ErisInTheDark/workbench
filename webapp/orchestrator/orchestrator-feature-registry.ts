/*
 * Exports:
 * - OrchestratorReloadableModules: helper modules consumed dynamically by persistent provider bridges. Keywords: bridge, module, reload.
 * - OrchestratorFeatures/OrchestratorFeatureContext/OrchestratorProviderNotification: typed stable-to-reloadable feature contract. Keywords: registry, ports, lifecycle.
 * - createOrchestratorFeatureGeneration: construct the ordered reloadable feature graph and own start/disposal/notification dispatch. Keywords: feature generation, dependency order.
 */
import * as project from "../lib/project";
import * as threadBootstrap from "../lib/thread-bootstrap";
import type { WorkbenchHarness } from "../lib/types";
import type { WorkbenchThreadStateSnapshot } from "../lib/workbench/thread/thread-state";
import * as workbenchPromptFiles from "../lib/workbench/instructions/WorkbenchPromptFiles";
import * as workbenchLibrary from "../lib/workbench-library";
import BrowseSessionCleanupSupervisor, { type BrowseSessionCleanupSupervisorOptions } from "./BrowseSessionCleanupSupervisor";
import CodexHealthMonitor, { type CodexHealthMonitorOptions } from "./CodexHealthMonitor";
import NextDevHealthSupervisor, { type NextDevHealthSupervisorOptions } from "./NextDevHealthSupervisor";
import type { OrchestratorFeatureGeneration, OrchestratorFeatureLease } from "./OrchestratorFeatureHost";
import WorkbenchAgentCommandController from "./WorkbenchAgentCommandController";
import WorkbenchBridgeRequestController from "./WorkbenchBridgeRequestController";
import WorkbenchLegacyMigrationSourceController, { readLegacyMigrationSourceConfig } from "./WorkbenchLegacyMigrationSourceController";
import WorkbenchOrchestratorHttpRouter from "./WorkbenchOrchestratorHttpRouter";
import WorkbenchProjectCatalogController from "./WorkbenchProjectCatalogController";
import WorkbenchProjectSnapshotController from "./WorkbenchProjectSnapshotController";
import WorkbenchThreadStateFeature from "./WorkbenchThreadStateFeature";
import type WorkbenchThreadTransitionCoordinator from "./WorkbenchThreadTransitionCoordinator";
import type { HarnessKind, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import * as copilotThreadState from "./copilot-thread-state";
import * as opencodeLiveThreadState from "./opencode-live-thread-state";
import * as opencodeThreadState from "./opencode-thread-state";
import * as opencodeWorkbenchInstructions from "./opencode-workbench-instructions";
import { log } from "./process-helpers";

export type OrchestratorReloadableModules = {
  copilotThreadState: Pick<typeof copilotThreadState, "applyCopilotEvent" | "cloneThread" | "createThreadState" | "formatPromptFromInput" | "INITIALIZE_RESULT" | "metadataToThread">;
  opencodeLiveThreadState: Pick<typeof opencodeLiveThreadState, "applyOpenCodeLiveEvent" | "createOpenCodeLiveThreadState">;
  opencodeThreadState: Pick<typeof opencodeThreadState, "cloneThread" | "createOpenCodeLegacyPermissionRequest" | "createOpenCodePermissionRequest" | "createOpenCodeQuestionRequest" | "EMPTY_OPENCODE_RATE_LIMITS" | "formatPromptFromInput" | "mapOpenCodeModelsToWorkbenchOptions" | "OPENCODE_INITIALIZE_RESULT" | "opencodeSessionToThread">;
  opencodeWorkbenchInstructions: Pick<typeof opencodeWorkbenchInstructions, "buildOpenCodeWorkbenchSystemPrompt" | "ensureOpenCodeWorkbenchConfigDirectory">;
  project: Pick<typeof project, "isPathWithinRoot" | "readUserInvocableAgentDefinition" | "resolveProjectRoot">;
  threadBootstrap: Pick<typeof threadBootstrap, "buildThreadTitleBootstrapInstructions" | "normalizeThreadTitle">;
  workbenchLibrary: Pick<typeof workbenchLibrary, "buildWorkbenchLibraryBootstrapInstructions">;
  workbenchPromptFiles: Pick<typeof workbenchPromptFiles, "buildWorkbenchPromptInstructions" | "buildWorkbenchThreadUtilityDeveloperInstructions" | "filterWorkbenchInstructionContent" | "listWorkbenchInstructionMechanics" | "ensureWorkbenchPromptFiles">;
};

export interface OrchestratorProviderNotification { harness: HarnessKind; notification: JsonRpcNotification }

export interface OrchestratorFeatureContext {
  browseCleanupOptions: BrowseSessionCleanupSupervisorOptions;
  codexHealthOptions: CodexHealthMonitorOptions;
  executeBrowseRequest(body: Buffer, signal: AbortSignal): Promise<Response>;
  executeBrowseSessionRequest(request: { body: Buffer; method: string; url: string }, signal: AbortSignal): Promise<Response>;
  getCodexReadiness(): Promise<void> | null;
  legacyMigrationProjectRoot: string;
  localOrchestratorOrigin: string;
  localWorkbenchOrigin: string;
  nextDevHealthOptions: NextDevHealthSupervisorOptions;
  notifyThreadLifecycle(projectId: string, entry: import("../lib/workbench/thread/thread-state").WorkbenchThreadSidebarEntry): void;
  publishThreadState(connectionId: string, snapshot: WorkbenchThreadStateSnapshot): void;
  requestHarness(harness: HarnessKind, request: JsonRpcRequest): Promise<JsonRpcResponse>;
  requestSubagent(request: JsonRpcRequest): Promise<JsonRpcResponse>;
  subagentStore: { list(options: { projectId: string }): Promise<{ subagents: Array<{ createdAt: number; cwd: string; directSubagentIndex: number; harness: WorkbenchHarness; name: string; parentThreadId: string; profileId: string; profileName: string; projectId: string; threadId: string; title: string; updatedAt: number }> }> };
  threadTransitions: WorkbenchThreadTransitionCoordinator;
}

export interface OrchestratorFeatures {
  agentCommand: WorkbenchAgentCommandController;
  bridgeRequest: WorkbenchBridgeRequestController;
  browseSessionCleanup: BrowseSessionCleanupSupervisor;
  codexHealth: CodexHealthMonitor;
  legacyMigrationSource: WorkbenchLegacyMigrationSourceController;
  modules: OrchestratorReloadableModules;
  nextDevHealth: NextDevHealthSupervisor;
  orchestratorHttp: WorkbenchOrchestratorHttpRouter;
  projectCatalog: WorkbenchProjectCatalogController;
  projectSnapshot: WorkbenchProjectSnapshotController;
  threadState: WorkbenchThreadStateFeature;
}

function createModules(): OrchestratorReloadableModules {
  return { copilotThreadState, opencodeLiveThreadState, opencodeThreadState, opencodeWorkbenchInstructions, project, threadBootstrap, workbenchLibrary, workbenchPromptFiles };
}

export function createOrchestratorFeatureGeneration(
  context: OrchestratorFeatureContext,
  lease: OrchestratorFeatureLease,
): OrchestratorFeatureGeneration<OrchestratorFeatures, OrchestratorProviderNotification> {
  const modules = createModules();
  const projectCatalog = new WorkbenchProjectCatalogController();
  const projectSnapshot = new WorkbenchProjectSnapshotController();
  const threadState = new WorkbenchThreadStateFeature({
    getProjectCatalog: () => projectCatalog.getCurrentSnapshot(),
    listSubagents: (projectId) => context.subagentStore.list({ projectId }),
    log: (message) => log("thread-state-ws", message),
    projectState: projectSnapshot,
    publish: (connectionId, snapshot) => { if (lease.isCurrent()) context.publishThreadState(connectionId, snapshot); },
    requestHarness: context.requestHarness,
    resolveProjectById: (projectId) => projectCatalog.resolveProjectById(projectId),
    resolveProjectFromCwd: (cwd, options) => projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, options),
    storageRoot: context.legacyMigrationProjectRoot,
  });
  threadState.controller.subscribe(context.notifyThreadLifecycle);
  const { allowedProjectIds, capability } = readLegacyMigrationSourceConfig(context.legacyMigrationProjectRoot);
  const legacyMigrationSource = new WorkbenchLegacyMigrationSourceController({
    allowedProjectIds, capability, requestHarness: context.requestHarness,
    resolveProjectFromCwd: async (cwd) => await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Legacy migration source" }),
  });
  const bridgeRequest = new WorkbenchBridgeRequestController({ requestHarness: context.requestHarness });
  const agentCommand = new WorkbenchAgentCommandController(context.localWorkbenchOrigin, context.localOrchestratorOrigin, {
    executeBrowseRequest: context.executeBrowseRequest,
    executeSessionRequest: context.executeBrowseSessionRequest,
    requestSubagent: async (request) => request.method?.startsWith("workbench/thread/")
      ? await threadState.handleManagedThreadRequest(request)
      : await context.requestSubagent(request),
  });
  const orchestratorHttp = new WorkbenchOrchestratorHttpRouter({
    agentCommand,
    bridgeRequest,
    legacyMigrationSource,
    projectCatalog,
    projectSnapshot,
  });
  const browseSessionCleanup = new BrowseSessionCleanupSupervisor({
    ...context.browseCleanupOptions,
    cleanupStaleInactiveSessions: async (options) => {
      if (!lease.isCurrent()) {
        browseSessionCleanup.dispose();
        return;
      }
      await context.browseCleanupOptions.cleanupStaleInactiveSessions(options);
    },
  });
  const nextDevHealth = new NextDevHealthSupervisor({
    ...context.nextDevHealthOptions,
    isShuttingDown: () => !lease.isCurrent() || context.nextDevHealthOptions.isShuttingDown(),
    restartNextDev: (reason) => lease.isCurrent() && context.nextDevHealthOptions.restartNextDev(reason),
  });
  const codexHealth = new CodexHealthMonitor({
    ...context.codexHealthOptions,
    isProbeAllowed: () => lease.isCurrent() && context.codexHealthOptions.isProbeAllowed(),
    isShuttingDown: () => !lease.isCurrent() || context.codexHealthOptions.isShuttingDown(),
    requestRecovery: (reason) => { if (lease.isCurrent()) context.codexHealthOptions.requestRecovery(reason); },
  });
  const features: OrchestratorFeatures = { agentCommand, bridgeRequest, browseSessionCleanup, codexHealth, legacyMigrationSource, modules, nextDevHealth, orchestratorHttp, projectCatalog, projectSnapshot, threadState };
  return {
    dispose: async () => {
      codexHealth.dispose();
      nextDevHealth.dispose();
      browseSessionCleanup.dispose();
      await threadState.dispose();
      projectSnapshot.dispose();
      projectCatalog.dispose();
    },
    get: (key) => features[key],
    observeProviderNotification: async ({ harness, notification }) => {
      if (lease.isCurrent()) await threadState.observeProviderNotification(harness, notification);
    },
    start: async () => {
      await projectCatalog.ensureLoaded();
      browseSessionCleanup.start();
      nextDevHealth.start();
      const readiness = context.getCodexReadiness();
      if (readiness) void readiness.then(() => { if (lease.isCurrent()) codexHealth.start({ armed: true }); }).catch(() => undefined);
    },
  };
}
