/*
 * Exports:
 * - default WorkbenchCoreNode: own core state, Git, questionnaire, harness, project, and supervisor registrations plus direct child declarations.
 * Local helpers: construct reloadable modules, harness capabilities, and the core feature lifecycle.
 */
import * as project from "./lib/project";
import * as threadBootstrap from "./lib/thread-bootstrap";
import { type WorkbenchThreadSidebarEntry, type WorkbenchThreadStateRequest } from "workbench-shared/workbench/thread/thread-state";
import { createWorkbenchQuestionnaireStatePorts } from "./thread-identity-workbench-mapping";
import { ProjectIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import * as workbenchPromptFiles from "./lib/workbench/instructions/WorkbenchPromptFiles";
import * as workbenchLibrary from "./lib/workbench-library";
import type { WorkbenchProjectStartup } from "./database/project/workbench-project-persistence";
import BrowseSessionCleanupSupervisor from "./BrowseSessionCleanupSupervisor";
import CodexBridgeNode from "./CodexBridgeNode";
import type { DaemonProcessContext } from "./daemon-process-context";
import type {
  DaemonDatabaseRegistration,
  DaemonReloadableModules,
  DaemonRuntimeObjects,
  DaemonTranscriptRegistration,
} from "./daemon-runtime-objects";
import ReloadableNode, { type ReloadableNodeBuild, type ReloadableNodeLease } from "./ReloadableNode";
import WorkbenchAgentCommandNode from "./WorkbenchAgentCommandNode";
import WorkbenchAgentSkillCatalogController from "./WorkbenchAgentSkillCatalogController";
import WorkbenchBrowseNode from "./WorkbenchBrowseNode";
import WorkbenchComposerProfileStore from "./WorkbenchComposerProfileStore";
import VoiceSettingsStore from "./voice/VoiceSettingsStore";
import WorkbenchProviderDispatcher from "./WorkbenchProviderDispatcher";
import WorkbenchCoreFeature, { WORKBENCH_CORE_FEATURE_KEYS } from "./WorkbenchCoreFeature";
import WorkbenchGitArcFeature from "./WorkbenchGitArcFeature";
import WorkbenchWorkingTreeController from "./WorkbenchWorkingTreeController";
import { WorkbenchHarnessSchema } from "workbench-shared/workbench/thread/thread-state";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import WorkbenchHarnessController from "./WorkbenchHarnessController";
import { isThreadStatusActive } from "workbench-shared/workbench/thread/thread-runtime-state";
import WorkbenchDaemonRequestController from "./WorkbenchDaemonRequestController";
import WorkbenchThreadActionController from "./WorkbenchThreadActionController";
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
import type WorkbenchReloadDirtController from "./WorkbenchReloadDirtController";
import WorkbenchWebSocketNode from "./WorkbenchWebSocketNode";
import WorkbenchVoiceNode from "./WorkbenchVoiceNode";
import { createWorktreeGitTransitions } from "./worktree-git-transitions";

function createModules(): DaemonReloadableModules {
  return { project, threadBootstrap, workbenchLibrary, workbenchPromptFiles };
}

function createWorkbenchCoreFeature(
  context: DaemonProcessContext,
  run: ReloadableNodeBuild<DaemonRuntimeObjects>["run"],
  lease: ReloadableNodeLease,
  reloadDirt: WorkbenchReloadDirtController,
  database: DaemonDatabaseRegistration,
  transcript: Pick<DaemonTranscriptRegistration, "read">,
  threadIdentity: DaemonRuntimeObjects["threadIdentity"],
  transcriptIdentity: DaemonRuntimeObjects["transcriptIdentity"],
  initialCatalog?: WorkbenchProjectStartup,
) {
  const modules = createModules();
  const projectCatalog = new WorkbenchProjectCatalogController({
    initialProjects: initialCatalog ?? (() => database.readInitialProjectCatalog()),
    persistence: database,
  });
  const projectSnapshot = new WorkbenchProjectSnapshotController({
    observeProject: (projectId) => { void projectCatalog.observeProjectIcon(ProjectIdSchema.parse(projectId)); },
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
  const providers = new WorkbenchProviderDispatcher(run);
  const requireThreadState = () => {
    if (!threadState) throw new Error("Thread state is not ready for subagent lifecycle projection.");
    return threadState;
  };
  const harnesses = new WorkbenchHarnessController({
    providers,
    identities: threadIdentity,
  });
  const profileStore = new WorkbenchComposerProfileStore(database);
  const voiceSettings = new VoiceSettingsStore(database, profileStore);
  const logThreadStateWarning = (message: string) => {
    console.warn("[thread-state-ws]", message.slice(0, 500));
  };
  const gitArc = new WorkbenchGitArcFeature({
    identities: threadIdentity,
    legacyDiffStore: database,
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
    providers,
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
    selectionStore: database,
    identities: threadIdentity,
    resolveProjectFromCwd: async (cwd) => await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Thread Git" }),
    transitions: worktreeGitTransitions,
  });
  const subagents = new WorkbenchSubagentFeature({
    identities: threadIdentity,
    provider: harness => {
      const key = installedProviderKeys.find(key => key === harness);
      if (!key) throw new Error(`Provider ${harness} is unavailable.`);
      return providers.get(key);
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
    providers,
    identities: { threads: threadIdentity, items: transcriptIdentity },
    readComposerProfiles: () => profileStore.read(),
    recordComposerProfileUsage: (profileId, at) => profileStore.recordUsage(profileId, at),
    database,
    getProjectCatalog: () => projectCatalog.getCurrentSnapshot(),
    gitArcs: gitArc,
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
    ...createWorkbenchQuestionnaireStatePorts({ threads: threadIdentity, items: transcriptIdentity }, threadState.controller, async cwd => {
      const resolved = await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Questionnaire" });
      return ProjectIdSchema.parse(resolved.project.id);
    }),
    logError: (message) => {
      console.error("[questionnaire]", message.slice(0, 500));
    },
  });
  const questionnaireResponses = new WorkbenchQuestionnaireResponseController({
    harnesses,
    providers,
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
  const threadActions = new WorkbenchThreadActionController({
    providers, projects: projectCatalog, identities: threadIdentity,
    profiles: threadState, state: threadState.controller,
    warn: message => logThreadStateWarning(message),
  });
  const workingTree = new WorkbenchWorkingTreeController({
    resolveProject: projectId => projectCatalog.resolveProjectById(projectId),
    resolveIdentity: async input => {
      const resolved = await projectCatalog.resolveAgentEndpointProjectFromCwd(input.repositoryRoot, { endpointName: "Working tree" });
      return await threadIdentity.resolveGitArcThreadIdentity({
        ...input, harness: WorkbenchHarnessSchema.parse(input.harness), projectId: resolved.project.id,
      });
    },
    readOwner: async (threadId, harness) => {
      const identity = await threadIdentity.resolve({ threadId: ThreadReferenceSchema.parse(threadId) });
      if (!identity) return null;
      const entry = await threadState.controller.getThreadEntry(identity.projectId, WorkbenchHarnessSchema.parse(harness), identity.threadId);
      return entry ? { id: identity.threadId, projectId: identity.projectId, entry } : null;
    },
    transitions: worktreeGitTransitions,
  });
  const daemonRequests = new WorkbenchDaemonRequestController({
    workingTree,
    providers,
    threadActions,
    agents: new WorkbenchAgentSkillCatalogController(
      (projectId) => projectCatalog.resolveProjectById(projectId),
      (provider, sections) => providers.get(harnesses.resolveHarness(provider)).configuration.guidance.contains(sections),
    ),
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
    settings: new WorkbenchServerSettings(database),
    stats,
    threadIdentity: { resolve: (input, options) => harnesses.resolveThreadIdentity(input, options) },
  });
  const browseSessionCleanup = new BrowseSessionCleanupSupervisor({
    readThreadActive: async threadId => {
      if (!lease.isCurrent()) return null;
      try {
        const identity = await threadIdentity.resolve({ threadId: ThreadReferenceSchema.parse(threadId) });
        if (!identity) return null;
        const key = installedProviderKeys.find(key => identity.bindings.some(binding => binding.harness === key));
        if (!key) return null;
        const thread = await providers.get(key).threads.read(identity.threadId, { background: true });
        return isThreadStatusActive(thread.status);
      } catch (error) {
        console.warn("[browse-cleanup]", (error instanceof Error ? error.message : String(error)).slice(0, 500));
        return null;
      }
    },
    cleanupStaleInactiveSessions: async (options) => {
      if (!lease.isCurrent()) {
        browseSessionCleanup.dispose();
        return;
      }
      await run("browseExecution", execution => execution.cleanupStaleInactiveSessions(options), "Browse stale-session cleanup");
    },
  });
  const registrations: Pick<DaemonRuntimeObjects, typeof WORKBENCH_CORE_FEATURE_KEYS[number]> = {
    voiceSettings,
    browseSessionCleanup, daemonRequests, gitArc, harnesses, modules, projectCatalog, projectSnapshot, questionnaires, stats, subagents, threadGit, threadState, threadActions,
    providerObservations: {
      observe: async (harness, facts) => {
        if (!lease.isCurrent()) return null;
        stats.observeProviderNotification(harness, facts);
        const observation = await threadState!.observeProviderNotification(harness, facts);
        return lease.isCurrent() ? observation?.lifecycle ?? null : null;
      },
    },
  };
  return new WorkbenchCoreFeature({
    captureReloadState: () => projectCatalog.captureReloadState(),
    afterCommit: () => {
      if (!initialCatalog) return;
      stats.start();
      browseSessionCleanup.start();
      for (const [phase, start] of [
        ["composer profiles", () => profileStore.start()],
        ["project discovery", () => projectCatalog.readCatalog()],
      ] as const) {
        void start().catch((error: unknown) => {
          logThreadStateWarning(`Core background ${phase} failed: ${error instanceof Error ? error.message.slice(0, 300) : "non-Error rejection"}`);
        });
      }
    },
    beginRuntimeDrain: () => { subagents.beginRuntimeDrain(); },
    dispose: async (reportPhase = () => undefined) => {
      reportPhase("working-tree disposal");
      await workingTree.dispose();
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
      await voiceSettings.dispose();
      await profileStore.dispose();
      reportPhase("search disposal");
      await search.dispose();
      reportPhase("project snapshot disposal");
      projectSnapshot.dispose();
      reportPhase("project catalog disposal");
      await projectCatalog.dispose();
    },
    registrations,
    start: async (reportPhase) => {
      if (initialCatalog) return;
      reportPhase("prepared project catalog");
      await projectCatalog.ensureLoaded();
      reportPhase("composer profile startup");
      await profileStore.start();
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
  children: [WorkbenchTopologyNode, WorkbenchAgentCommandNode, WorkbenchMcpNode, CodexBridgeNode, WorkbenchBrowseNode, WorkbenchVoiceNode, WorkbenchWebSocketNode],
  create: (context, { get, run, lease, handoffState, isReplacing }) => createWorkbenchCoreFeature(
    context,
    run,
    lease,
    get("reloadDirt"),
    get("database"),
    get("transcript"),
    get("threadIdentity"),
    get("transcriptIdentity"),
    isReplacing("server:database") ? undefined : handoffState as WorkbenchProjectStartup | undefined,
  ),
  description: "Reload core Workbench state, Git, project, harness, and supervisor code.",
  lifecycle: "atomic",
  provides: WORKBENCH_CORE_FEATURE_KEYS,
  requires: ["database", "reloadDirt", "transcript", "threadIdentity", "transcriptIdentity"],
  safeAll: true,
  scope: "server:core",
  sources: [
    "daemon/server/WorkbenchCoreNode.ts",
    "daemon/server/WorkbenchWorkingTreeController.ts",
    "daemon/server/WorkbenchDaemonRequestController.ts",
    "shared/workbench/daemon/workbench-daemon-requests.ts",
    "shared/workbench/daemon/WorkbenchDaemonClient.ts",
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
    "daemon/server/WorkbenchThreadActionController.ts",
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
    "daemon/server/BrowseSessionCleanupSupervisor.ts",
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
