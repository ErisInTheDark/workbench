/*
 * Exports:
 * - default WorkbenchCoreNode: own core state, Git, harness, project, and supervisor registrations plus direct child declarations. Keywords: core, graph, registry.
 */
import * as project from "../lib/project";
import * as threadBootstrap from "../lib/thread-bootstrap";
import type { WorkbenchHarness } from "../lib/types";
import type { WorkbenchThreadSidebarEntry, WorkbenchThreadStateRequest } from "../lib/workbench/thread/thread-state";
import * as workbenchPromptFiles from "../lib/workbench/instructions/WorkbenchPromptFiles";
import * as workbenchLibrary from "../lib/workbench-library";
import BrowseSessionCleanupSupervisor from "./BrowseSessionCleanupSupervisor";
import CodexBridgeNode from "./CodexBridgeNode";
import CodexHealthMonitor from "./CodexHealthMonitor";
import NextDevHealthSupervisor from "./NextDevHealthSupervisor";
import OpenCodeBridgeNode from "./OpenCodeBridgeNode";
import * as copilotThreadState from "./copilot-thread-state";
import * as opencodeLiveThreadState from "./opencode-live-thread-state";
import * as opencodeThreadState from "./opencode-thread-state";
import * as opencodeWorkbenchInstructions from "./opencode-workbench-instructions";
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorReloadableModules, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";
import { log } from "./process-helpers";
import ReloadableNode, { type ReloadableNodeLease } from "./ReloadableNode";
import WorkbenchAgentCommandController from "./WorkbenchAgentCommandController";
import WorkbenchBridgeRequestController from "./WorkbenchBridgeRequestController";
import WorkbenchBrowseNode from "./WorkbenchBrowseNode";
import WorkbenchCoreFeature, { WORKBENCH_CORE_FEATURE_KEYS } from "./WorkbenchCoreFeature";
import WorkbenchGitArcFeature from "./WorkbenchGitArcFeature";
import WorkbenchHarnessController, { type WorkbenchHarnessAdapter, type WorkbenchHarnessRuntimePort } from "./WorkbenchHarnessController";
import WorkbenchLegacyMigrationSourceController, { readLegacyMigrationSourceConfig } from "./WorkbenchLegacyMigrationSourceController";
import WorkbenchMcpNode from "./WorkbenchMcpNode";
import WorkbenchProjectCatalogController from "./WorkbenchProjectCatalogController";
import WorkbenchProjectSnapshotController from "./WorkbenchProjectSnapshotController";
import WorkbenchSubagentFeature from "./WorkbenchSubagentFeature";
import WorkbenchThreadGitFeature from "./WorkbenchThreadGitFeature";
import WorkbenchThreadStateFeature from "./WorkbenchThreadStateFeature";
import WorkbenchTopologyNode from "./WorkbenchTopologyNode";
import { createWorktreeGitTransitions } from "./worktree-git-transitions";

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

