/*
 * Exports:
 * - default WorkbenchCoreNode: own core state, Git, harness, project, and supervisor registrations plus direct child declarations. Keywords: core, graph, registry.
 */
import * as project from "../lib/project";
import * as threadBootstrap from "../lib/thread-bootstrap";
import type { WorkbenchThreadSidebarEntry, WorkbenchThreadStateRequest } from "workbench-shared/workbench/thread/thread-state";
import * as workbenchPromptFiles from "../lib/workbench/instructions/WorkbenchPromptFiles";
import * as workbenchLibrary from "../lib/workbench-library";
import BrowseSessionCleanupSupervisor from "./BrowseSessionCleanupSupervisor";
import CodexBridgeNode from "./CodexBridgeNode";
import CodexHealthMonitor from "./CodexHealthMonitor";
import OpenCodeBridgeNode from "./OpenCodeBridgeNode";
import * as copilotThreadState from "./copilot-thread-state";
import * as opencodeLiveThreadState from "./opencode-live-thread-state";
import * as opencodeThreadState from "./opencode-thread-state";
import * as opencodeWorkbenchInstructions from "./opencode-workbench-instructions";
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type {
  OrchestratorDatabaseRegistration,
  OrchestratorReloadableModules,
  OrchestratorRuntimeObjects,
  OrchestratorTranscriptRegistration,
  OrchestratorTranscriptShadowLog,
} from "./orchestrator-runtime-objects";
import ReloadableNode, { type ReloadableNodeLease } from "./ReloadableNode";
import WorkbenchAgentCommandNode from "./WorkbenchAgentCommandNode";
import WorkbenchBridgeRequestController from "./WorkbenchBridgeRequestController";
import WorkbenchAgentSkillCatalogController from "./WorkbenchAgentSkillCatalogController";
import WorkbenchBrowseNode from "./WorkbenchBrowseNode";
import WorkbenchComposerProfileStore from "./WorkbenchComposerProfileStore";
import WorkbenchCoreFeature, { WORKBENCH_CORE_FEATURE_KEYS } from "./WorkbenchCoreFeature";
import WorkbenchGitArcFeature from "./WorkbenchGitArcFeature";
import WorkbenchHarnessController, { type WorkbenchHarnessAdapter } from "./WorkbenchHarnessController";
import WorkbenchDaemonRequestController from "./WorkbenchDaemonRequestController";
import WorkbenchLegacyMigrationSourceController, { readLegacyMigrationSourceConfig } from "./WorkbenchLegacyMigrationSourceController";
import WorkbenchMcpNode from "./WorkbenchMcpNode";
import WorkbenchProjectCatalogController from "./WorkbenchProjectCatalogController";
import WorkbenchProjectFileController from "./WorkbenchProjectFileController";
import WorkbenchProjectSnapshotController from "./WorkbenchProjectSnapshotController";
import WorkbenchNativeFileController from "./WorkbenchNativeFileController";
import WorkbenchServerSettings from "../lib/workbench/settings/WorkbenchServerSettings";
import WorkbenchSubagentFeature from "./WorkbenchSubagentFeature";
import WorkbenchThreadGitFeature from "./WorkbenchThreadGitFeature";
import WorkbenchThreadStateFeature from "./WorkbenchThreadStateFeature";
import WorkbenchTopologyNode from "./WorkbenchTopologyNode";
import type WorkbenchTurnRecoveryController from "./WorkbenchTurnRecoveryController";
import type WorkbenchReloadDirtController from "./WorkbenchReloadDirtController";
import WorkbenchWebSocketNode from "./WorkbenchWebSocketNode";
import { createWorktreeGitTransitions } from "./worktree-git-transitions";

function createModules(): OrchestratorReloadableModules {
  return { copilotThreadState, opencodeLiveThreadState, opencodeThreadState, opencodeWorkbenchInstructions, project, threadBootstrap, workbenchLibrary, workbenchPromptFiles };
}

