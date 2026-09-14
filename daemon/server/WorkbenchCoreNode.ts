/*
 * Exports:
 * - default WorkbenchCoreNode: own core state, Git, questionnaire, harness, project, and supervisor registrations plus direct child declarations.
 * Local helpers: construct reloadable modules, harness capabilities, and the core feature lifecycle.
 */
import * as project from "./lib/project";
import * as threadBootstrap from "./lib/thread-bootstrap";
import { type WorkbenchThreadSidebarEntry, type WorkbenchThreadStateRequest } from "workbench-shared/workbench/thread/thread-state";
import { createNativeQuestionnaireStatePorts } from "./thread-identity-workbench-mapping";
import { NativeThreadIdSchema, ProjectIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import * as workbenchPromptFiles from "./lib/workbench/instructions/WorkbenchPromptFiles";
import * as workbenchLibrary from "./lib/workbench-library";
import type { WorkbenchProjectsPayload } from "workbench-shared/types";
import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import BrowseSessionCleanupSupervisor from "./BrowseSessionCleanupSupervisor";
import CodexBridgeNode from "./CodexBridgeNode";
import CodexHealthMonitor from "./CodexHealthMonitor";
import OpenCodeBridgeNode from "./OpenCodeBridgeNode";
import * as copilotThreadState from "./copilot-thread-state";
import * as opencodeLiveThreadState from "./opencode-live-thread-state";
import * as opencodeThreadState from "./opencode-thread-state";
import * as opencodeWorkbenchInstructions from "./opencode-workbench-instructions";
import type { DaemonProcessContext } from "./daemon-process-context";
import type {
  DaemonDatabaseRegistration,
  DaemonReloadableModules,
  DaemonRuntimeObjects,
  DaemonTranscriptRegistration,
} from "./daemon-runtime-objects";
import ReloadableNode, { type ReloadableNodeBuild, type ReloadableNodeLease } from "./ReloadableNode";
import WorkbenchAgentCommandNode from "./WorkbenchAgentCommandNode";
import WorkbenchBridgeRequestController from "./WorkbenchBridgeRequestController";
import WorkbenchAgentSkillCatalogController from "./WorkbenchAgentSkillCatalogController";
import WorkbenchBrowseNode from "./WorkbenchBrowseNode";
import WorkbenchComposerProfileStore from "./WorkbenchComposerProfileStore";
import WorkbenchProviderDispatcher from "./WorkbenchProviderDispatcher";
import WorkbenchCoreFeature, { WORKBENCH_CORE_FEATURE_KEYS } from "./WorkbenchCoreFeature";
import WorkbenchGitArcFeature from "./WorkbenchGitArcFeature";
import WorkbenchHarnessController, { type WorkbenchHarnessAdapter } from "./WorkbenchHarnessController";
import WorkbenchDaemonRequestController from "./WorkbenchDaemonRequestController";
import WorkbenchLegacyMigrationSourceController, { readLegacyMigrationSourceConfig } from "./WorkbenchLegacyMigrationSourceController";
import WorkbenchMcpNode from "./WorkbenchMcpNode";
import WorkbenchProjectCatalogController from "./WorkbenchProjectCatalogController";
import WorkbenchProjectFileController from "./WorkbenchProjectFileController";
import WorkbenchProjectSnapshotController from "./WorkbenchProjectSnapshotController";
import WorkbenchSearchController from "./WorkbenchSearchController";
import WorkbenchStatsController from "./stats/WorkbenchStatsController";
import WorkbenchClaimRenameController from "./stats/WorkbenchClaimRenameController";
import WorkbenchQuestionnaireController from "./WorkbenchQuestionnaireController";
import WorkbenchQuestionnaireResponseController from "./WorkbenchQuestionnaireResponseController";
import WorkbenchNativeFileController from "./WorkbenchNativeFileController";
import WorkbenchServerSettings from "./lib/workbench/settings/WorkbenchServerSettings";
import WorkbenchSubagentFeature from "./WorkbenchSubagentFeature";
import WorkbenchThreadGitFeature from "./WorkbenchThreadGitFeature";
import WorkbenchThreadStateFeature from "./WorkbenchThreadStateFeature";
import WorkbenchTopologyNode from "./WorkbenchTopologyNode";
import type WorkbenchTurnRecoveryController from "./WorkbenchTurnRecoveryController";
import type WorkbenchReloadDirtController from "./WorkbenchReloadDirtController";
import WorkbenchWebSocketNode from "./WorkbenchWebSocketNode";
import { createWorktreeGitTransitions } from "./worktree-git-transitions";

function createModules(): DaemonReloadableModules {
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
    recoverAvailable: async signal => await controller.recoverAvailable(harness, undefined, undefined, signal),
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

function createHarnessAdapters(context: DaemonProcessContext, controller: WorkbenchTurnRecoveryController): WorkbenchHarnessAdapter[] {
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
      readLoadedThreads: ports.copilot.readLoadedThreads,
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
  context: DaemonProcessContext,
  run: ReloadableNodeBuild<DaemonRuntimeObjects>["run"],
  lease: ReloadableNodeLease,
  reloadDirt: WorkbenchReloadDirtController,
  turnRecovery: WorkbenchTurnRecoveryController,
  database: DaemonDatabaseRegistration,
  codexSandboxNetwork: DaemonRuntimeObjects["codexSandboxNetwork"],
  transcript: Pick<DaemonTranscriptRegistration, "read">,
  threadIdentity: DaemonRuntimeObjects["threadIdentity"],
  transcriptIdentity: DaemonRuntimeObjects["transcriptIdentity"],
  initialCatalog?: WorkbenchProjectsPayload,
) {
  const modules = createModules();
  const projectCatalog = new WorkbenchProjectCatalogController({ initialSnapshot: initialCatalog });
  const projectSnapshot = new WorkbenchProjectSnapshotController({
    resolveProjectById: (projectId) => projectCatalog.resolveProjectById(projectId),
  });
  const search = new WorkbenchSearchController({
    database,
    readCatalog: () => projectCatalog.readCatalog(),
    readProjectSnapshot: (projectId) => projectSnapshot.readProjectSnapshot(projectId),
  });
  const worktreeGitTransitions = createWorktreeGitTransitions(context.threadTransitions);
  let threadState: WorkbenchThreadStateFeature | null = null;
  let stats: WorkbenchStatsController | null = null;
  const requireThreadState = () => {
    if (!threadState) throw new Error("Thread state is not ready for subagent lifecycle projection.");
    return threadState;
  };
  const harnesses = new WorkbenchHarnessController(createHarnessAdapters(context, turnRecovery), {
    admitTurnStart: () => database.assertReady(),
    identities: threadIdentity,
    itemIdentities: transcriptIdentity,
    resolveProject: async (cwd) => {
      const { project } = await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Provider identity" });
      return { projectId: project.id, projectRoot: project.rootPath };
    },
  });
  const profileStore = new WorkbenchComposerProfileStore(context.legacyMigrationProjectRoot, database);
  const logThreadStateWarning = (message: string) => {
    console.warn("[thread-state-ws]", message.slice(0, 500));
  };
  const gitArc = new WorkbenchGitArcFeature({
    identities: threadIdentity,
    proposalDiffStore: {
      read: async identity => await database.readGitArcProposalDiff(identity),
      write: async (value, maxBytes) => await database.writeGitArcProposalDiff(value, maxBytes),
    },
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
    observeClaimSnapshot: (snapshot) => stats?.observeClaimSnapshot(snapshot),
    resolveProjectFromCwd: async (cwd) => await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Git arc" }),
    transitions: worktreeGitTransitions,
  });
  stats = new WorkbenchStatsController({
    renames: new WorkbenchClaimRenameController({
      listRoots: async (projectId) => {
        const catalog = await projectCatalog.readCatalog();
        return catalog.data.filter((project) => projectId === null || project.id === projectId).flatMap((project) => (
          project.roots.map((root) => ({ projectId: project.id, rootId: root.id, workspaceRoot: root.rootPath }))
        ));
      },
    }),
    claims: {
      reconcile: async (signal) => {
        for (const project of projectCatalog.getCurrentSnapshot().data) {
          if (signal.aborted) return;
          try {
            await gitArc.reconcileClaimSnapshots(project.rootPath);
          } catch (error) {
            stats.reportCaptureFailure(null, `claim reconciliation for project ${project.id}`, error);
          }
        }
      },
      discover: async () => {
        const catalog = await projectCatalog.readCatalog();
        const discoveries = await Promise.all(catalog.data.flatMap((project) => project.roots.map(async (root) => (
          await gitArc.discoverClaimHistory({
            projectId: project.id,
            rootId: root.id,
            workspaceRoot: root.rootPath,
          })
        ))));
        return {
          candidates: discoveries.flatMap(({ candidates }) => candidates),
          unsupported: discoveries.reduce((total, discovery) => total + discovery.unsupported, 0),
        };
      },
      hydrate: async (candidate) => await gitArc.hydrateClaimHistory(candidate),
    },
    database,
    harnesses,
    log: (message) => {
      console.warn("[stats]", message.slice(0, 500));
    },
  });
  const threadGit = new WorkbenchThreadGitFeature({
    identities: threadIdentity,
    resolveProjectFromCwd: async (cwd) => await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Thread Git" }),
    transitions: worktreeGitTransitions,
  });
  const subagents = new WorkbenchSubagentFeature({
    bridgeUrl: context.codexBridgeUrl,
    identities: { threads: threadIdentity, items: transcriptIdentity },
    requestNativeHarness: async (harness, request) => {
      const response = await harnesses.request(harness, request);
      if (!response.error && response.result && typeof response.result === "object") {
        const result = response.result as { thread?: Thread; turn?: Turn };
        if (result.thread) await harnesses.admitThreads(harness, [result.thread]);
        if (result.turn && request.params && typeof request.params === "object" && "threadId" in request.params
          && typeof request.params.threadId === "string") {
          await harnesses.admitNotifications(harness, NativeThreadIdSchema.parse(request.params.threadId), [{
            method: "turn/started", params: { threadId: request.params.threadId, turn: result.turn },
          }]);
        }
      }
      return response;
    },
    onRelationshipCommitted: (record) => requireThreadState().installSubagentRelationship(record),
    resolveProjectFromCwd: async (cwd, options) => await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, options),
    profileStore,
    persistence: database,
    threadState: {
      getEntry: async (projectId, harness, threadId) => {
        return requireThreadState().controller.getThreadEntry(projectId, harness, threadId);
      },
      mutate: async (request: WorkbenchThreadStateRequest) => {
        const response = await requireThreadState().controller.handleRequest("subagent-controller", request);
        if ("error" in response) throw new Error(response.error.message);
      },
      subscribe: (listener: (projectId: string, entry: WorkbenchThreadSidebarEntry) => void) => requireThreadState().controller.subscribe(listener),
    },
  });
  threadState = new WorkbenchThreadStateFeature({
    interruptRetainingQuestionnaire: (threadId, requestKey, interrupt) => questionnaires.interruptRetainingQuestionnaire(threadId, requestKey, interrupt),
    identities: { threads: threadIdentity, items: transcriptIdentity },
    readComposerProfiles: () => profileStore.read(),
    recordComposerProfileUsage: (profileId, at) => profileStore.recordUsage(profileId, at),
    database,
    getProjectCatalog: () => projectCatalog.getCurrentSnapshot(),
    gitArcs: gitArc,
    harnesses,
    listSubagents: (projectId) => subagents.listRelationships(projectId),
    log: logThreadStateWarning,
    projectState: projectSnapshot,
    reloadDirt,
    publish: (connectionId, snapshot) => { if (lease.isCurrent()) context.publishThreadState(connectionId, snapshot); },
    resolveProjectById: (projectId) => projectCatalog.resolveProjectById(projectId),
    resolveProjectFromCwd: (cwd, options) => projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, options),
    transitions: worktreeGitTransitions,
  });
  const questionnaires = new WorkbenchQuestionnaireController({
    ...createNativeQuestionnaireStatePorts({ threads: threadIdentity, items: transcriptIdentity }, threadState.controller, async cwd => {
      const resolved = await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Questionnaire" });
      return ProjectIdSchema.parse(resolved.project.id);
    }),
    logError: (message) => {
      console.error("[questionnaire]", message.slice(0, 500));
    },
  });
  const questionnaireResponses = new WorkbenchQuestionnaireResponseController({
    harnesses,
    questionnaires,
    resolveLatestTurn: async ({ projectId, threadId }) => {
      const snapshot = await transcript.read({ threadId, turnLimit: 1 });
      if (!snapshot) return null;
      if (snapshot.thread.project_id !== projectId) {
        throw new Error(`Questionnaire thread ${threadId} does not belong to project ${projectId}.`);
      }
      const turnId = snapshot.turns.at(-1)?.id;
      return turnId ? WorkbenchTurnIdSchema.parse(turnId) : null;
    },
    state: threadState.controller,
  });
  const daemonRequests = new WorkbenchDaemonRequestController({
    providers: new WorkbenchProviderDispatcher(run),
    agents: new WorkbenchAgentSkillCatalogController((projectId) => projectCatalog.resolveProjectById(projectId)),
    codexSandboxNetwork,
    files: new WorkbenchProjectFileController(projectCatalog, projectSnapshot),
    gitArc,
    nativeFiles: new WorkbenchNativeFileController(projectCatalog),
    profiles: profileStore,
    profileTargets: {
      readComposerProfileTarget: async (slot) => await threadState.controller.readComposerProfileTarget(slot),
      setComposerProfileTarget: async (slot, selection) => await threadState.controller.setComposerProfileTarget(slot, selection),
    },
    projects: projectCatalog,
    questionnaireResponses,
    search,
    settings: new WorkbenchServerSettings(),
    stats,
    threadIdentity: { resolve: (input) => harnesses.resolveThreadIdentity(input) },
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
  const registrations: Pick<DaemonRuntimeObjects, typeof WORKBENCH_CORE_FEATURE_KEYS[number]> = {
    bridgeRequest, browseSessionCleanup, codexHealth, daemonRequests, gitArc, harnesses, legacyMigrationSource, modules, projectCatalog, projectSnapshot, questionnaires, stats, subagents, threadGit, threadState,
  };
  return new WorkbenchCoreFeature({
    captureReloadState: () => projectCatalog.getCurrentSnapshot(),
    afterCommit: () => {
      if (!initialCatalog) return;
      stats.start();
      browseSessionCleanup.start();
      for (const [phase, start] of [
        ["composer profiles", () => profileStore.start()],
        ["loaded harness identities", () => harnesses.restoreLoadedIdentities()],
        ["project discovery", () => projectCatalog.readCatalog()],
      ] as const) {
        void start().catch((error: unknown) => {
          logThreadStateWarning(`Core background ${phase} failed: ${error instanceof Error ? error.message.slice(0, 300) : "non-Error rejection"}`);
        });
      }
    },
    beginRuntimeDrain: () => { subagents.beginRuntimeDrain(); },
    dispose: async (reportPhase = () => undefined) => {
      reportPhase("codex health disposal");
      codexHealth.dispose();
      reportPhase("browse session cleanup disposal");
      browseSessionCleanup.dispose();
      reportPhase("subagent disposal");
      await subagents.dispose();
      reportPhase("Git arc disposal");
      gitArc.dispose();
      reportPhase("stats disposal");
      await stats.dispose();
      reportPhase("questionnaire disposal");
      await questionnaires.dispose();
      reportPhase("thread-state disposal");
      await threadState.dispose();
      reportPhase("composer profile disposal");
      await profileStore.dispose();
      reportPhase("search disposal");
      await search.dispose();
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
      stats.observeProviderNotification(harness, notification);
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
    start: async (reportPhase) => {
      if (initialCatalog) return;
      reportPhase("composer profile startup");
      await profileStore.start();
      reportPhase("project discovery");
      await projectCatalog.ensureLoaded();
      reportPhase("loaded harness identity admission");
      await harnesses.restoreLoadedIdentities();
      reportPhase("stats startup");
      stats.start();
      reportPhase("browse session cleanup startup");
      browseSessionCleanup.start();
    },
  });
}

export default new ReloadableNode<DaemonProcessContext, DaemonRuntimeObjects, import("./daemon-runtime-objects").DaemonProviderNotification>({
  access: "agent",
  boundarySources: "shared/workbench/stats/**",
  children: [WorkbenchTopologyNode, WorkbenchAgentCommandNode, WorkbenchMcpNode, CodexBridgeNode, OpenCodeBridgeNode, WorkbenchBrowseNode, WorkbenchWebSocketNode],
  create: (context, { get, run, lease, handoffState }) => createWorkbenchCoreFeature(
    context,
    run,
    lease,
    get("reloadDirt"),
    get("turnRecovery"),
    get("database"),
    get("codexSandboxNetwork"),
    get("transcript"),
    get("threadIdentity"),
    get("transcriptIdentity"),
    handoffState as WorkbenchProjectsPayload | undefined,
  ),
  description: "Reload core Workbench state, Git, project, harness, and supervisor code.",
  lifecycle: "atomic",
  provides: WORKBENCH_CORE_FEATURE_KEYS,
  requires: ["codexSandboxNetwork", "database", "reloadDirt", "turnRecovery", "transcript", "threadIdentity", "transcriptIdentity"],
  safeAll: true,
  scope: "server:core",
  sources: [
    "daemon/server/WorkbenchCoreNode.ts",
    "daemon/server/WorkbenchComposerProfileStore.ts",
    "shared/workbench/state/composer-profile-state.ts",
    "daemon/server/lib/codex/codex-home.ts",
    "shared/workbench/thread/thread-profile.ts",
    "shared/workbench/thread/workbench-thread-identity.ts",
    "daemon/server/WorkbenchCoreFeature.ts",
    "daemon/server/WorkbenchBridgeRequestController.ts",
    "daemon/server/*git*.ts",
    "daemon/server/WorkbenchHarnessController.ts",
    "daemon/server/thread-identity-workbench-mapping.ts",
    "daemon/server/WorkbenchLegacyMigrationSourceController.ts",
    "daemon/server/WorkbenchProjectCatalogController.ts",
    "daemon/server/WorkbenchProjectSnapshotController.ts",
    "daemon/server/WorkbenchSearchController.ts",
    "daemon/server/stats/**",
    "daemon/server/WorkbenchSubagentFeature.ts",
    "daemon/server/WorkbenchSubagentController.ts",
    "daemon/server/WorkbenchSubagentStore.ts",
    "daemon/server/WorkbenchThreadStateFeature.ts",
    "daemon/server/WorkbenchThreadStateController.ts",
    "daemon/server/WorkbenchThreadStateStore.ts",
    "daemon/server/WorkbenchQuestionnaireController.ts",
    "daemon/server/WorkbenchQuestionnaireResponseController.ts",
    "shared/workbench/thread/thread-stop.ts",
    "daemon/server/BrowseSessionCleanupSupervisor.ts",
    "daemon/server/CodexHealthMonitor.ts",
    "daemon/server/lib/project.ts",
    "daemon/server/lib/thread-bootstrap.ts",
    "daemon/server/lib/workbench-library.ts",
    "daemon/server/lib/workbench/git/**",
    "shared/workbench/git/**",
    "shared/workbench/stats/workbench-stats-contract.ts",
    "shared/workbench/stats/**",
    "daemon/server/lib/workbench/instructions/**",
    "shared/workbench/thread/thread-display-order.ts",
    "shared/workbench/thread/thread-state.ts",
  ].join("\n"),
});
