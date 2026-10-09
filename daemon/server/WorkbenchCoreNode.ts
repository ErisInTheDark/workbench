/*
 * Exports:
 * - default WorkbenchCoreNode: own core state, Git, thread skills, auto-compaction admission, questionnaire, harness, project, orphaned-turn settlement, unfinished-turn continuation, and supervisor registrations plus direct child declarations.
 * Local helpers: construct reloadable modules, harness capabilities, and the core feature lifecycle.
 */
import path from "node:path";
import * as project from "./lib/project";
import * as threadBootstrap from "./lib/thread-bootstrap";
import type { WorkbenchHarness } from "workbench-shared/types";
import { type WorkbenchThreadLifecycle, type WorkbenchThreadSidebarEntry, type WorkbenchThreadStateRequest } from "workbench-shared/workbench/thread/thread-state";
import { createWorkbenchQuestionnaireStatePorts } from "./thread-identity-workbench-mapping";
import { ProjectIdSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema, type ProjectId, type WorkbenchThreadId } from "workbench-shared/workbench/identity";
import providerRegistrations, { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import * as workbenchPromptFiles from "./lib/workbench/instructions/WorkbenchPromptFiles";
import * as workbenchLibrary from "./lib/workbench-library";
import type { WorkbenchProjectStartup } from "./database/project/workbench-project-persistence";
import BrowseSessionCleanupSupervisor from "./BrowseSessionCleanupSupervisor";
import CodexBridgeNode from "./CodexBridgeNode";
import OpenCodeBridgeNode from "./providers/opencode/OpenCodeBridgeNode";
import ClaudeBridgeNode from "./providers/claude/ClaudeBridgeNode";
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
import WorkbenchModelUsageStore from "./WorkbenchModelUsageStore";
import VoiceSettingsStore from "./voice/VoiceSettingsStore";
import WorkbenchProviderDispatcher from "./WorkbenchProviderDispatcher";
import WorkbenchAgentContextController from "./WorkbenchAgentContextController";
import WorkbenchCoreFeature, { WORKBENCH_CORE_FEATURE_KEYS } from "./WorkbenchCoreFeature";
import WorkbenchGitArcFeature from "./WorkbenchGitArcFeature";
import WorkbenchWorkingTreeController from "./WorkbenchWorkingTreeController";
import WorkbenchAccountLimitsController from "./WorkbenchAccountLimitsController";
import type { ThreadRuntime } from "workbench-shared/workbench/thread/thread-state";
import WorkbenchProjectCreationController from "./WorkbenchProjectCreationController";
import { WorkbenchHarnessSchema } from "workbench-shared/workbench/thread/thread-state";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import WorkbenchHarnessController from "./WorkbenchHarnessController";
import { isThreadStatusActive } from "workbench-shared/workbench/thread/thread-runtime-state";
import WorkbenchDaemonRequestController from "./WorkbenchDaemonRequestController";
import WorkbenchThreadActionController from "./WorkbenchThreadActionController";
import WorkbenchThreadSkillsController from "./WorkbenchThreadSkillsController";
import WorkbenchThreadGoalController from "./WorkbenchThreadGoalController";
import WorkbenchTurnSettlementController from "./WorkbenchTurnSettlementController";
import WorkbenchUnfinishedTurnController from "./WorkbenchUnfinishedTurnController";
import WorkbenchTranscriptReader from "./WorkbenchTranscriptReader";
import WorkbenchTranscriptReconciliationController from "./WorkbenchTranscriptReconciliationController";
import WorkbenchMcpNode from "./WorkbenchMcpNode";
import { getProcessWorkbenchAgentMcpRequestRegistry } from "./workbench-agent-mcp-request-registry";
import WorkbenchProjectCatalogController from "./WorkbenchProjectCatalogController";
import WorkbenchProjectFileController from "./WorkbenchProjectFileController";
import WorkbenchProjectSnapshotController from "./WorkbenchProjectSnapshotController";
import WorkbenchProjectStore from "./store/WorkbenchProjectStore";
import { readDeviceIdentity } from "./store/device-identity";
import WorkbenchSearchController from "./WorkbenchSearchController";
import WorkbenchStatsController from "./stats/WorkbenchStatsController";
import WorkbenchToolCatalogueTokens from "./stats/WorkbenchToolCatalogueTokens";
import { readWorkbenchInstructionSources } from "./lib/workbench/instructions/instruction-source";
import WorkbenchClaimRenameController from "./stats/WorkbenchClaimRenameController";
import { reconcileCatalogClaims } from "./stats/reconcile-catalog-claims";
import { resolveGitDirectory } from "./lib/git";
import WorkbenchQuestionnaireController from "./WorkbenchQuestionnaireController";
import WorkbenchApprovalController, { type WorkbenchApprovalHandoff } from "./WorkbenchApprovalController";
import WorkbenchApprovalReviewController from "./approval-review/WorkbenchApprovalReviewController";
import { readOpenCodeApiKey } from "./approval-review/opencode-auth-credential";
import { DEFAULT_APPROVAL_MODE, resolveApprovalMode } from "workbench-shared/workbench/approval-review/approval-mode";
import WorkbenchQuestionnaireResponseController from "./WorkbenchQuestionnaireResponseController";
import WorkbenchNativeFileController from "./WorkbenchNativeFileController";
import WorkbenchServerSettings from "./lib/workbench/settings/WorkbenchServerSettings";
import WorkbenchThreadAutoCompactController from "./WorkbenchThreadAutoCompactController";
import WorkbenchThreadAdmissionController from "./WorkbenchThreadAdmissionController";
import WorkbenchThreadCompactionController from "./WorkbenchThreadCompactionController";
import WorkbenchThreadContextRolloverController from "./WorkbenchThreadContextRolloverController";
import WorkbenchSubagentFeature from "./WorkbenchSubagentFeature";
import WorkbenchThreadMessageController from "./WorkbenchThreadMessageController";
import type { WorkbenchMessageWaitHandoff } from "./WorkbenchMessageWaitController";
import WorkbenchSubagentQueueController, { type WorkbenchSubagentQueueHandoff } from "./WorkbenchSubagentQueueController";
import WorkbenchThreadLaunchController from "./WorkbenchThreadLaunchController";
import WorkbenchThreadGitFeature from "./WorkbenchThreadGitFeature";
import WorkbenchThreadStateFeature from "./WorkbenchThreadStateFeature";
import WorkbenchTopologyNode from "./WorkbenchTopologyNode";
import type WorkbenchReloadDirtController from "./WorkbenchReloadDirtController";
import WorkbenchWebSocketNode from "./WorkbenchWebSocketNode";
import WorkbenchVoiceNode from "./WorkbenchVoiceNode";
import WorkbenchInstallationUpdateNode from "./WorkbenchInstallationUpdateNode";
import { createWorktreeGitTransitions } from "./worktree-git-transitions";

const startupDiagnostics = process.env.WORKBENCH_STARTUP_DIAGNOSTICS === "1";

/** What one core generation hands its successor. */
interface WorkbenchCoreReloadState {
  projectStartup: WorkbenchProjectStartup;
  approvals: WorkbenchApprovalHandoff;
  messageWaits: WorkbenchMessageWaitHandoff;
  /** Absent when the previous generation predates subagent queues. */
  subagentQueues?: WorkbenchSubagentQueueHandoff;
}

function createModules(): DaemonReloadableModules {
  return { project, threadBootstrap, workbenchLibrary, workbenchPromptFiles };
}

function createWorkbenchCoreFeature(
  context: DaemonProcessContext,
  run: ReloadableNodeBuild<DaemonRuntimeObjects>["run"],
  lease: ReloadableNodeLease,
  reloadDirt: WorkbenchReloadDirtController,
  database: DaemonDatabaseRegistration,
  commandApprovals: DaemonRuntimeObjects["commandApprovals"],
  transcript: Pick<DaemonTranscriptRegistration, "read" | "readMaterializedTurnIds" | "readContextUsage" | "readRecoveryGaps" | "record" | "subscribeItemActivity" | "subscribeContextCompaction" | "subscribeTurnStarted" | "subscribeHeldSteers" | "subscribeAgentMessageDelivery" | "subscribeSettled" | "acceptApprovalOutcome">,
  threadIdentity: DaemonRuntimeObjects["threadIdentity"],
  transcriptIdentity: DaemonRuntimeObjects["transcriptIdentity"],
  turnRecovery: DaemonRuntimeObjects["turnRecovery"],
  /** A fresh daemon process: no turn a previous process left running is owned here unless its provider says so. */
  coldStart: boolean,
  initialCatalog?: WorkbenchProjectStartup,
  approvalHandoff?: WorkbenchApprovalHandoff,
  messageWaitHandoff?: WorkbenchMessageWaitHandoff,
  subagentQueueHandoff?: WorkbenchSubagentQueueHandoff,
) {
  const modules = createModules();
  const settings = new WorkbenchServerSettings(database);
  const projectCatalog = new WorkbenchProjectCatalogController({
    initialProjects: initialCatalog,
    // The daemon's own checkout always has a project, so wb feedback and Workbench threads have an owner.
    pinnedProjectRoots: [context.legacyMigrationProjectRoot],
    persistence: database,
    settings,
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
  const admission = new WorkbenchThreadAdmissionController();
  /** Threads whose runtime facts (token usage, auto-compaction) changed; thread observations reread them. */
  const runtimeListeners = new Set<(threadId: string, change: Partial<ThreadRuntime> | null) => void>();
  /** The thread's shown approval prompt; approvals are live provider facts, never durable thread state. */
  const readPendingApproval = (threadId: string): ThreadRuntime["pendingApproval"] => {
    const request = approvals.list().find(candidate => candidate.threadId === threadId);
    return request ? { itemId: request.itemId, request: request.request, requestKey: request.requestKey, turnId: request.turnId } : null;
  };
  const compaction = new WorkbenchThreadCompactionController(admission, {
    record: transcript.record.bind(transcript),
    setCompacting: (threadId, compacting) => threadState?.controller.setThreadCompactionState(threadId, compacting),
    now: Date.now,
  });
  const autoCompact = new WorkbenchThreadAutoCompactController(admission, compaction, {
    readSettings: () => settings.readThreadAutoCompact(),
    readEvidence: async reference => {
      const identity = await threadIdentity.resolve({ threadId: ThreadReferenceSchema.parse(reference) });
      if (!identity || !threadState) return null;
      const entry = await threadState.controller.getCanonicalThreadEntry(identity.projectId, identity.threadId);
      if (!entry || entry.entryKind === "draft") return null;
      const usage = await database.readThreadContextUsage(identity.threadId);
      return { activityAt: entry.activityAt, contextTokens: usage?.tokenUsage?.last.inputTokens ?? null };
    },
    readRuntime: async target => {
      const key = installedProviderKeys.find(candidate => candidate === target.harness);
      if (!key) throw new Error(`Provider ${target.harness} is not installed.`);
      return run(providerRegistrations[key], async provider => {
        const thread = await provider.threads.read(target.threadId, { background: true });
        const latestTurn = await provider.threads.latestTurn(target.threadId);
        const turnLive = latestTurn ? await provider.threads.isTurnLive(target.threadId, latestTurn.id) : false;
        return { latestTurn, status: thread.status, turnLive };
      }, `${key}: auto-compact status`);
    },
    publish: (target, willAutoCompact) => {
      for (const listener of runtimeListeners) listener(target.threadId, { willAutoCompact });
    },
    now: Date.now,
    warn: message => console.warn(`[auto-compact] ${message.slice(0, 500)}`),
  });
  const providers = new WorkbenchProviderDispatcher(run, undefined, autoCompact.run.bind(autoCompact),
    (threadId, message) => run("messages", owner => { owner.receive(threadId, message); }, "agent message admission"));
  const threadContextRollover = new WorkbenchThreadContextRolloverController(admission, {
    readSelectedCap: async threadId => {
      const identity = await threadIdentity.resolve({ threadId });
      if (!identity || !threadState) return null;
      const entry = await threadState.controller.getCanonicalThreadEntry(identity.projectId, identity.threadId);
      return entry && entry.entryKind !== "draft" ? entry.profile?.settings.contextWindowTokens ?? null : null;
    },
    requestDirective: async (threadId, turnId, instruction, key) => {
      const rollover = providers.get("opencode").threads.contextRollover;
      if (!rollover) throw new Error("OpenCode context rollover is unavailable.");
      await rollover.requestDirective({ instruction, key, threadId, turnId });
    },
    record: async observation => {
      await transcript.record([observation], { source: "provider" });
    },
    replace: async input => {
      const rollover = providers.get("opencode").threads.contextRollover;
      if (!rollover) throw new Error("OpenCode context rollover is unavailable.");
      await rollover.replace(input);
    },
    now: Date.now,
    warn: message => console.warn(`[context-rollover] ${message.slice(0, 500)}`),
  });
  const threadSkillTarget = async (threadId: string) => {
    const identity = await threadIdentity.resolve({ threadId: ThreadReferenceSchema.parse(threadId) });
    const harness = installedProviderKeys.find(key => key === identity?.bindings[0]?.harness);
    return identity && harness ? { identity, harness } : null;
  };
  const threadSkills = new WorkbenchThreadSkillsController({
    store: command => database.executeThreadSkills(command),
    target: async threadId => {
      const resolved = await threadSkillTarget(threadId);
      return resolved ? { harness: resolved.harness, threadId: resolved.identity.threadId } : null;
    },
    resolve: async (target, paths) => {
      const resolved = await threadSkillTarget(target.threadId);
      if (!resolved) return [];
      const owner = await projectCatalog.resolveProjectById(resolved.identity.projectId);
      return workbenchLibrary.resolveWorkbenchActivatedSkills(await project.listProjectSkillDefinitionsFromRoot(owner.rootPath), paths);
    },
    buildCatalog: async (target, paths) => {
      const resolved = await threadSkillTarget(target.threadId);
      if (!resolved) return null;
      const owner = await projectCatalog.resolveProjectById(resolved.identity.projectId);
      const profile = await requireThreadState().controller.readComposerProfileTarget({
        harness: target.harness, kind: "thread", projectId: owner.id, threadId: resolved.identity.threadId,
      });
      return workbenchPromptFiles.buildWorkbenchManagedThreadActivatedSkills({
        cwd: owner.rootPath, projectId: owner.id, threadId: resolved.identity.threadId,
        roots: owner.roots.map(root => ({
          id: root.id, name: root.name, relativePath: root.relativePath ?? ".",
          rootPath: root.rootPath, isPrimary: root.rootPath === owner.rootPath,
        })),
        harness: target.harness, managedThread: true, model: profile?.settings.model ?? null,
        activatedSkillPaths: paths, workbenchOrigin: context.localDaemonOrigin,
        readInstructionTools: () => run("mcp", mcp => mcp.listInstructionTools(), "Thread skill instruction tool catalogue"),
      }, () => settings.readLocalCapabilities());
    },
    publish: (target, text) => agentContext.publish(target, text),
    broadcast: (target, skills) => {
      for (const listener of runtimeListeners) listener(target.threadId, { skills: [...skills] });
    },
    warn: message => { console.warn("[thread-skills]", message.slice(0, 500)); },
  });
  const threadGoals = new WorkbenchThreadGoalController({
    store: command => database.executeThreadGoals(command),
    target: async threadId => {
      const resolved = await threadSkillTarget(threadId);
      return resolved ? { harness: resolved.harness, threadId: resolved.identity.threadId } : null;
    },
    publish: (target, text) => agentContext.publish(target, text),
    changed: (threadId, goal) => {
      for (const listener of runtimeListeners) listener(threadId, { goal });
    },
    warn: message => { console.warn("[thread-goal]", message.slice(0, 500)); },
  });
  const agentContext = new WorkbenchAgentContextController({
    sources: [threadSkills.contextSource, threadGoals.contextSource],
    inject: async (target, text, signal) => {
      if (!lease.isCurrent()) throw new Error("Agent context generation has retired.");
      return await providers.get(target.harness).context?.inject({ threadId: target.threadId, text }, signal) ?? "unsupported";
    },
    warn: message => { console.warn("[agent-context]", message); },
  });
  const requireThreadState = () => {
    if (!threadState) throw new Error("Thread state is not ready for subagent lifecycle projection.");
    return threadState;
  };
  const harnesses = new WorkbenchHarnessController({
    providers,
    identities: threadIdentity,
  });
  const profileStore = new WorkbenchComposerProfileStore(database);
  const modelUsage = new WorkbenchModelUsageStore(database);
  const voiceSettings = new VoiceSettingsStore(database);
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
    publishAgentContext: (target, text) => agentContext.publish(target, text),
    resolveSubagentPeer: input => subagents.resolveGitArcPeer(input),
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
      reconcile: async (signal) => await reconcileCatalogClaims({
        isCheckout: async (rootPath) => Boolean(await resolveGitDirectory(rootPath)),
        projects: projectCatalog.getCurrentSnapshot().data,
        reconcile: async (rootPath) => await gitArc.reconcileClaimSnapshots(rootPath),
        reportFailure: (projectId, error) => stats.reportCaptureFailure(null, `claim reconciliation for project ${projectId}`, error),
        signal,
      }),
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
    // wb feedback belongs to the project whose root is this daemon's own Workbench checkout.
    resolveWorkbenchProjectId: async () => {
      const key = (value: string) => {
        const resolved = path.resolve(value);
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
      };
      const workbenchRoot = key(context.legacyMigrationProjectRoot);
      const catalog = await projectCatalog.readCatalog();
      return catalog.data.find((candidate) => candidate.roots.some((root) => key(root.rootPath) === workbenchRoot))?.id ?? null;
    },
    toolCatalogue: new WorkbenchToolCatalogueTokens({
      harnesses: installedProviderKeys,
      readToolSpecs: harness => run("mcp", mcp => mcp.listToolSpecs(harness), "Stats tool spec catalogue"),
      readInstructionTools: () => run("mcp", mcp => mcp.listInstructionTools(), "Stats instruction tool catalogue"),
      readInstructionSources: () => readWorkbenchInstructionSources(),
    }),
  });
  const threadGit = new WorkbenchThreadGitFeature({
    selectionStore: database,
    identities: threadIdentity,
    resolveProjectFromCwd: async (cwd) => await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Thread Git" }),
    transitions: worktreeGitTransitions,
  });
  const provider = (harness: WorkbenchHarness) => {
    const key = installedProviderKeys.find(key => key === harness);
    if (!key) throw new Error(`Provider ${harness} is unavailable.`);
    return providers.get(key);
  };
  // Agent messages flip their target to working on the admitted turn, exactly like user messages.
  const acceptIntent = async (projectId: ProjectId, harness: WorkbenchHarness, threadId: WorkbenchThreadId, turnId: string) => {
    await requireThreadState().controller.acceptProviderIntent(projectId, harness, threadId, WorkbenchTurnIdSchema.parse(turnId));
  };
  // Built after thread state below; its lifecycle listener must register before any subagent wait subscribes.
  let subagentQueues: WorkbenchSubagentQueueController | undefined;
  const subagents = new WorkbenchSubagentFeature({
    identities: threadIdentity,
    queueReleaseNote: threadId => subagentQueues?.takeReleaseNote(threadId) ?? null,
    provider,
    // Read lazily: the approval owner is built after subagents but within this same node.
    liveApprovals: () => approvals.list(),
    onRelationshipCommitted: (record) => requireThreadState().installSubagentRelationship(record),
    resolveProjectFromCwd: async (cwd, options) => await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, options),
    profileStore,
    persistence: database,
    // Read lazily: thread actions own stop and are built later in this node.
    stopThread: threadId => threadActions.stopThread(threadId),
    acceptIntent,
    threadState: {
      getEntry: async (projectId, harness, threadId) => {
        return requireThreadState().controller.getThreadEntry(projectId, harness, threadId);
      },
      mutate: async (request: WorkbenchThreadStateRequest) => {
        const response = await requireThreadState().controller.handleRequest("subagent-controller", request);
        if ("error" in response) throw new Error(response.error.message);
        if (!("accepted" in response.result)) throw new Error("The subagent settle mutation returned no acceptance decision.");
        return { accepted: response.result.accepted };
      },
      subscribe: (listener: (projectId: string, entry: WorkbenchThreadSidebarEntry) => void) => requireThreadState().controller.subscribe(listener),
    },
  });
  const messages = new WorkbenchThreadMessageController({
    identities: threadIdentity,
    listSubagents: projectId => subagents.listRelationships(projectId),
    provider,
    // Resolve lazily: the shared waiter is built later within this core generation.
    questionnaires: {
      canDeliver: (threadId, requestKey) => questionnaires.canDeliver(threadId, requestKey),
      deliver: input => questionnaires.deliver(input),
    },
    recordQuestionnaire: async entry => {
      await transcript.record([{
        kind: "questionnaire",
        entry: {
          ...entry,
          itemId: entry.itemId ?? null,
          insertAfterItemId: entry.insertAfterItemId ?? null,
          insertAfterItemIndex: entry.insertAfterItemIndex ?? null,
          threadId: WorkbenchThreadIdSchema.parse(entry.threadId),
        },
        observedAt: entry.resolvedAt,
      }], { source: "workbench" });
    },
    resolveProjectFromCwd: async (cwd, options) => await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, options),
    threadState: {
      getEntry: async (projectId, harness, threadId) => (
        await requireThreadState().controller.getThreadEntry(projectId, harness, threadId)
      ),
      acceptIntent,
      resolvePendingQuestionnaire: (input, deliver) => (
        requireThreadState().controller.resolvePendingQuestionnaire(input, deliver)
      ),
    },
  }, messageWaitHandoff);
  threadState = new WorkbenchThreadStateFeature({
    agentContext,
    providers,
    identities: { threads: threadIdentity, items: transcriptIdentity },
    itemActivity: transcript,
    readComposerProfiles: () => profileStore.read(),
    recordComposerProfileUsage: (profileId, at) => profileStore.recordUsage(profileId, at),
    recordComposerModelUsage: (harness, modelId, at) => modelUsage.record(harness, modelId, at),
    database,
    getProjectCatalog: () => projectCatalog.getCurrentSnapshot(),
    gitArcs: gitArc,
    compactThread: input => threadContextRollover.acceptSummary(input),
    listSubagents: (projectId) => subagents.listRelationships(projectId),
    log: logThreadStateWarning,
    resolveProjectById: (projectId) => projectCatalog.resolveProjectById(projectId),
    resolveProjectFromCwd: (cwd, options) => projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, options),
    transitions: worktreeGitTransitions,
  });
  const queues = subagentQueues = new WorkbenchSubagentQueueController({
    resolveProjectFromCwd: async cwd => (
      await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Workbench subagent queue" })
    ).project.id,
    resolveThreadId: async (threadId, projectId) => {
      const identity = await threadIdentity.resolve({ threadId: ThreadReferenceSchema.parse(threadId), projectId });
      if (!identity) throw new Error("The queue caller has no admitted identity in this project.");
      return identity.threadId;
    },
    listRelationships: async projectId => (await subagents.listRelationships(projectId)).subagents,
    readLifecycle: async (projectId, threadId) => {
      const entry = await requireThreadState().controller.getCanonicalThreadEntry(projectId, threadId);
      return entry && entry.entryKind !== "draft" ? entry.lifecycle : null;
    },
    subscribeLifecycle: listener => requireThreadState().controller.subscribe(listener),
    sendNotice: input => messages.sendNotice(input),
    warn: message => { console.warn("[subagent-queue]", message.slice(0, 500)); },
  }, subagentQueueHandoff);
  const questionnaires = new WorkbenchQuestionnaireController({
    beforeAnswer: async (threadId, signal) => {
      const identity = await threadIdentity.resolve({ threadId });
      const harness = installedProviderKeys.find(key => key === identity?.bindings[0]?.harness);
      if (harness) await agentContext.collect({ harness, threadId }, "answer", signal);
    },
    ...createWorkbenchQuestionnaireStatePorts({ threads: threadIdentity, items: transcriptIdentity }, threadState.controller, async cwd => {
      const resolved = await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Questionnaire" });
      return ProjectIdSchema.parse(resolved.project.id);
    }),
    logError: (message) => {
      console.error("[questionnaire]", message.slice(0, 500));
    },
  });
  const approvalReview = new WorkbenchApprovalReviewController({
    database,
    readDeviceIdentity,
    readOpenCodeApiKey: () => readOpenCodeApiKey(),
    codexReviewer: () => installedProviderKeys.includes("codex") ? provider("codex").approvalReview : null,
  });
  const approvals = new WorkbenchApprovalController({
    broadcast: (harness, notification) => context.broadcastProviderNotification(harness, notification),
    collectAnswerContext: async (harness, threadId, signal) => {
      const key = installedProviderKeys.find(candidate => candidate === harness);
      if (key) await agentContext.collect({ harness: key, threadId }, "answer", signal);
    },
    commandApprovals,
    deliver: async (harness, input) => await provider(harness).interactions?.deliverApproval(input) ?? false,
    logError: message => { console.error("[approval]", message.slice(0, 500)); },
    observeLifecycle: async (harness, threadId, event) => {
      await threadState.controller.observeLifecycle(harness, threadId, event);
    },
    pendingChanged: threadId => {
      const pendingApproval = readPendingApproval(threadId);
      for (const listener of runtimeListeners) listener(threadId, { pendingApproval });
    },
    recordOutcome: async entry => {
      await database.recordApprovalOutcome(entry);
      transcript.acceptApprovalOutcome(entry);
    },
    resolveProject: async threadId => (await threadIdentity.resolve({ threadId }))?.projectId ?? null,
    resolveApprovalMode: async threadId => {
      const identity = await threadIdentity.resolve({ threadId });
      // Approval modes only exist in daemon projects; normal projects always ask.
      if (!identity || (await projectCatalog.resolveProjectById(identity.projectId)).kind !== "daemon") return DEFAULT_APPROVAL_MODE;
      const states = requireThreadState().controller;
      // Subagents follow the mode of the top-level thread that started their tree.
      let entry = await states.getCanonicalThreadEntry(identity.projectId, identity.threadId);
      for (let depth = 0; entry?.entryKind === "subagent" && depth < 64; depth += 1) {
        entry = await states.getCanonicalThreadEntry(identity.projectId, entry.parentThreadId);
      }
      if (!entry || entry.entryKind === "draft" || entry.entryKind === "subagent") return DEFAULT_APPROVAL_MODE;
      return resolveApprovalMode(await states.readComposerProfileSnapshot({
        kind: "thread", projectId: identity.projectId, harness: entry.identity.harness, threadId: entry.identity.threadId,
      }));
    },
    review: (input, signal) => approvalReview.review(input.subject, signal),
  }, approvalHandoff);
  const recordSkillActivations = (threadId: string, paths: readonly string[]) => threadSkills.recordActivations(threadId, paths, "user");
  const unsubscribeCompaction = transcript.subscribeContextCompaction(async completion => {
    if (!lease.isCurrent()) return;
    // Observers reread token usage when the transcript settles; agents get their skills and goal re-sent.
    await threadSkills.observeCompaction(completion.threadId);
    if (lease.isCurrent()) await threadGoals.observeCompaction(completion.threadId);
  });
  const questionnaireResponses = new WorkbenchQuestionnaireResponseController({
    approvals,
    harnesses,
    providers,
    recordSkillActivations,
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
  const transcriptReader = new WorkbenchTranscriptReader({
    readProviderCursor: (threadId, turnId) => database.readTranscriptProviderCursor!(threadId, turnId),
    readSnapshot: request => transcript.read(request),
    readContext: threadId => database.readTranscriptContext!(threadId),
    readMaterializedTurns: (threadId, turnIds) => transcript.readMaterializedTurnIds(threadId, turnIds),
    readContextUsage: threadId => transcript.readContextUsage(threadId),
    readApprovalOutcomes: (threadId, turnIds) => database.readApprovalOutcomes(threadId, turnIds),
    readMetadata: async (thread, provenance) => {
      const entry = await threadState.controller.getCanonicalThreadEntry(
        ProjectIdSchema.parse(thread.project_id), WorkbenchThreadIdSchema.parse(thread.id),
      );
      let harness = (entry && entry.entryKind !== "draft" ? entry.identity.harness : null) ?? provenance;
      if (!harness) {
        const identity = await threadIdentity.resolve({ threadId: ThreadReferenceSchema.parse(thread.id) });
        harness = identity?.bindings[0]?.harness ?? null;
      }
      if (!harness) throw new Error("Canonical transcript has no stored execution provenance.");
      return { entry, harness: WorkbenchHarnessSchema.parse(harness) };
    },
  });
  const transcriptReconciliation = new WorkbenchTranscriptReconciliationController({
    identities: threadIdentity,
    transcripts: transcriptReader,
    readGapIds: async threadId => (await transcript.readRecoveryGaps(WorkbenchThreadIdSchema.parse(threadId))).map(gap => gap.id),
    subscribeSettled: listener => transcript.subscribeSettled(listener),
    recover: async (input, signal) => {
      const key = installedProviderKeys.find(key => key === input.harness);
      if (!key) throw new Error("Transcript provider is not installed.");
      const provider = providers.get(key);
      if (!provider.threads.reconcile) throw new Error("Transcript provider does not support reconciliation.");
      return provider.threads.reconcile(input, signal);
    },
    warn: message => logThreadStateWarning(message),
  });
  const unfinishedTurns = new WorkbenchUnfinishedTurnController({
    coordinator: turnRecovery,
    readLifecycle: async (harness, threadId) => {
      const identity = await threadIdentity.resolve({ harness, threadId: ThreadReferenceSchema.parse(threadId) });
      if (!identity) return null;
      const entry = await requireThreadState().controller.getCanonicalThreadEntry(identity.projectId, identity.threadId);
      return entry && entry.entryKind !== "draft" ? { projectId: identity.projectId, lifecycle: entry.lifecycle } : null;
    },
    continueUnfinished: async (harness, target) => {
      const key = installedProviderKeys.find(key => key === harness);
      return key ? await providers.continueUnfinished(key, target) : "unsupported";
    },
    reportFailed: async (projectId, harness, threadId) => await requireThreadState().controller.reportRecoveryFailed(projectId, harness, threadId),
    log: context.logTurnRecovery,
  });
  const turnSettlement = new WorkbenchTurnSettlementController({
    providers, identities: threadIdentity, transcripts: transcriptReader, transcript,
    observe: async (harness, facts) => await requireThreadState().observeProviderNotification(harness, facts),
    listThreadLifecycles: async () => {
      const { data } = await projectCatalog.readCatalog();
      const threads: Array<{ threadId: string; lifecycle: WorkbenchThreadLifecycle }> = [];
      for (const { id } of data) {
        const { entries } = await requireThreadState().controller.getSnapshot(ProjectIdSchema.parse(id));
        for (const entry of entries) {
          if (entry.entryKind !== "draft") threads.push({ threadId: entry.identity.threadId, lifecycle: entry.lifecycle });
        }
      }
      return threads;
    },
    warn: message => logThreadStateWarning(message),
  });
  const threadActions = new WorkbenchThreadActionController({
    autoCompact,
    compaction,
    approvals,
    reconciliation: transcriptReconciliation,
    transcripts: transcriptReader,
    transcript,
    shells: getProcessWorkbenchAgentMcpRequestRegistry(),
    settlement: turnSettlement,
    providers, projects: projectCatalog, identities: threadIdentity,
    profiles: threadState, state: threadState.controller,
    skills: threadSkills, goals: threadGoals, recordSkillActivations,
    warn: message => logThreadStateWarning(message),
  });
  // A new turn retires the dead turns beneath it, then takes the agent messages they stranded.
  const unsubscribeTurnStarted = transcript.subscribeTurnStarted(async ({ threadId, turnId }) => {
    if (!lease.isCurrent()) return;
    await turnSettlement.settleSuperseded(threadId, turnId);
    if (lease.isCurrent()) await threadActions.resendUndeliveredAgentMessages(threadId, turnId);
  });
  // Message waits keep admitted mail until its recipient's model sees it.
  const unsubscribeAgentMessageDelivery = transcript.subscribeAgentMessageDelivery?.(({ threadId, message }) => {
    if (lease.isCurrent()) messages.delivered(threadId, message);
  }) ?? (() => undefined);
  const unsubscribeAutoCompactSettled = transcript.subscribeSettled(threadIds => {
    if (lease.isCurrent()) void autoCompact.refreshObserved(threadIds);
  });
  // Held steers live outside the transcript stream, so open views learn about them from this push.
  const unsubscribeHeldSteers = transcript.subscribeHeldSteers(async ({ threadId, turnId }) => {
    if (!lease.isCurrent()) return;
    const harness = (await threadIdentity.resolve({ threadId: ThreadReferenceSchema.parse(threadId) }))?.bindings[0]?.harness;
    if (harness && lease.isCurrent()) {
      context.broadcastProviderNotification(WorkbenchHarnessSchema.parse(harness), {
        method: "steer/history/changed", params: { threadId, turnId },
      });
    }
  });
  const launches = new WorkbenchThreadLaunchController({
    database, projects: projectCatalog, actions: threadActions,
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
  const readTokenUsage = async (threadId: string) => (await transcript.readContextUsage(threadId))?.tokenUsage ?? null;
  const threadRuntime: DaemonRuntimeObjects["threadRuntime"] = {
    read: async (threadId, harness) => {
      // Goal and skills are optional facts: one failing read must not drop the thread's usage.
      const optional = async <Value>(label: string, read: () => Promise<Value>) => {
        try { return await read(); } catch (error) {
          logThreadStateWarning(`Thread runtime ${label} read failed: ${error instanceof Error ? error.message.slice(0, 300) : "unknown failure"}`);
          return undefined;
        }
      };
      const goal = await optional("goal", () => threadGoals.read(threadId));
      const skills = await optional("skills", () => threadSkills.read(threadId));
      return {
        tokenUsage: await readTokenUsage(threadId),
        willAutoCompact: await autoCompact.observe({ harness: WorkbenchHarnessSchema.parse(harness), threadId }),
        pendingApproval: readPendingApproval(threadId),
        ...(goal !== undefined ? { goal } : {}),
        ...(skills !== undefined ? { skills } : {}),
      };
    },
    readTokenUsage,
    subscribe: listener => {
      runtimeListeners.add(listener);
      // Token usage commits through the transcript; only usage is reread for committed threads.
      const stopSettled = transcript.subscribeSettled(threadIds => { for (const threadId of threadIds) listener(threadId, null); });
      return () => { runtimeListeners.delete(listener); stopSettled(); };
    },
  };
  const accountLimits = new WorkbenchAccountLimitsController({
    read: harness => {
      const key = installedProviderKeys.find(candidate => candidate === harness);
      return key ? providers.get(key).account?.limits.read() ?? null : null;
    },
    record: (harness, limits) => stats.observeAccountLimits(harness, limits),
    warn: message => logThreadStateWarning(message),
  });
  const projectStore = new WorkbenchProjectStore({
    execute: command => database.executeProjectStore(command),
    readDeviceIdentity,
    resolveProjectById: projectId => projectCatalog.resolveProjectById(projectId),
    resolveProjectFromCwd: cwd => projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Project store" }),
  });
  const daemonRequests = new WorkbenchDaemonRequestController({
    autoCompact,
    commandApprovals,
    approvalReview,
    projectStore,
    workingTree,
    providers,
    threadActions,
    launches,
    presentationExport: threadState.controller,
    agents: new WorkbenchAgentSkillCatalogController(
      (projectId) => projectCatalog.resolveProjectById(projectId),
      (provider, sections) => providers.get(harnesses.resolveHarness(provider)).configuration.guidance.contains(sections),
    ),
    files: new WorkbenchProjectFileController(projectCatalog, projectSnapshot),
    gitArc,
    nativeFiles: new WorkbenchNativeFileController(projectCatalog),
    profiles: profileStore,
    modelUsage,
    profileTargets: {
      readComposerProfileTarget: async (slot) => await threadState.controller.readComposerProfileTarget(slot),
      setComposerProfileTarget: async (slot, selection) => await threadState.controller.setComposerProfileTarget(slot, selection),
    },
    projects: projectCatalog,
    projectCreation: new WorkbenchProjectCreationController({ catalog: projectCatalog }),
    projectSnapshot,
    questionnaireResponses,
    search,
    settings,
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
    agentContext,
    approvals,
    voiceSettings,
    browseSessionCleanup, daemonRequests, gitArc, harnesses, messages, modules, projectCatalog, projectSnapshot, projectStore, questionnaires, stats, subagents, subagentQueues: queues, threadGit, threadState, threadActions, threadSkills, transcriptReader, transcriptReconciliation,
    threadContextRollover,
    workingTree,
    accountLimits,
    threadRuntime,
    turnRecoveryFailures: {
      report: async (cwd, harness, threadId) => {
        const project = await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Workbench turn recovery" });
        const identity = await threadIdentity.resolve({ threadId: ThreadReferenceSchema.parse(threadId), projectId: project.project.id, harness });
        if (!identity) throw new Error("Turn recovery failure has no matching Workbench thread identity.");
        await threadState.controller.reportRecoveryFailed(project.project.id, harness, identity.threadId);
      },
    },
    providerObservations: {
      observe: async (harness, facts) => {
        if (!lease.isCurrent()) return null;
        stats.observeProviderNotification(harness, facts);
        accountLimits.noteActivity(harness);
        const observation = await threadState!.observeProviderNotification(harness, facts);
        if (!lease.isCurrent()) return null;
        const lifecycle = observation?.lifecycle ?? null;
        unfinishedTurns.observe(harness, facts, lifecycle);
        return lifecycle;
      },
    },
  };
  return new WorkbenchCoreFeature({
    hasPendingWork: () => admission.hasPendingWork() || compaction.hasPendingWork()
      || autoCompact.hasPendingWork() || threadContextRollover.hasPendingWork()
      || launches.hasPendingWork() || stats.hasPendingWork() || transcriptReconciliation.hasPendingWork(),
    captureReloadState: (): WorkbenchCoreReloadState => ({
      projectStartup: projectCatalog.captureReloadState(),
      approvals: approvals.captureReloadState(),
      messageWaits: messages.captureReloadState(),
      subagentQueues: queues.captureReloadState(),
    }),
    afterCommit: () => {
      approvals.activate();
      if (coldStart) void turnSettlement.startColdSweep();
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
    beginRuntimeDrain: () => {
      admission.beginRuntimeDrain();
      autoCompact.beginRuntimeDrain();
      launches.beginRuntimeDrain();
      messages.beginRuntimeDrain();
      subagents.beginRuntimeDrain();
    },
    dispose: async (reportPhase = () => undefined) => {
      unsubscribeCompaction();
      unsubscribeAutoCompactSettled();
      unsubscribeTurnStarted();
      unsubscribeHeldSteers();
      unsubscribeAgentMessageDelivery();
      unfinishedTurns.dispose();
      await threadContextRollover.dispose();
      await autoCompact.dispose();
      await admission.dispose();
      reportPhase("orphaned turn sweep disposal");
      await turnSettlement.dispose();
      reportPhase("transcript reconciliation disposal");
      await transcriptReconciliation.dispose();
      reportPhase("working-tree disposal");
      await workingTree.dispose();
      accountLimits.dispose();
      reportPhase("browse session cleanup disposal");
      browseSessionCleanup.dispose();
      reportPhase("subagent queue disposal");
      queues.dispose();
      reportPhase("subagent disposal");
      await subagents.dispose();
      reportPhase("thread-message disposal");
      await messages.dispose();
      reportPhase("thread launch disposal");
      await launches.dispose();
      reportPhase("Git arc disposal");
      gitArc.dispose();
      reportPhase("stats disposal");
      await stats.dispose();
      reportPhase("questionnaire disposal");
      await questionnaires.dispose();
      approvals.dispose();
      reportPhase("thread-state disposal");
      await threadState.dispose();
      reportPhase("composer profile disposal");
      await voiceSettings.dispose();
      await profileStore.dispose();
      await modelUsage.dispose();
      reportPhase("search disposal");
      await search.dispose();
      reportPhase("project snapshot disposal");
      projectSnapshot.dispose();
      reportPhase("project catalog disposal");
      await projectCatalog.dispose();
    },
    registrations,
    start: async (reportPhase) => {
      if (startupDiagnostics) console.info("[startup] daemon project catalogue loading");
      if (initialCatalog) {
        reportPhase("validate retained project catalog");
        await projectCatalog.start();
        if (startupDiagnostics) console.info("[startup] daemon project catalogue ready");
        if (startupDiagnostics) console.info("[startup] daemon core ready");
        return;
      }
      reportPhase("prepared project catalog");
      await projectCatalog.start();
      if (startupDiagnostics) console.info("[startup] daemon project catalogue ready");
      reportPhase("composer profile startup");
      await profileStore.start();
      reportPhase("stats startup");
      stats.start();
      reportPhase("browse session cleanup startup");
      browseSessionCleanup.start();
      if (startupDiagnostics) console.info("[startup] daemon core ready");
    },
  });
}

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, import("./daemon-runtime-objects").DaemonProviderNotification>()({
  access: "agent",
  children: [WorkbenchTopologyNode, WorkbenchAgentCommandNode, WorkbenchMcpNode, CodexBridgeNode, OpenCodeBridgeNode, ClaudeBridgeNode, WorkbenchBrowseNode, WorkbenchVoiceNode, WorkbenchInstallationUpdateNode, WorkbenchWebSocketNode],
  create: (context, { get, run, lease, handoffState, isReplacing, mode }) => {
    const reloadState = handoffState as WorkbenchCoreReloadState | undefined;
    return createWorkbenchCoreFeature(
      context,
      run,
      lease,
      get("reloadDirt"),
      get("database"),
      get("commandApprovals"),
      get("transcript"),
      get("threadIdentity"),
      get("transcriptIdentity"),
      get("turnRecovery"),
      mode === "initial",
      isReplacing("server:database") ? undefined : reloadState?.projectStartup,
      reloadState?.approvals,
      reloadState?.messageWaits,
      reloadState?.subagentQueues,
    );
  },
  description: "Reload core Workbench state, Git, project, harness, and supervisor code.",
  lifecycle: "atomic",
  provides: WORKBENCH_CORE_FEATURE_KEYS,
  requires: ["database", "commandApprovals", "reloadDirt", "transcript", "threadIdentity", "transcriptIdentity", "turnRecovery"],
  safeAll: true,
  scope: "server:core",
});
