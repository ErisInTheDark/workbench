/*
 * Exports:
 * - OrchestratorReloadableModules: helper modules consumed dynamically by persistent provider bridges. Keywords: bridge, module, reload.
 * - OrchestratorFeatures/OrchestratorFeatureContext/OrchestratorProviderNotification: typed stable-to-reloadable feature contract. Keywords: registry, ports, lifecycle.
 * - createWorktreeGitTransitions: adapt resolved worktree paths into canonical keys for the persistent transition coordinator. Keywords: git, worktree, transition, reload.
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
import WorkbenchAgentMcpController from "./WorkbenchAgentMcpController";
import WorkbenchBridgeRequestController from "./WorkbenchBridgeRequestController";
import WorkbenchGitArcFeature from "./WorkbenchGitArcFeature";
import WorkbenchHarnessController, { type WorkbenchHarnessAdapter, type WorkbenchHarnessReloadScope, type WorkbenchHarnessRuntimePort } from "./WorkbenchHarnessController";
import WorkbenchLegacyMigrationSourceController, { readLegacyMigrationSourceConfig } from "./WorkbenchLegacyMigrationSourceController";
import WorkbenchOrchestratorHttpRouter from "./WorkbenchOrchestratorHttpRouter";
import WorkbenchProjectCatalogController from "./WorkbenchProjectCatalogController";
import WorkbenchProjectSnapshotController from "./WorkbenchProjectSnapshotController";
import WorkbenchThreadGitFeature from "./WorkbenchThreadGitFeature";
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
  harnessPorts: Record<WorkbenchHarness, WorkbenchHarnessRuntimePort>;
  legacyMigrationProjectRoot: string;
  localOrchestratorOrigin: string;
  localWorkbenchOrigin: string;
  nextDevHealthOptions: NextDevHealthSupervisorOptions;
  notifyReloadEligibilityChanged(): void;
  notifyThreadLifecycle(projectId: string, entry: import("../lib/workbench/thread/thread-state").WorkbenchThreadSidebarEntry): void;
  publishThreadState(connectionId: string, snapshot: WorkbenchThreadStateSnapshot): void;
  requestOrchestratorReload(body: Record<string, unknown>, signal: AbortSignal): Promise<Response>;
  requestSubagent(request: JsonRpcRequest): Promise<JsonRpcResponse>;
  subagentStore: { list(options: { projectId: string }): Promise<{ subagents: Array<{ createdAt: number; cwd: string; directSubagentIndex: number; harness: WorkbenchHarness; name: string; parentThreadId: string; profileId: string; profileName: string; projectId: string; threadId: string; title: string; updatedAt: number }> }> };
  threadTransitions: WorkbenchThreadTransitionCoordinator;
}

export interface OrchestratorFeatures {
  agentCommand: WorkbenchAgentCommandController;
  bridgeRequest: WorkbenchBridgeRequestController;
  browseSessionCleanup: BrowseSessionCleanupSupervisor;
  codexHealth: CodexHealthMonitor;
  gitArc: WorkbenchGitArcFeature;
  harnesses: WorkbenchHarnessController;
  legacyMigrationSource: WorkbenchLegacyMigrationSourceController;
  mcp: WorkbenchAgentMcpController;
  modules: OrchestratorReloadableModules;
  nextDevHealth: NextDevHealthSupervisor;
  orchestratorHttp: WorkbenchOrchestratorHttpRouter;
  projectCatalog: WorkbenchProjectCatalogController;
  projectSnapshot: WorkbenchProjectSnapshotController;
  threadGit: WorkbenchThreadGitFeature;
  threadState: WorkbenchThreadStateFeature;
}

function createModules(): OrchestratorReloadableModules {
  return { copilotThreadState, opencodeLiveThreadState, opencodeThreadState, opencodeWorkbenchInstructions, project, threadBootstrap, workbenchLibrary, workbenchPromptFiles };
}

function requireTurnRecovery(port: WorkbenchHarnessRuntimePort, harness: WorkbenchHarness): WorkbenchHarnessAdapter["recovery"] {
  if (!port.observeRecoveryNotification || !port.observeRecoveryRequest || !port.resumeThread) {
    throw new Error(`Workbench harness ${harness} is missing its declared turn-recovery port.`);
  }
  return {
    kind: "turn",
    observeNotification: port.observeRecoveryNotification,
    observeRequest: port.observeRecoveryRequest,
    resumeThread: port.resumeThread,
  };
}

function requireScopedReload(
  port: WorkbenchHarnessRuntimePort,
  harness: WorkbenchHarness,
  scopes: readonly WorkbenchHarnessReloadScope[],
): WorkbenchHarnessAdapter["reload"] {
  if (!port.executeReload) throw new Error(`Workbench harness ${harness} is missing its declared reload executor.`);
  return { execute: port.executeReload, kind: "scoped", scopes };
}

function createHarnessAdapters(ports: Record<WorkbenchHarness, WorkbenchHarnessRuntimePort>): WorkbenchHarnessAdapter[] {
  return [
    {
      browse: ports.codex,
      browser: ports.codex,
      id: "codex",
      internal: ports.codex,
      recovery: requireTurnRecovery(ports.codex, "codex"),
      reload: requireScopedReload(ports.codex, "codex", [{
        refreshWorkbenchPromptFiles: true,
        reloadOrchestratorLogic: false,
        scope: "codex-bridge",
      }]),
      serverMethods: [
        "workbench/composerProfiles/read",
        "workbench/composerProfiles/importLegacy",
        "workbench/composerProfiles/mutate",
        "thread/context/read",
        "thread/name/set",
        "workbench/notification/broadcast",
      ],
    },
    {
      browse: ports.copilot,
      browser: ports.copilot,
      id: "copilot",
      internal: ports.copilot,
      recovery: { kind: "none" },
      reload: { kind: "none" },
      serverMethods: ["thread/name/set"],
    },
    {
      browse: ports.opencode,
      browser: ports.opencode,
      id: "opencode",
      internal: ports.opencode,
      recovery: requireTurnRecovery(ports.opencode, "opencode"),
      reload: requireScopedReload(ports.opencode, "opencode", [
        { refreshWorkbenchPromptFiles: true, reloadOrchestratorLogic: false, scope: "opencode-bridge" },
        { refreshWorkbenchPromptFiles: true, reloadOrchestratorLogic: true, scope: "opencode-server" },
      ]),
      serverMethods: ["thread/name/set"],
    },
  ];
}

export function createWorktreeGitTransitions(transitions: Pick<WorkbenchThreadTransitionCoordinator, "run">) {
  return {
    run: async <TValue>(worktreePath: string, operation: () => Promise<TValue>) => {
      const normalized = worktreePath.trim().replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
      if (!normalized) throw new Error("A worktree path is required for Git transition coordination.");
      return await transitions.run(`git-worktree\0${normalized}`, operation);
    },
  };
}

export function createOrchestratorFeatureGeneration(
  context: OrchestratorFeatureContext,
  lease: OrchestratorFeatureLease,
): OrchestratorFeatureGeneration<OrchestratorFeatures, OrchestratorProviderNotification> {
  const modules = createModules();
  const harnesses = new WorkbenchHarnessController(createHarnessAdapters(context.harnessPorts));
  const projectCatalog = new WorkbenchProjectCatalogController();
  const projectSnapshot = new WorkbenchProjectSnapshotController();
  const worktreeGitTransitions = createWorktreeGitTransitions(context.threadTransitions);
  let threadState: WorkbenchThreadStateFeature | null = null;
  const gitArc = new WorkbenchGitArcFeature({
    getThreadClaimContext: async (projectId, harness, threadId) => {
      if (!threadState) throw new Error("Thread state is not ready for Git arc ownership.");
      return await threadState.controller.getThreadClaimContext(projectId, harness, threadId);
    },
    onReloadEligibilityChanged: context.notifyReloadEligibilityChanged,
    refreshThreadGitArcState: async (projectId, harness, threadId) => {
      if (!threadState) throw new Error("Thread state is not ready for Git arc publication.");
      await threadState.controller.refreshGitArcState(projectId, harness, threadId);
    },
    reloadScopeProjectRoot: context.legacyMigrationProjectRoot,
    resolveProjectFromCwd: async (cwd) => await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Git arc" }),
    transitions: worktreeGitTransitions,
  });
  const threadGit = new WorkbenchThreadGitFeature({
    resolveProjectFromCwd: async (cwd) => await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Thread Git" }),
    transitions: worktreeGitTransitions,
  });
  threadState = new WorkbenchThreadStateFeature({
    getProjectCatalog: () => projectCatalog.getCurrentSnapshot(),
    gitArcs: gitArc,
    listSubagents: (projectId) => context.subagentStore.list({ projectId }),
    log: (message) => log("thread-state-ws", message),
    projectState: projectSnapshot,
    publish: (connectionId, snapshot) => { if (lease.isCurrent()) context.publishThreadState(connectionId, snapshot); },
    harnesses,
    resolveProjectById: (projectId) => projectCatalog.resolveProjectById(projectId),
    resolveProjectFromCwd: (cwd, options) => projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, options),
    storageRoot: context.legacyMigrationProjectRoot,
    transitions: worktreeGitTransitions,
  });
  threadState.controller.subscribe(context.notifyThreadLifecycle);
  const { allowedProjectIds, capability } = readLegacyMigrationSourceConfig(context.legacyMigrationProjectRoot);
  const legacyMigrationSource = new WorkbenchLegacyMigrationSourceController({
    allowedProjectIds, capability, requestHarness: (harness, request) => harnesses.request(harness, request),
    resolveProjectFromCwd: async (cwd) => await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Legacy migration source" }),
  });
  const bridgeRequest = new WorkbenchBridgeRequestController({ harnesses });
  const agentCommand = new WorkbenchAgentCommandController(context.localWorkbenchOrigin, context.localOrchestratorOrigin, {
    executeBrowseRequest: context.executeBrowseRequest,
    executeGitArcRequest: async (body) => await gitArc.executeRequest(body),
    executeSessionRequest: context.executeBrowseSessionRequest,
    requestOrchestratorReload: context.requestOrchestratorReload,
    requestSubagent: async (request) => request.method?.startsWith("workbench/thread/")
      ? await threadState.handleManagedThreadRequest(request)
      : await context.requestSubagent(request),
  });
  const mcp = new WorkbenchAgentMcpController({
    executeCommand: async (request, signal) => await agentCommand.executeStructuredRequest(request, signal),
    orchestratorOrigin: context.localOrchestratorOrigin,
    requestCodex: context.requestSubagent,
  });
  const orchestratorHttp = new WorkbenchOrchestratorHttpRouter({
    agentCommand,
    bridgeRequest,
    gitArc,
    legacyMigrationSource,
    mcp,
    projectCatalog,
    projectSnapshot,
    threadGit,
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
  const features: OrchestratorFeatures = { agentCommand, bridgeRequest, browseSessionCleanup, codexHealth, gitArc, harnesses, legacyMigrationSource, mcp, modules, nextDevHealth, orchestratorHttp, projectCatalog, projectSnapshot, threadGit, threadState };
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