function createRecoveryCapability(
  harness: "codex" | "opencode",
  controller: WorkbenchTurnRecoveryController,
): WorkbenchHarnessAdapter["recovery"] {
  return {
    kind: "turn",
    observeNotification: (notification) => controller.observeNotification(harness, notification),
    observeRequest: (request) => controller.observeRequest(harness, request),
    recoverAvailable: async () => await controller.recoverAvailable(harness),
    resumeThread: async (threadId) => await controller.requestResume(harness, threadId),
  };
}

function createObservationCapability(
  harness: "copilot",
  controller: WorkbenchTurnRecoveryController,
): WorkbenchHarnessAdapter["recovery"] {
  return {
    kind: "observe",
    observeNotification: (notification) => controller.observeNotification(harness, notification),
    observeRequest: (request) => controller.observeRequest(harness, request),
  };
}

function createHarnessAdapters(context: OrchestratorProcessContext, controller: WorkbenchTurnRecoveryController): WorkbenchHarnessAdapter[] {
  const ports = context.harnessPorts;
  return [
    {
      browse: ports.codex,
      browser: ports.codex,
      id: "codex",
      internal: ports.codex,
      recovery: createRecoveryCapability("codex", controller),
      serverMethods: [
        "workbench/codex/message/admit",
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
      recovery: createObservationCapability("copilot", controller),
      serverMethods: ["thread/name/set"],
    },
    {
      browse: ports.opencode,
      browser: ports.opencode,
      id: "opencode",
      internal: ports.opencode,
      recovery: createRecoveryCapability("opencode", controller),
      serverMethods: ["thread/name/set"],
    },
  ];
}

function createWorkbenchCoreFeature(
  context: OrchestratorProcessContext,
  lease: ReloadableNodeLease,
  reloadDirt: WorkbenchReloadDirtController,
  turnRecovery: WorkbenchTurnRecoveryController,
  database: OrchestratorDatabaseRegistration,
  codexSandboxNetwork: OrchestratorRuntimeObjects["codexSandboxNetwork"],
  transcript: Pick<OrchestratorTranscriptRegistration, "read">,
  transcriptShadowLog: OrchestratorTranscriptShadowLog,
) {
  const modules = createModules();
  const projectCatalog = new WorkbenchProjectCatalogController();
  const projectSnapshot = new WorkbenchProjectSnapshotController({
    resolveProjectById: (projectId) => projectCatalog.resolveProjectById(projectId),
  });
  const worktreeGitTransitions = createWorktreeGitTransitions(context.threadTransitions);
  let threadState: WorkbenchThreadStateFeature | null = null;
  const requireThreadState = () => {
    if (!threadState) throw new Error("Thread state is not ready for subagent lifecycle projection.");
    return threadState;
  };
  const harnesses = new WorkbenchHarnessController(createHarnessAdapters(context, turnRecovery), {
    admitTurnStart: () => database.assertReady(),
  });
  const profileStore = new WorkbenchComposerProfileStore(context.legacyMigrationProjectRoot);
  const gitArc = new WorkbenchGitArcFeature({
    getThreadCreatedAt: async (projectId, _harness, threadId) => {
      const snapshot = await transcript.read({ threadId, turnLimit: 1 });
      if (!snapshot) return null;
      if (snapshot.thread.project_id !== projectId) {
        throw new Error(`Managed thread ${threadId} does not belong to project ${projectId}.`);
      }
      return snapshot.thread.created_at;
    },
    getThreadClaimContext: async (projectId, harness, threadId) => {
      if (!threadState) throw new Error("Thread state is not ready for Git arc ownership.");
      return await threadState.controller.getThreadClaimContext(projectId, harness, threadId);
    },
    refreshThreadGitArcState: async (projectId, harness, threadId) => {
      if (!threadState) throw new Error("Thread state is not ready for Git arc publication.");
      await threadState.controller.refreshGitArcState(projectId, harness, threadId);
    },
    resolveProjectFromCwd: async (cwd) => await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Git arc" }),
    transitions: worktreeGitTransitions,
  });
  const daemonRequests = new WorkbenchDaemonRequestController({
    agents: new WorkbenchAgentSkillCatalogController((projectId) => projectCatalog.resolveProjectById(projectId)),
    codexSandboxNetwork,
    files: new WorkbenchProjectFileController(projectCatalog, projectSnapshot),
    gitArc,
    nativeFiles: new WorkbenchNativeFileController(projectCatalog),
    profiles: profileStore,
    profileTargets: {
      readComposerProfileTarget: async (slot) => await requireThreadState().controller.readComposerProfileTarget(slot),
      setComposerProfileTarget: async (slot, selection) => await requireThreadState().controller.setComposerProfileTarget(slot, selection),
    },
    projects: projectCatalog,
    settings: new WorkbenchServerSettings(),
  });
  const threadGit = new WorkbenchThreadGitFeature({
    resolveProjectFromCwd: async (cwd) => await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Thread Git" }),
    transitions: worktreeGitTransitions,
  });
  const subagents = new WorkbenchSubagentFeature({
    bridgeUrl: context.codexBridgeUrl,
    onRelationshipCommitted: context.installSubagentRelationship,
    resolveProjectFromCwd: async (cwd, options) => await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, options),
    profileStore,
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
    database,
    getProjectCatalog: () => projectCatalog.getCurrentSnapshot(),
    gitArcs: gitArc,
    harnesses,
    listSubagents: (projectId) => subagents.listRelationships(projectId),
    log: (message) => {
      transcriptShadowLog.write({
        event: "thread-state",
        fields: { message: message.slice(0, 500) },
        level: "warning",
        source: "thread-state-ws",
      });
    },
    projectState: projectSnapshot,
    reloadDirt,
    publish: (connectionId, snapshot) => { if (lease.isCurrent()) context.publishThreadState(connectionId, snapshot); },
    resolveProjectById: (projectId) => projectCatalog.resolveProjectById(projectId),
    resolveProjectFromCwd: (cwd, options) => projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, options),
    storageRoot: context.legacyMigrationProjectRoot,
    transitions: worktreeGitTransitions,
  });
  const { allowedProjectIds, capability } = readLegacyMigrationSourceConfig(context.legacyMigrationProjectRoot);
  const legacyMigrationSource = new WorkbenchLegacyMigrationSourceController({
    allowedProjectIds,
    capability,
    requestHarness: (harness, request) => harnesses.request(harness, request),
    resolveProjectFromCwd: async (cwd) => await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Legacy migration source" }),
  });
  const bridgeRequest = new WorkbenchBridgeRequestController({ harnesses });
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
  const codexHealth = new CodexHealthMonitor({
    ...context.codexHealthOptions,
    isProbeAllowed: () => lease.isCurrent() && context.codexHealthOptions.isProbeAllowed(),
    isShuttingDown: () => !lease.isCurrent() || context.codexHealthOptions.isShuttingDown(),
    requestRecovery: (reason) => { if (lease.isCurrent()) context.codexHealthOptions.requestRecovery(reason); },
  });
  const registrations: Pick<OrchestratorRuntimeObjects, typeof WORKBENCH_CORE_FEATURE_KEYS[number]> = {
    bridgeRequest, browseSessionCleanup, codexHealth, daemonRequests, gitArc, harnesses, legacyMigrationSource, modules, projectCatalog, projectSnapshot, subagents, threadGit, threadState,
  };
  return new WorkbenchCoreFeature({
    beginRuntimeDrain: () => { subagents.beginRuntimeDrain(); },
    dispose: async (reportPhase = () => undefined) => {
      reportPhase("codex health disposal");
      codexHealth.dispose();
      reportPhase("browse session cleanup disposal");
      browseSessionCleanup.dispose();
      reportPhase("subagent disposal");
      subagents.dispose();
      reportPhase("Git arc disposal");
      gitArc.dispose();
      reportPhase("thread-state disposal");
      await threadState.dispose();
      reportPhase("project snapshot disposal");
      projectSnapshot.dispose();
      reportPhase("project catalog disposal");
      projectCatalog.dispose();
    },
    observeProviderNotification: async ({ harness, notification }) => {
      if (!lease.isCurrent()) {
        await turnRecovery.completeObservedTurn(harness, notification, null, async () => undefined);
        return;
      }
      let observation;
      try {
        observation = await threadState!.observeProviderNotification(harness, notification);
      } catch (error) {
        await turnRecovery.completeObservedTurn(harness, notification, null, async () => undefined);
        throw error;
      }
      if (!lease.isCurrent()) {
        await turnRecovery.completeObservedTurn(harness, notification, null, async () => undefined);
        return;
      }
      await turnRecovery.completeObservedTurn(harness, notification, observation?.lifecycle ?? null, async (candidate, request) => {
        if (candidate.harness === "codex") {
          if (!candidate.resumeRequest) throw new Error("The unfinished Codex turn has no captured thread/resume request.");
          const response = await harnesses.request("codex", {
            id: `unfinished-admit:${candidate.recoveryId}`,
            method: "workbench/codex/message/admit",
            params: {
              resumeRequest: candidate.resumeRequest,
              startRequest: request,
              threadId: candidate.threadId,
            },
          });
          if (response.error) throw new Error(response.error.message);
          return;
        }
        const response = await harnesses.request(candidate.harness, request);
        if (response.error) throw new Error(response.error.message);
      });
    },
    registrations,
    start: async () => {
      await projectCatalog.ensureLoaded();
      await subagents.start();
      browseSessionCleanup.start();
    },
  });
}

