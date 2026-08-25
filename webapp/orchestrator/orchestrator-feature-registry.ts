/*
 * Exports:
 * - OrchestratorReloadableModules: helper modules consumed dynamically by persistent provider bridges. Keywords: bridge, module, reload.
 * - OrchestratorProviderNotification: provider event routed into the core node. Keywords: provider, notification, thread state.
 * - OrchestratorFeatureContext: stable process ports supplied to graph node factories. Keywords: registry, ports, lifecycle.
 * - OrchestratorFeatures: feature-key contract owned across graph nodes. Keywords: ownership, lookup, graph.
 * - createWorktreeGitTransitions: adapt resolved worktree paths into canonical keys for the persistent transition coordinator. Keywords: git, worktree, transition, reload.
 * - createOrchestratorFeatureNodes: declare the complete reloadable feature graph. Keywords: node, scope, dependency, lifecycle.
 */
import * as project from "../lib/project";
import * as threadBootstrap from "../lib/thread-bootstrap";
import type { WorkbenchHarness, WorkbenchSubagentRelationship } from "../lib/types";
import type { WorkbenchThreadSidebarEntry, WorkbenchThreadStateRequest, WorkbenchThreadStateSnapshot } from "../lib/workbench/thread/thread-state";
import * as workbenchPromptFiles from "../lib/workbench/instructions/WorkbenchPromptFiles";
import * as workbenchLibrary from "../lib/workbench-library";
import BrowseSessionCleanupSupervisor, { type BrowseSessionCleanupSupervisorOptions } from "./BrowseSessionCleanupSupervisor";
import type { WorkbenchBrowseProjectIdResolver, WorkbenchBrowseProjectResolver } from "../lib/workbench/browse/WorkbenchBrowseRuntime";
import type CodexAppServer from "./CodexAppServer";
import type CodexStdioBridge from "./CodexStdioBridge";
import type { CodexStdioBridgeOptions, CodexStdioBridgeReloadState } from "./CodexStdioBridge";
import CodexHealthMonitor, { type CodexHealthMonitorOptions } from "./CodexHealthMonitor";
import NextDevHealthSupervisor, { type NextDevHealthSupervisorOptions } from "./NextDevHealthSupervisor";
import type { OrchestratorFeatureLease, OrchestratorFeatureNodeDefinition } from "./OrchestratorFeatureHost";
import type OpenCodeAppServer from "./OpenCodeAppServer";
import type { OpenCodeAppServerOptions } from "./OpenCodeAppServer";
import type { OpenCodeBridge, OpenCodeBridgeOptions, OpenCodeBridgeState } from "./opencode-bridge";
import type WorkbenchBrowseController from "./WorkbenchBrowseController";
import type { WorkbenchBrowseResultCallbacks } from "./WorkbenchBrowseResultController";
import { createOrchestratorProviderFeatureNodes } from "./orchestrator-provider-feature-nodes";
import { createOrchestratorRuntimeFeatureNodes, PROCESS_FEATURE_NODE_ID } from "./orchestrator-runtime-feature-nodes";
import WorkbenchAgentCommandController from "./WorkbenchAgentCommandController";
import WorkbenchAgentMcpController from "./WorkbenchAgentMcpController";
import WorkbenchBridgeRequestController from "./WorkbenchBridgeRequestController";
import WorkbenchCoreFeature, { WORKBENCH_CORE_FEATURE_KEYS, WORKBENCH_CORE_FEATURE_NODE_ID } from "./WorkbenchCoreFeature";
import WorkbenchGitArcFeature from "./WorkbenchGitArcFeature";
import WorkbenchHarnessController, { type WorkbenchHarnessAdapter, type WorkbenchHarnessRuntimePort } from "./WorkbenchHarnessController";
import WorkbenchLegacyMigrationSourceController, { readLegacyMigrationSourceConfig } from "./WorkbenchLegacyMigrationSourceController";
import WorkbenchOrchestratorHttpRouter from "./WorkbenchOrchestratorHttpRouter";
import WorkbenchProjectCatalogController from "./WorkbenchProjectCatalogController";
import WorkbenchProjectSnapshotController from "./WorkbenchProjectSnapshotController";
import WorkbenchSubagentFeature from "./WorkbenchSubagentFeature";
import WorkbenchThreadGitFeature from "./WorkbenchThreadGitFeature";
import WorkbenchThreadStateFeature from "./WorkbenchThreadStateFeature";
import type WorkbenchThreadTransitionCoordinator from "./WorkbenchThreadTransitionCoordinator";
import type { HarnessKind, JsonRpcNotification, JsonRpcRequest } from "./bridge-types";
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
  advanceMcpGeneration(): void;
  browseCleanupOptions: BrowseSessionCleanupSupervisorOptions;
  browseProjectResolvers: {
    resolveProjectById: WorkbenchBrowseProjectIdResolver;
    resolveProjectFromCwd: WorkbenchBrowseProjectResolver;
  };
  browseResultCallbacks: WorkbenchBrowseResultCallbacks;
  codexHealthOptions: CodexHealthMonitorOptions;
  codexBridgeUrl: string;
  executeBrowseRequest(body: Buffer, signal: AbortSignal): Promise<Response>;
  executeBrowseSessionRequest(request: { body: Buffer; method: string; url: string }, signal: AbortSignal): Promise<Response>;
  codexAppServerOptions: Omit<ConstructorParameters<typeof CodexAppServer>[0], "onFatalExit" | "onMessage">;
  createCodexBridgeOptions(appServer: CodexAppServer, initialState?: CodexStdioBridgeReloadState): CodexStdioBridgeOptions;
  openCodeBridgeOptions: Omit<OpenCodeBridgeOptions, "appServer" | "getReloadableModules" | "initialState">;
  harnessPorts: Record<WorkbenchHarness, WorkbenchHarnessRuntimePort>;
  installSubagentRelationship(record: WorkbenchSubagentRelationship): Promise<void>;
  legacyMigrationProjectRoot: string;
  localOrchestratorOrigin: string;
  localWorkbenchOrigin: string;
  nextDevHealthOptions: NextDevHealthSupervisorOptions;
  notifyReloadEligibilityChanged(): void;
  notifyThreadLifecycle(projectId: string, entry: import("../lib/workbench/thread/thread-state").WorkbenchThreadSidebarEntry): void;
  publishThreadState(connectionId: string, snapshot: WorkbenchThreadStateSnapshot): void;
  refreshWorkbenchPromptFiles(): Promise<void>;
  onCodexFatalExit(reason: string, bridge: CodexStdioBridge | null): void;
  onCodexBridgeActivated(restartedAppServer: boolean): Promise<void>;
  onCodexBridgeReady(bridge: CodexStdioBridge): Promise<void>;
  onCodexBridgeUnavailable(restartingAppServer: boolean): void;
  openCodeAppServerOptions: OpenCodeAppServerOptions;
  reloadClient(): Promise<void>;
  requestOrchestratorReload(body: Record<string, unknown>, signal: AbortSignal): Promise<Response>;
  threadTransitions: WorkbenchThreadTransitionCoordinator;
}