function createWorkbenchCoreFeature(context: OrchestratorProcessContext, lease: ReloadableNodeLease) {
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
    getReloadScopesForPaths: context.getReloadScopesForPaths,
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
    harnesses,
    listSubagents: (projectId) => subagents.listRelationships(projectId),
    log: (message) => log("thread-state-ws", message),
    projectState: projectSnapshot,
    publish: (connectionId, snapshot) => { if (lease.isCurrent()) context.publishThreadState(connectionId, snapshot); },
    resolveProjectById: (projectId) => projectCatalog.resolveProjectById(projectId),
    resolveProjectFromCwd: (cwd, options) => projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, options),
    storageRoot: context.legacyMigrationProjectRoot,
    transitions: worktreeGitTransitions,
  });
  threadState.controller.subscribe(context.notifyThreadLifecycle);
  const { allowedProjectIds, capability } = readLegacyMigrationSourceConfig(context.legacyMigrationProjectRoot);
  const legacyMigrationSource = new WorkbenchLegacyMigrationSourceController({
    allowedProjectIds,
    capability,
    requestHarness: (harness, request) => harnesses.request(harness, request),
    resolveProjectFromCwd: async (cwd) => await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Legacy migration source" }),
  });
  const bridgeRequest = new WorkbenchBridgeRequestController({ harnesses });
  const agentCommand = new WorkbenchAgentCommandController(context.localWorkbenchOrigin, context.localOrchestratorOrigin, {
    checkApplyPatchClaims: async ({ cwd, harness, paths, threadId }) => await gitArc.checkActiveClaimPaths(cwd, harness, threadId, paths),
    executeBrowseRequest: context.executeBrowseRequest,
    executeGitArcRequest: async (body) => await gitArc.executeRequest(body),
    executeSessionRequest: context.executeBrowseSessionRequest,
    getReloadScopeCatalog: context.getReloadScopeCatalog,
    requestOrchestratorReload: context.requestOrchestratorReload,
    requestSubagent: async (request) => request.method?.startsWith("workbench/thread/")
      ? await threadState!.handleManagedThreadRequest(request)
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
  const registrations: Pick<OrchestratorRuntimeObjects, typeof WORKBENCH_CORE_FEATURE_KEYS[number]> = {
    agentCommand, bridgeRequest, browseSessionCleanup, codexHealth, gitArc, harnesses, legacyMigrationSource, modules, nextDevHealth, projectCatalog, projectSnapshot, subagents, threadGit, threadState,
  };
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
    observeProviderNotification: async ({ harness, notification }) => {
      if (lease.isCurrent()) await threadState!.observeProviderNotification(harness, notification);
    },
    registrations,
    start: async () => {
      await projectCatalog.ensureLoaded();
      await subagents.start();
      browseSessionCleanup.start();
      nextDevHealth.start();
    },
  });
}

export default new ReloadableNode<OrchestratorProcessContext, OrchestratorRuntimeObjects, import("./orchestrator-runtime-objects").OrchestratorProviderNotification>({
  access: "agent",
  children: [WorkbenchTopologyNode, WorkbenchMcpNode, CodexBridgeNode, OpenCodeBridgeNode, WorkbenchBrowseNode],
  create: (context, { lease }) => createWorkbenchCoreFeature(context, lease),
  description: "Reload core Workbench state, Git, project, harness, and supervisor code.",
  lifecycle: "atomic",
  provides: WORKBENCH_CORE_FEATURE_KEYS,
  requires: [],
  safeAll: true,
  scope: "server:core",
  sources: [
    "webapp/orchestrator/WorkbenchCoreNode.ts",
    "webapp/orchestrator/WorkbenchCoreFeature.ts",
    "webapp/orchestrator/WorkbenchAgentCommandController.ts",
    "webapp/orchestrator/WorkbenchBridgeRequestController.ts",
    "webapp/orchestrator/WorkbenchGitArcFeature.ts",
    "webapp/orchestrator/WorkbenchHarnessController.ts",
    "webapp/orchestrator/WorkbenchLegacyMigrationSourceController.ts",
    "webapp/orchestrator/WorkbenchProjectCatalogController.ts",
    "webapp/orchestrator/WorkbenchProjectSnapshotController.ts",
    "webapp/orchestrator/WorkbenchSubagentFeature.ts",
    "webapp/orchestrator/WorkbenchSubagentController.ts",
    "webapp/orchestrator/WorkbenchSubagentStore.ts",
    "webapp/orchestrator/WorkbenchThreadGitFeature.ts",
    "webapp/orchestrator/WorkbenchThreadStateFeature.ts",
    "webapp/orchestrator/WorkbenchThreadStateController.ts",
    "webapp/orchestrator/BrowseSessionCleanupSupervisor.ts",
    "webapp/orchestrator/CodexHealthMonitor.ts",
    "webapp/orchestrator/NextDevHealthSupervisor.ts",
    "webapp/lib/project.ts",
    "webapp/lib/thread-bootstrap.ts",
    "webapp/lib/workbench-library.ts",
    "webapp/lib/workbench/instructions/**",
  ].join("\n"),
});