export default new ReloadableNode<OrchestratorProcessContext, OrchestratorRuntimeObjects, import("./orchestrator-runtime-objects").OrchestratorProviderNotification>({
  access: "agent",
  children: [WorkbenchTopologyNode, WorkbenchAgentCommandNode, WorkbenchMcpNode, CodexBridgeNode, OpenCodeBridgeNode, WorkbenchBrowseNode, WorkbenchWebSocketNode],
  create: (context, { get, lease }) => createWorkbenchCoreFeature(
    context,
    lease,
    get("reloadDirt"),
    get("turnRecovery"),
    get("database"),
    get("codexSandboxNetwork"),
    get("transcript"),
    get("transcriptShadowLog"),
  ),
  description: "Reload core Workbench state, Git, project, harness, and supervisor code.",
  lifecycle: "atomic",
  provides: WORKBENCH_CORE_FEATURE_KEYS,
  requires: ["codexSandboxNetwork", "database", "reloadDirt", "transcriptShadowLog", "turnRecovery", "transcript"],
  safeAll: true,
  scope: "server:core",
  sources: [
    "webapp/orchestrator/WorkbenchCoreNode.ts",
    "webapp/orchestrator/WorkbenchCoreFeature.ts",
    "webapp/orchestrator/WorkbenchBridgeRequestController.ts",
    "webapp/orchestrator/*git*.ts",
    "webapp/orchestrator/WorkbenchHarnessController.ts",
    "webapp/orchestrator/WorkbenchLegacyMigrationSourceController.ts",
    "webapp/orchestrator/WorkbenchProjectCatalogController.ts",
    "webapp/orchestrator/WorkbenchProjectSnapshotController.ts",
    "webapp/orchestrator/WorkbenchSubagentFeature.ts",
    "webapp/orchestrator/WorkbenchSubagentController.ts",
    "webapp/orchestrator/WorkbenchSubagentStore.ts",
    "webapp/orchestrator/WorkbenchThreadStateFeature.ts",
    "webapp/orchestrator/WorkbenchThreadStateController.ts",
    "webapp/orchestrator/WorkbenchThreadStateStore.ts",
    "webapp/orchestrator/BrowseSessionCleanupSupervisor.ts",
    "webapp/orchestrator/CodexHealthMonitor.ts",
    "webapp/lib/project.ts",
    "webapp/lib/thread-bootstrap.ts",
    "webapp/lib/workbench-library.ts",
    "webapp/lib/workbench/git/**",
    "shared/workbench/git/**",
    "webapp/lib/workbench/instructions/**",
    "!webapp/lib/workbench/instructions/**/*.md",
    "shared/workbench/thread/thread-display-order.ts",
    "shared/workbench/thread/thread-state.ts",
  ].join("\n"),
});
