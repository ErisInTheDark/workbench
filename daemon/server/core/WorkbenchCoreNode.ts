/*
 * Exports:
 * - default WorkbenchCoreNode: own the core generation's lifecycle (start, drain, reload handoff, dispose order) and registrations, wiring the
 *   feature clusters under ./core with the provider dispatcher, thread state, thread summaries, the thread busy lease, thread actions, launches, daemon requests,
 *   MCP servers, browse cleanup and the MCP registry's undelivered-message read, plus supervisor registrations and direct child declarations (including provider runtime installs).
 * Local helpers: construct reloadable modules and the core feature lifecycle.
 */
import path from "node:path";
import * as project from "../lib/project";
import * as threadBootstrap from "../lib/thread-bootstrap";
import { WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import * as workbenchPromptFiles from "../lib/workbench/instructions/WorkbenchPromptFiles";
import * as workbenchLibrary from "../lib/workbench-library";
import type { WorkbenchProjectStartup } from "../database/project/workbench-project-persistence";
import BrowseSessionCleanupSupervisor from "../browse/BrowseSessionCleanupSupervisor";
import CodexBridgeNode from "../providers/codex/CodexBridgeNode";
import OpenCodeBridgeNode from "../providers/opencode/OpenCodeBridgeNode";
import ClaudeBridgeNode from "../providers/claude/ClaudeBridgeNode";
import ProviderRuntimeNode from "../providers/ProviderRuntimeNode";
import type { DaemonProcessContext } from "../daemon-process-context";
import type {
  DaemonDatabaseRegistration,
  DaemonReloadableModules,
  DaemonRuntimeObjects,
} from "../daemon-runtime-objects";
import ReloadableNode, { type ReloadableNodeBuild, type ReloadableNodeLease } from "../runtime/ReloadableNode";
import WorkbenchAgentCommandNode from "../agent/WorkbenchAgentCommandNode";
import WorkbenchBrowseNode from "../browse/WorkbenchBrowseNode";
import WorkbenchComposerProfileStore from "../store/WorkbenchComposerProfileStore";
import WorkbenchModelUsageStore from "../store/WorkbenchModelUsageStore";
import VoiceSettingsStore from "../voice/VoiceSettingsStore";
import WorkbenchProviderDispatcher from "../providers/WorkbenchProviderDispatcher";
import WorkbenchCoreFeature, { WORKBENCH_CORE_FEATURE_KEYS } from "./WorkbenchCoreFeature";
import WorkbenchProjectCreationController from "../project/WorkbenchProjectCreationController";
import { WorkbenchHarnessSchema } from "workbench-shared/workbench/thread/thread-state";
import WorkbenchHarnessController from "../providers/WorkbenchHarnessController";
import { isThreadStatusActive } from "workbench-shared/workbench/thread/thread-runtime-state";
import WorkbenchDaemonRequestController from "../transport/WorkbenchDaemonRequestController";
import WorkbenchThreadActionController from "../thread/WorkbenchThreadActionController";
import WorkbenchThreadBusyTracker from "../thread/WorkbenchThreadBusyTracker";
import WorkbenchThreadSummaryIndex from "../thread/WorkbenchThreadSummaryIndex";
import WorkbenchMcpNode from "../agent/WorkbenchMcpNode";
import { getProcessWorkbenchAgentMcpRequestRegistry } from "../agent/workbench-agent-mcp-request-registry";
import { readDeviceIdentity } from "../store/device-identity";
import type { WorkbenchApprovalHandoff } from "../interactions/WorkbenchApprovalController";
import WorkbenchMcpServerController from "../mcp-servers/WorkbenchMcpServerController";
import McpDownloadStore from "../mcp-servers/McpDownloadStore";
import { logError } from "../process-helpers";
import WorkbenchNativeFileController from "../project/WorkbenchNativeFileController";
import type { WorkbenchMessageWaitHandoff } from "../agent/WorkbenchMessageWaitController";
import type { WorkbenchSubagentQueueHandoff } from "../subagents/WorkbenchSubagentQueueController";
import WorkbenchThreadLaunchController from "../thread/WorkbenchThreadLaunchController";
import WorkbenchThreadStateFeature from "../thread/WorkbenchThreadStateFeature";
import WorkbenchTopologyNode from "../runtime/WorkbenchTopologyNode";
import type WorkbenchReloadDirtController from "../runtime/WorkbenchReloadDirtController";
import WorkbenchWebSocketNode from "../transport/WorkbenchWebSocketNode";
import WorkbenchVoiceNode from "../voice/WorkbenchVoiceNode";
import WorkbenchInstallationUpdateNode from "../runtime/WorkbenchInstallationUpdateNode";
import { createWorktreeGitTransitions } from "../git/worktree-git-transitions";
import WorkbenchCoreGitFeature from "./WorkbenchCoreGitFeature";
import WorkbenchCoreProjectsFeature from "./WorkbenchCoreProjectsFeature";
import WorkbenchCoreStatsFeature from "./WorkbenchCoreStatsFeature";
import WorkbenchCoreSubagentsFeature from "./WorkbenchCoreSubagentsFeature";
import WorkbenchCoreThreadLookup from "./WorkbenchCoreThreadLookup";
import WorkbenchInteractionsFeature from "./WorkbenchInteractionsFeature";
import WorkbenchThreadFactsFeature from "./WorkbenchThreadFactsFeature";
import WorkbenchTurnRuntimeFeature, { type WorkbenchCoreTranscript } from "./WorkbenchTurnRuntimeFeature";

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
  transcript: WorkbenchCoreTranscript,
  threadIdentity: DaemonRuntimeObjects["threadIdentity"],
  transcriptIdentity: DaemonRuntimeObjects["transcriptIdentity"],
  turnRecovery: DaemonRuntimeObjects["turnRecovery"],
  threadTransitions: DaemonRuntimeObjects["threadTransitions"],
  /** A fresh daemon process: no turn a previous process left running is owned here unless its provider says so. */
  coldStart: boolean,
  initialCatalog?: WorkbenchProjectStartup,
  approvalHandoff?: WorkbenchApprovalHandoff,
  messageWaitHandoff?: WorkbenchMessageWaitHandoff,
  subagentQueueHandoff?: WorkbenchSubagentQueueHandoff,
) {
  /** Compaction holds attempted before this generation existed belong to no queue it will deliver. */
  const generationStartedAt = Date.now();
  const modules = createModules();
  const projects = new WorkbenchCoreProjectsFeature({ context, database, initialCatalog });
  const { catalog: projectCatalog, settings } = projects;
  const worktreeGitTransitions = createWorktreeGitTransitions(threadTransitions);
  const logThreadStateWarning = (message: string) => {
    console.warn("[thread-state-ws]", message.slice(0, 500));
  };
  let threadState: WorkbenchThreadStateFeature | null = null;
  /** Turn runtime and thread facts are wired before thread state exists; their facts reach the index once it does. */
  let threadSummaries: WorkbenchThreadSummaryIndex | null = null;
  let threadBusy: WorkbenchThreadBusyTracker | null = null;
  let coreStats: WorkbenchCoreStatsFeature | null = null;
  const setSummaryFacts = (threadId: string, facts: Parameters<WorkbenchThreadSummaryIndex["setFacts"]>[1]) => {
    threadSummaries?.setFacts(threadId, facts);
    if (facts.compacting !== undefined) threadBusy?.setCompacting(threadId, facts.compacting);
  };
  const lookup = new WorkbenchCoreThreadLookup({ identities: threadIdentity, providers: () => providers, threadState: () => threadState });
  const turns = new WorkbenchTurnRuntimeFeature({
    context, database, transcript, turnRecovery, identities: threadIdentity, lookup, settings, projectCatalog, run,
    providers: () => providers,
    setSummaryFacts,
    readPendingApproval: threadId => interactions.readPendingApproval(threadId),
    shells: getProcessWorkbenchAgentMcpRequestRegistry(),
    warn: logThreadStateWarning,
  });
  let stopShellObservation: (() => void) | null = null;
  const undeliveredMessagesOwner = {};
  const { admission, autoCompact, compaction, contextRollover: threadContextRollover, continuations, turnLiveness, turnSettlement } = turns;
  const { transcriptReader, transcriptReconciliation } = turns;
  const facts = new WorkbenchThreadFactsFeature({
    context, database, transcript, lookup, projectCatalog, settings, run, lease,
    providers: () => providers,
    harnesses: () => harnesses,
    publishRuntime: (threadId, change) => turns.publish(threadId, change),
    setSummaryFacts,
  });
  const { agentContext, skillCatalog, vis } = facts;
  const providers = new WorkbenchProviderDispatcher(run, {
    instructionSelection: facts.instructionSelection,
    messageAdmission: autoCompact.run.bind(autoCompact),
    onAgentMessageAdmitted: (threadId, message) => run(
      "messages", owner => { owner.receive(threadId, message); }, "agent message admission",
    ),
    onMessageAdmitted: async admitted => {
      const identity = await threadIdentity.resolve({
        harness: admitted.harness,
        threadId: WorkbenchThreadIdSchema.parse(admitted.threadId),
      });
      if (!identity) throw new Error("Accepted message has no canonical Workbench thread identity.");
      await lookup.requireThreadState().controller.acceptAdmission(
        identity.projectId,
        admitted.harness,
        identity.threadId,
        { kind: admitted.kind, turnId: WorkbenchTurnIdSchema.parse(admitted.turnId) },
        admitted.firstMessagePreview,
      );
    },
  });
  const harnesses = new WorkbenchHarnessController({
    providers,
    identities: threadIdentity,
  });
  const profileStore = new WorkbenchComposerProfileStore(database);
  const modelUsage = new WorkbenchModelUsageStore(database);
  const voiceSettings = new VoiceSettingsStore(database);
  const git = new WorkbenchCoreGitFeature({
    database, transcript, identities: threadIdentity, projectCatalog, transitions: worktreeGitTransitions, agentContext,
    threadState: () => threadState,
    subagents: () => collaboration.subagents,
    stats: () => coreStats?.stats ?? null,
    approvals: () => interactions.approvals,
    activeTurn: async (threadId, harness) => {
      const turn = await lookup.provider(harness).threads.latestTurn(threadId);
      return turn?.status === "inProgress" ? WorkbenchTurnIdSchema.parse(turn.id) : null;
    },
    warn: logThreadStateWarning,
  });
  const { gitArc, threadGit, workingTree, gitPeer, branchPositions, gitCheckout } = git;
  coreStats = new WorkbenchCoreStatsFeature({
    context, database, providers, harnesses, projectCatalog, gitArc, run, warn: logThreadStateWarning,
  });
  const { stats, accountLimits } = coreStats;
  const threadStateFeature = threadState = new WorkbenchThreadStateFeature({
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
    settlementHold: threadId => facts.settlementHold(threadId),
    compactThread: input => threadContextRollover.acceptSummary(input),
    refreshThread: (harness, target) => continuations.refresh(harness, target),
    listSubagents: (projectId) => collaboration.subagents.listRelationships(projectId),
    log: logThreadStateWarning,
    resolveProjectById: (projectId) => projectCatalog.resolveProjectById(projectId),
    resolveProjectFromCwd: (cwd, options) => projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, options),
    transitions: worktreeGitTransitions,
    locks: threadTransitions,
    pruneThreadVis: threadIds => vis.prune(threadIds),
  });
  const threadStateController = threadStateFeature.controller;
  threadSummaries = new WorkbenchThreadSummaryIndex({
    resolveProject: async threadId => (await lookup.identity(threadId))?.projectId ?? null,
    peekProject: projectId => threadStateController.peekProject(projectId),
    readProject: projectId => threadStateController.readProject(projectId),
    subscribeProjects: listener => threadStateController.subscribeProjects(listener),
    seedFacts: () => database.readThreadSummaryFactSeeds(),
    warn: logThreadStateWarning,
  });
  const summaries = threadSummaries;
  const busyThreads = threadBusy = new WorkbenchThreadBusyTracker({
    readWorkingThreadIds: async () => (await Promise.all(installedProviderKeys.map(harness =>
      database.readThreadStateRecords({ selection: "working", harness })))).flat().map(record => record.identity.threadId),
    subscribe: listener => threadStateController.subscribe((_projectId, entry) => {
      if (entry.entryKind !== "draft") listener(entry.identity.threadId, entry.lifecycle.kind === "working");
    }),
    hold: reason => context.busy.hold("threads", reason),
    warn: logThreadStateWarning,
  });
  facts.endVisOnSettlement(listener => threadStateController.subscribe(listener));
  const collaboration = new WorkbenchCoreSubagentsFeature({
    database, transcript, identities: threadIdentity, lookup, projectCatalog, profileStore, threadState: threadStateFeature, facts, gitArc,
    approvals: () => interactions.approvals,
    questionnaires: () => interactions.questionnaires,
    threadActions: () => threadActions,
    messageWaitHandoff,
    subagentQueueHandoff,
  });
  const { subagents, messages, queues } = collaboration;
  const interactions = new WorkbenchInteractionsFeature({
    context, database, transcript, identities: threadIdentity, transcriptIdentity, commandApprovals, approvalHandoff, lookup,
    projectCatalog, threadState: threadStateFeature, agentContext, facts, harnesses, providers, turnLiveness, transcriptReader,
    publishRuntime: (threadId, change) => turns.publish(threadId, change),
    gitArc,
    warn: logThreadStateWarning,
  });
  const { approvalReview, approvals, questionnaires, questionnaireSteers, questionnaireResponses } = interactions;
  const mcpDownloads = new McpDownloadStore({
    directory: path.join(context.dataRootPath, ".cache", "mcp-downloads"),
    database,
    threads: {
      onSettled: listener => threadStateController.subscribe((_projectId, entry) => {
        if (entry.entryKind !== "draft" && entry.lifecycle.settled) listener(entry.identity.threadId);
      }),
      settled: async threadId => (await lookup.entry(threadId))?.lifecycle.settled ?? null,
    },
    onError: error => logError("mcp-downloads", `cleanup failed: ${error instanceof Error ? error.message : String(error)}`),
  });
  mcpDownloads.start();
  const mcpServers = new WorkbenchMcpServerController({ database, readDeviceIdentity, downloads: mcpDownloads });
  const threadActions = new WorkbenchThreadActionController({
    questionnaireSteers,
    autoCompact,
    compaction,
    approvals,
    reconciliation: transcriptReconciliation,
    transcripts: transcriptReader,
    transcript,
    shells: getProcessWorkbenchAgentMcpRequestRegistry(),
    settlement: turnSettlement,
    continuations,
    providers, projects: projectCatalog, identities: threadIdentity,
    profiles: threadStateFeature, state: threadStateController,
    skills: facts.skills, goals: facts.goals, todos: facts.todos, addressedFeedback: facts.addressedFeedback, vis,
    readSkills: threadId => facts.readThreadSkills(threadId),
    warn: message => logThreadStateWarning(message),
  });
  // A new turn retires the dead turns beneath it, then takes the agent messages they stranded.
  const unsubscribeTurnStarted = transcript.subscribeTurnStarted(async ({ threadId, turnId }) => {
    if (!lease.isCurrent()) return;
    // A newly live turn means any questionnaire its steers waited on was answered or dropped.
    if (await turnLiveness.turnStarted(threadId)) {
      void questionnaireSteers.release(threadId).catch(error => logThreadStateWarning(
        `Virtual steer release failed for ${threadId.slice(0, 120)}: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`));
    }
    await turnSettlement.settleSuperseded(threadId, turnId);
    if (lease.isCurrent()) await threadActions.resendUndeliveredAgentMessages(threadId, turnId);
  });
  // Message waits keep admitted mail until its recipient's model sees it.
  const unsubscribeAgentMessageDelivery = transcript.subscribeAgentMessageDelivery?.(({ threadId, message }) => {
    if (lease.isCurrent()) messages.delivered(threadId, message);
  }) ?? (() => undefined);
  const unsubscribeAutoCompactSettled = transcript.subscribeSettled(threadIds => {
    if (!lease.isCurrent()) return;
    void autoCompact.refreshObserved(threadIds);
    void turnLiveness.settled(threadIds);
  });
  // Held steers live outside the transcript stream, so open views learn about them from this push.
  const unsubscribeHeldSteers = transcript.subscribeHeldSteers(async ({ threadId, turnId }) => {
    if (!lease.isCurrent()) return;
    const harness = (await lookup.identity(threadId))?.bindings[0]?.harness;
    if (harness && lease.isCurrent()) {
      context.broadcastProviderNotification(WorkbenchHarnessSchema.parse(harness), {
        method: "steer/history/changed", params: { threadId, turnId },
      });
    }
  });
  const launches = new WorkbenchThreadLaunchController({
    readProjectSkills: projectId => skillCatalog.readActivatableSkills(projectId),
    database, projects: projectCatalog, actions: threadActions, threadState: threadStateFeature,
    addressedFeedback: facts.addressedFeedback,
    warn: message => logThreadStateWarning(message),
  });
  const { snapshot: projectSnapshot, search, store: projectStore, files: projectFiles } = projects;
  const daemonRequests = new WorkbenchDaemonRequestController({
    autoCompact,
    commandApprovals,
    approvalReview,
    mcpServers,
    projectStore,
    workingTree,
    branchPositions,
    gitCheckout,
    providers,
    threadActions,
    launches,
    presentationExport: threadStateController,
    agents: skillCatalog,
    files: projectFiles,
    gitArc,
    nativeFiles: new WorkbenchNativeFileController(projectCatalog),
    profiles: profileStore,
    modelUsage,
    profileTargets: {
      readComposerProfileTarget: async (slot) => await threadStateController.readComposerProfileTarget(slot),
      setComposerProfileTarget: async (slot, selection) => await threadStateController.setComposerProfileTarget(slot, selection),
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
        const identity = await lookup.identity(threadId);
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
    browseSessionCleanup, daemonRequests, gitArc, gitPeer, branchPositions, harnesses, mcpServers, messages, modules, projectCatalog, projectSnapshot, projectStore, questionnaires, stats, subagents, subagentQueues: queues, threadGit, threadState: threadStateFeature, threadActions, threadSkills: facts.skills, threadTodos: facts.todos, transcriptReader, transcriptReconciliation,
    vis,
    threadContextRollover,
    workingTree,
    accountLimits,
    threadRuntime: turns.threadRuntime,
    threadSummaries: summaries,
    projectFiles,
    providerObservations: {
      observe: async (harness, observed) => {
        if (!lease.isCurrent()) return null;
        stats.observeProviderNotification(harness, observed);
        accountLimits.noteActivity(harness);
        const observation = await threadStateFeature.observeProviderNotification(harness, observed);
        if (!lease.isCurrent()) return null;
        const lifecycle = observation?.lifecycle ?? null;
        continuations.observe(harness, observed, lifecycle);
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
      stopShellObservation ??= turns.observeShells();
      // User steers wait in the transcript's held steers; agent messages in the message waits' undelivered mail.
      getProcessWorkbenchAgentMcpRequestRegistry().activateUndeliveredMessages(undeliveredMessagesOwner, async threadId => [
        ...await database.readTranscriptHasUndeliveredUserSteer(threadId) ? [{}] : [],
        ...messages.undeliveredSenders(threadId).map(senderThreadId => ({ senderThreadId })),
      ]);
      // Mail carried across a reload can outlive a delivery an earlier generation missed; the transcript is the truth.
      void (async () => {
        for (const threadId of messages.undeliveredThreadIds()) {
          for (const message of await database.readTranscriptDeliveredAgentMessages(threadId)) {
            if (lease.isCurrent()) messages.delivered(threadId, message);
          }
        }
      })().catch(error => logThreadStateWarning(
        `Undelivered agent mail reconciliation failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`));
      if (coldStart) void turnSettlement.startColdSweep();
      void compaction.retireStrandedBefore(generationStartedAt);
      void busyThreads.start();
      if (!initialCatalog) return;
      stats.start();
      browseSessionCleanup.start();
      void vis.start();
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
      compaction.beginRuntimeDrain();
      admission.beginRuntimeDrain();
      autoCompact.beginRuntimeDrain();
      launches.beginRuntimeDrain();
      messages.beginRuntimeDrain();
      subagents.beginRuntimeDrain();
    },
    dispose: async (reportPhase = () => undefined) => {
      stopShellObservation?.();
      stopShellObservation = null;
      getProcessWorkbenchAgentMcpRequestRegistry().releaseUndeliveredMessages(undeliveredMessagesOwner);
      facts.stopObserving();
      unsubscribeAutoCompactSettled();
      unsubscribeTurnStarted();
      unsubscribeHeldSteers();
      unsubscribeAgentMessageDelivery();
      busyThreads.dispose();
      summaries.dispose();
      facts.disposeVis();
      continuations.dispose();
      await threadContextRollover.dispose();
      await autoCompact.dispose();
      await admission.dispose();
      reportPhase("orphaned turn sweep disposal");
      await turnSettlement.dispose();
      reportPhase("transcript reconciliation disposal");
      await transcriptReconciliation.dispose();
      reportPhase("working-tree disposal");
      await workingTree.dispose();
      branchPositions.dispose();
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
      reportPhase("MCP server disposal");
      await mcpServers.dispose();
      await mcpDownloads.dispose();
      reportPhase("stats disposal");
      await stats.dispose();
      reportPhase("questionnaire disposal");
      await questionnaires.dispose();
      approvals.dispose();
      reportPhase("thread-state disposal");
      await threadStateFeature.dispose();
      reportPhase("composer profile disposal");
      await voiceSettings.dispose();
      await profileStore.dispose();
      await modelUsage.dispose();
      reportPhase("search disposal");
      await search.dispose();
      reportPhase("project snapshot disposal");
      projectFiles.dispose();
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
      void vis.start();
      if (startupDiagnostics) console.info("[startup] daemon core ready");
    },
  });
}

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, import("../daemon-runtime-objects").DaemonProviderNotification>()({
  access: "agent",
  children: [WorkbenchTopologyNode, WorkbenchAgentCommandNode, WorkbenchMcpNode, CodexBridgeNode, OpenCodeBridgeNode, ClaudeBridgeNode, ProviderRuntimeNode, WorkbenchBrowseNode, WorkbenchVoiceNode, WorkbenchInstallationUpdateNode, WorkbenchWebSocketNode],
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
      get("threadTransitions"),
      mode === "initial",
      isReplacing("server:database") ? undefined : reloadState?.projectStartup,
      reloadState?.approvals,
      reloadState?.messageWaits,
      reloadState?.subagentQueues,
    );
  },
  description: "Reload core Workbench state, Git, project, harness, and supervisor code.",
  // Git subprocesses spawn from this worker so process creation never blocks the daemon event loop.
  entries: [path.join(__dirname, "..", "lib", "workbench", "git", "git-process-worker-bootstrap.mjs")],
  lifecycle: "atomic",
  provides: WORKBENCH_CORE_FEATURE_KEYS,
  requires: ["database", "commandApprovals", "reloadDirt", "transcript", "threadIdentity", "transcriptIdentity", "turnRecovery", "threadTransitions"],
  safeAll: true,
  scope: "server:core",
});