export interface OrchestratorCodexAppServerRuntime {
  appServer: CodexAppServer;
  attachBridge(bridge: CodexStdioBridge): void;
  detachBridge(bridge: CodexStdioBridge): Promise<CodexStdioBridgeReloadState>;
  isTransitioning(): boolean;
  isAvailable(): boolean;
}

export interface OrchestratorBrowseExecution {
  cleanupStaleInactiveSessions(options: Parameters<WorkbenchBrowseController["cleanupStaleInactiveSessions"]>[0]): Promise<void>;
  executeBrowseRequest(body: Buffer, signal: AbortSignal): Promise<Response>;
  executeSessionRequest(request: { body: Buffer; method: string; url: string }, signal: AbortSignal): Promise<Response>;
  handleBrowseHttpRequest: WorkbenchBrowseController["handleBrowseHttpRequest"];
  handleSessionsHttpRequest: WorkbenchBrowseController["handleSessionsHttpRequest"];
  initialize(): Promise<void>;
}

export interface OrchestratorFeatures {
  agentCommand: WorkbenchAgentCommandController;
  bridgeRequest: WorkbenchBridgeRequestController;
  browseExecution: OrchestratorBrowseExecution;
  browseSessionCleanup: BrowseSessionCleanupSupervisor;
  codexAppServer: OrchestratorCodexAppServerRuntime;
  codexBridge: CodexStdioBridge;
  codexHealth: CodexHealthMonitor;
  gitArc: WorkbenchGitArcFeature;
  harnesses: WorkbenchHarnessController;
  legacyMigrationSource: WorkbenchLegacyMigrationSourceController;
  mcp: WorkbenchAgentMcpController;
  modules: OrchestratorReloadableModules;
  nextDevHealth: NextDevHealthSupervisor;
  openCodeAppServer: OpenCodeAppServer;
  openCodeBridge: OpenCodeBridge;
  orchestratorHttp: WorkbenchOrchestratorHttpRouter;
  projectCatalog: WorkbenchProjectCatalogController;
  projectSnapshot: WorkbenchProjectSnapshotController;
  subagents: WorkbenchSubagentFeature;
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

function createHarnessAdapters(ports: Record<WorkbenchHarness, WorkbenchHarnessRuntimePort>): WorkbenchHarnessAdapter[] {
  return [
    {
      browse: ports.codex,
      browser: ports.codex,
      id: "codex",
      internal: ports.codex,
      recovery: requireTurnRecovery(ports.codex, "codex"),
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
      serverMethods: ["thread/name/set"],
    },
    {
      browse: ports.opencode,
      browser: ports.opencode,
      id: "opencode",
      internal: ports.opencode,
      recovery: requireTurnRecovery(ports.opencode, "opencode"),
      serverMethods: ["thread/name/set"],
    },
  ];
}

export function createWorktreeGitTransitions(transitions: Pick<WorkbenchThreadTransitionCoordinator, "run">) {
  const key = (worktreePath: string) => {
    const normalized = worktreePath.trim().replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
    if (!normalized) throw new Error("A worktree path is required for Git transition coordination.");
    return `git-worktree\0${normalized}`;
  };
  return {
    run: async <TValue>(worktreePath: string, operation: () => Promise<TValue>) => {
      return await transitions.run(key(worktreePath), operation);
    },
    runMany: async <TValue>(worktreePaths: readonly string[], operation: () => Promise<TValue>) => {
      const keys = [...new Set(worktreePaths.map(key))].sort((left, right) => left.localeCompare(right));
      const coordinator = transitions as Pick<WorkbenchThreadTransitionCoordinator, "run" | "runMany">;
      if (coordinator.runMany) return await coordinator.runMany(keys, operation);
      const acquire = async (index: number): Promise<TValue> => index >= keys.length
        ? await operation()
        : await transitions.run(keys[index]!, async () => await acquire(index + 1));
      return await acquire(0);
    },
  };
}

function createWorkbenchCoreFeature(
  context: OrchestratorFeatureContext,
  lease: OrchestratorFeatureLease,
) {
  const modules = createModules();
  const harnesses = new WorkbenchHarnessController(createHarnessAdapters(context.harnessPorts));
  const projectCatalog = new WorkbenchProjectCatalogController();
  const projectSnapshot = new WorkbenchProjectSnapshotController();
  const worktreeGitTransitions = createWorktreeGitTransitions(context.threadTransitions);
  let threadState: WorkbenchThreadStateFeature | null = null;
  const requireThreadState = () => {
    if (!threadState) throw new Error("Thread state is not ready for subagent lifecycle projection.");
    return threadState;
  };
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
  const subagents = new WorkbenchSubagentFeature({
    bridgeUrl: context.codexBridgeUrl,
    onRelationshipCommitted: context.installSubagentRelationship,
    resolveProjectFromCwd: async (cwd, options) => await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, options),
    storageRoot: context.legacyMigrationProjectRoot,
    threadState: {
      getEntry: async (projectId, harness, threadId) => {
        const snapshot = await requireThreadState().controller.getSnapshot(projectId);
        return snapshot.entries.find((entry) => entry.entryKind === "subagent" && entry.identity.harness === harness && entry.identity.threadId === threadId) ?? null;
      },
      mutate: async (request: WorkbenchThreadStateRequest) => {
        const response = await requireThreadState().controller.handleRequest("subagent-controller", request);
        if ("error" in response) throw new Error(response.error.message);
      },
      subscribe: (listener: (projectId: string, entry: WorkbenchThreadSidebarEntry) => void) => requireThreadState().controller.subscribe(listener),
    },
  });
  threadState = new WorkbenchThreadStateFeature({
    getProjectCatalog: () => projectCatalog.getCurrentSnapshot(),
    gitArcs: gitArc,
    listSubagents: (projectId) => subagents.listRelationships(projectId),
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
    checkApplyPatchClaims: async ({ cwd, harness, paths, threadId }) => await gitArc.checkActiveClaimPaths(cwd, harness, threadId, paths),
    executeBrowseRequest: context.executeBrowseRequest,
    executeGitArcRequest: async (body) => await gitArc.executeRequest(body),
    executeSessionRequest: context.executeBrowseSessionRequest,
    requestOrchestratorReload: context.requestOrchestratorReload,
    requestSubagent: async (request) => request.method?.startsWith("workbench/thread/")
      ? await threadState.handleManagedThreadRequest(request)
      : await subagents.handleRequest(request),
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
  const features: Pick<OrchestratorFeatures, typeof WORKBENCH_CORE_FEATURE_KEYS[number]> = { agentCommand, bridgeRequest, browseSessionCleanup, codexHealth, gitArc, harnesses, legacyMigrationSource, modules, nextDevHealth, projectCatalog, projectSnapshot, subagents, threadGit, threadState };
  return new WorkbenchCoreFeature({
    beginRuntimeDrain: () => { subagents.beginRuntimeDrain(); },
    dispose: async (reportPhase = () => undefined) => {
      reportPhase("codex health disposal");
      codexHealth.dispose();
      reportPhase("next-dev health disposal");
      nextDevHealth.dispose();
      reportPhase("browse session cleanup disposal");
      browseSessionCleanup.dispose();
      reportPhase("subagent disposal");
      subagents.dispose();
      reportPhase("thread-state disposal");
      await threadState.dispose();
      reportPhase("project snapshot disposal");
      projectSnapshot.dispose();
      reportPhase("project catalog disposal");
      projectCatalog.dispose();
    },
    features,
    observeProviderNotification: async ({ harness, notification }) => {
      if (lease.isCurrent()) await threadState.observeProviderNotification(harness, notification);
    },
    start: async () => {
      await projectCatalog.ensureLoaded();
      await subagents.start();
      browseSessionCleanup.start();
      nextDevHealth.start();
    },
  });
}

export function createOrchestratorFeatureNodes(
  context: OrchestratorFeatureContext,
): readonly OrchestratorFeatureNodeDefinition<OrchestratorFeatureContext, OrchestratorFeatures, OrchestratorProviderNotification>[] {
  return [
    ...createOrchestratorRuntimeFeatureNodes(context).slice(0, 1),
    {
      create: (_context, { lease }) => createWorkbenchCoreFeature(context, lease),
      dependencies: [PROCESS_FEATURE_NODE_ID],
      featureKeys: WORKBENCH_CORE_FEATURE_KEYS,
      id: WORKBENCH_CORE_FEATURE_NODE_ID,
      lifecycle: "atomic",
      scope: "server:core",
    },
    {
      create: (_context, { get, mode }) => {
        const agentCommand = get("agentCommand");
        const harnesses = get("harnesses");
        const mcp = new WorkbenchAgentMcpController({
          executeCommand: async (request, signal) => await agentCommand.executeStructuredRequest(request, signal),
          orchestratorOrigin: context.localOrchestratorOrigin,
          requestCodex: async (request) => await harnesses.request("codex", request),
        });
        const orchestratorHttp = new WorkbenchOrchestratorHttpRouter({
          agentCommand,
          bridgeRequest: get("bridgeRequest"),
          gitArc: get("gitArc"),
          legacyMigrationSource: get("legacyMigrationSource"),
          mcp,
          projectCatalog: get("projectCatalog"),
          projectSnapshot: get("projectSnapshot"),
          threadGit: get("threadGit"),
        });
        return {
          activate: () => {
            if (mode === "replacement") context.advanceMcpGeneration();
          },
          beginRuntimeDrain: () => { mcp.beginRuntimeDrain(); },
          dispose: (_reportPhase = () => undefined) => { mcp.releaseRuntimeOwner(); },
          expireRuntimeDrain: () => { mcp.expireRuntimeDrain(); },
          features: { mcp, orchestratorHttp },
          listRuntimeDrainPending: () => mcp.listRuntimeDrainPending().map(({ ageMs, policy, toolName }) => ({
            ageMs,
            label: `mcp ${toolName}${policy ? ` [${policy}]` : ""}`,
          })),
          start: async () => {
            if (mode !== "replacement") return;
            await context.refreshWorkbenchPromptFiles();
          },
        };
      },
      dependencies: [WORKBENCH_CORE_FEATURE_NODE_ID],
      featureKeys: ["mcp", "orchestratorHttp"],
      id: "workbench-mcp",
      lifecycle: "atomic",
      scope: "server:mcp",
    },
    ...createOrchestratorProviderFeatureNodes(context),
    ...createOrchestratorRuntimeFeatureNodes(context).slice(1),
  ];
}
