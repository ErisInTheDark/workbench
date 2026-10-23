/*
 * Exports:
 * - DaemonReloadableModules: helper modules consumed dynamically by persistent provider bridges.
 * - DaemonProviderNotification: provider event routed into the core node.
 * - DaemonCodexAppServerRuntime: persistent Codex app-server registration.
 * - DaemonBrowseExecution: warm Browse execution registration.
 * - DaemonDatabaseRegistration: mandatory SQLite lifecycle and typed statement registration.
 * - DaemonTranscriptRegistration: SQLite transcript recording and recovery registration.
 * - DaemonRuntimeObjects: centralized live object registry contract populated by reloadable nodes.
 */
import * as project from "./lib/project";
import type CodexThreadOperations from "./providers/codex/CodexThreadOperations";
import type WorkbenchDaemonSleepController from "./WorkbenchDaemonSleepController";
import type CodexConfigurationController from "./providers/codex/CodexConfigurationController";
import * as threadBootstrap from "./lib/thread-bootstrap";
import * as workbenchPromptFiles from "./lib/workbench/instructions/WorkbenchPromptFiles";
import * as workbenchLibrary from "./lib/workbench-library";
import type { WorkbenchTranscriptSnapshot } from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import type { TranscriptStreamUpdate, TranscriptLiveUpdate } from "workbench-shared/workbench/transcript/thread-transcript-stream";
import type {
  WorkbenchTranscriptObservation,
  WorkbenchTranscriptRecordingContext,
} from "./database/transcript/workbench-transcript-types";
import type WorkbenchDatabaseController from "./database/WorkbenchDatabaseController";
import type { WorkbenchDatabaseRequestMethods } from "./database/workbench-database-requests";
import type { WorkbenchHarness } from "workbench-shared/types";
import type { ThreadContextUsageSnapshot } from "workbench-shared/workbench/thread/thread-context-usage";
import type BrowseSessionCleanupSupervisor from "./browse/BrowseSessionCleanupSupervisor";
import type CodexAppServer from "./providers/codex/CodexAppServer";
import type CodexStdioBridge from "./providers/codex/CodexStdioBridge";
import type { CodexStdioBridgeReloadState } from "./providers/codex/CodexStdioBridge";
import type CodexLifecycleController from "./providers/codex/CodexLifecycleController";
import type WorkbenchCodexSandboxNetworkController from "./providers/codex/WorkbenchCodexSandboxNetworkController";
import type WorkbenchCommandApprovalController from "./interactions/WorkbenchCommandApprovalController";
import type WorkbenchAgentCommandController from "./agent/WorkbenchAgentCommandController";
import type WorkbenchAgentMcpController from "./agent/WorkbenchAgentMcpController";
import type WorkbenchToolRevisionController from "./agent/WorkbenchToolRevisionController";
import type WorkbenchCodexInstructionAdapter from "./providers/codex/WorkbenchCodexInstructionAdapter";
import type WorkbenchDaemonRequestController from "./transport/WorkbenchDaemonRequestController";
import type WorkbenchInstallationUpdateController from "./runtime/WorkbenchInstallationUpdateController";
import type WorkbenchThreadActionController from "./thread/WorkbenchThreadActionController";
import type WorkbenchBrowseController from "./browse/WorkbenchBrowseController";
import type WorkbenchGitArcFeature from "./git/WorkbenchGitArcFeature";
import type WorkbenchHarnessController from "./providers/WorkbenchHarnessController";
import type WorkbenchDaemonHttpRouter from "./transport/WorkbenchDaemonHttpRouter";
import type WorkbenchDaemonReloadController from "./WorkbenchDaemonReloadController";
import type WorkbenchReloadDirtController from "./runtime/WorkbenchReloadDirtController";
import type WorkbenchProjectCatalogController from "./project/WorkbenchProjectCatalogController";
import type WorkbenchProjectSnapshotController from "./project/WorkbenchProjectSnapshotController";
import type WorkbenchQuestionnaireController from "./interactions/WorkbenchQuestionnaireController";
import type WorkbenchSubagentFeature from "./subagents/WorkbenchSubagentFeature";
import type WorkbenchThreadGitFeature from "./thread/WorkbenchThreadGitFeature";
import type WorkbenchThreadStateFeature from "./thread/WorkbenchThreadStateFeature";
import type WorkbenchThreadIdentityController from "./thread/WorkbenchThreadIdentityController";
import type WorkbenchTranscriptIdentityController from "./transcript/WorkbenchTranscriptIdentityController";
import type WorkbenchTurnRecoveryController from "./WorkbenchTurnRecoveryController";
import type WorkbenchWebSocketRequestController from "./WorkbenchWebSocketRequestController";
import type WorkbenchStatsController from "./stats/WorkbenchStatsController";
import type WorkbenchProvider from "./providers/WorkbenchProvider";

export type DaemonReloadableModules = {
  project: Pick<typeof project, "isPathWithinRoot">;
  threadBootstrap: Pick<typeof threadBootstrap, "buildThreadTitleBootstrapInstructions" | "normalizeThreadTitle">;
  workbenchLibrary: Pick<typeof workbenchLibrary, "buildWorkbenchLibraryBootstrapInstructions">;
  workbenchPromptFiles: Pick<typeof workbenchPromptFiles, "buildWorkbenchPromptInstructions" | "buildWorkbenchThreadUtilityDeveloperInstructions" | "filterWorkbenchInstructionContent" | "listWorkbenchInstructionMechanics" | "ensureWorkbenchPromptFiles">;
};

export interface DaemonProviderNotification {
  harness: WorkbenchHarness;
  observation: import("workbench-shared/workbench/provider/provider-observation").WorkbenchProviderObservation;
}

export interface DaemonCodexAppServerRuntime {
  appServer: CodexAppServer;
  attachBridge(bridge: CodexStdioBridge, options?: { publish?: boolean }): void;
  deactivateBridge(bridge: CodexStdioBridge): void;
  beginBridgeHandoff(bridge: CodexStdioBridge, options?: Parameters<CodexStdioBridge["detachForReload"]>[0]): import("../../shared/reload/ReloadableNode").ReloadableNodeHandoff;
  detachBridge(bridge: CodexStdioBridge, options?: Parameters<CodexStdioBridge["detachForReload"]>[0]): Promise<CodexStdioBridgeReloadState>;
  isAvailable(): boolean;
  isTransitioning(): boolean;
  waitUntilReady(): Promise<void>;
}

export interface DaemonBrowseExecution {
  cleanupStaleInactiveSessions(options: Parameters<WorkbenchBrowseController["cleanupStaleInactiveSessions"]>[0]): Promise<void>;
  executeBrowseRequest(body: Buffer, signal: AbortSignal): Promise<Response>;
  executeSessionRequest(request: { body: Buffer; method: string; url: string }, signal: AbortSignal): Promise<Response>;
  handleBrowseHttpRequest: WorkbenchBrowseController["handleBrowseHttpRequest"];
  handleSessionsHttpRequest: WorkbenchBrowseController["handleSessionsHttpRequest"];
  initialize(): Promise<void>;
}

/** Every registered database request plus the lifecycle and hand-written reads the daemon uses. */
export interface DaemonDatabaseRegistration extends WorkbenchDatabaseRequestMethods, Pick<WorkbenchDatabaseController,
  "assertReady" | "close" | "failure" | "query" | "queryHistory" | "readInitialProjectCatalog" | "readStats" | "start" | "state"> {}

export interface DaemonTranscriptRegistration {
  isThreadObserved(threadId: string): boolean;
  acceptLiveUpdate?(update: TranscriptLiveUpdate): void;
  acceptApprovalOutcome(entry: import("workbench-shared/workbench/provider/provider-approval").WorkbenchApprovalOutcomeEntry): void;
  assertReady(): void;
  captureProviderGap(threadId: string, error: unknown): Promise<Error>;
  dispose(): void;
  readonly failure: Error | null;
  readonly pendingRecoveryThreadIds: Promise<readonly string[]>;
  prefetch(
    request: import("workbench-shared/workbench/database/transcript/workbench-transcript-contract").WorkbenchTranscriptPrefetchRequest,
  ): Promise<import("workbench-shared/workbench/database/transcript/workbench-transcript-contract").WorkbenchTranscriptPrefetchResult>;
  readRecoveryGaps(threadId: import("workbench-shared/workbench/identity").WorkbenchThreadId): Promise<import("./database/transcript/WorkbenchTranscriptCaptureGapController").WorkbenchTranscriptCaptureGapEntry[]>;
  read(request: { threadId: string; beforeTurnIndex?: number; turnIds?: string[]; turnLimit: number }): Promise<WorkbenchTranscriptSnapshot | null>;
  readContextUsage(threadId: string): Promise<ThreadContextUsageSnapshot | null>;
  readMaterializedTurnIds(threadId: string, turnIds: readonly string[]): Promise<string[]>;
  readAbandonedHoldThreadIds(before: number, scope?: "compactionQueue"): Promise<string[]>;
  record(
    observations: readonly WorkbenchTranscriptObservation[],
    context: WorkbenchTranscriptRecordingContext,
  ): Promise<import("./database/transcript/workbench-transcript-types").WorkbenchTranscriptSettlement>;
  start(): Promise<void>;
  subscribeItemActivity(
    listener: (activity: import("./database/transcript/WorkbenchTranscriptController").WorkbenchTranscriptItemActivity) => Promise<void> | void,
  ): () => void;
  subscribeContextCompaction(
    listener: (
      completion: import("./database/transcript/workbench-transcript-types").WorkbenchTranscriptCompactionCompletion,
    ) => Promise<void> | void,
  ): () => void;
  subscribeTurnStarted(
    listener: (event: import("./database/transcript/WorkbenchTranscriptController").WorkbenchTranscriptTurnEvent) => Promise<void> | void,
  ): () => void;
  /** Optional: transcript generations from before agent-message delivery publication lack it. */
  subscribeAgentMessageDelivery?(
    listener: (event: import("./database/transcript/WorkbenchTranscriptController").WorkbenchTranscriptAgentMessageDelivery) => Promise<void> | void,
  ): () => void;
  subscribeHeldSteers(
    listener: (event: import("./database/transcript/WorkbenchTranscriptController").WorkbenchTranscriptTurnEvent) => Promise<void> | void,
  ): () => void;
  subscribeSettled(listener: (threadIds: readonly string[]) => void): () => void;
  subscribe(subscription: {
    id: string;
    request: { threadId: string; turnIds?: string[]; turnLimit: number };
    publish(snapshot: WorkbenchTranscriptSnapshot | null): void | Promise<void>;
    publishStream?(update: TranscriptStreamUpdate): void;
  }): Promise<void>;
  unsubscribe(id: string): void;
}


export interface DaemonRuntimeObjects {
  agentContext: import("./agent/WorkbenchAgentContextController").default;
  threadSkills: import("./thread/WorkbenchThreadSkillsController").default;
  threadTodos: import("./thread/WorkbenchThreadTodoController").default;
  mcpServers: import("./mcp-servers/WorkbenchMcpServerController").default;
  vis: import("./vis/WorkbenchVisController").default;
  daemonSleep: WorkbenchDaemonSleepController;
  transcriptReader: import("./transcript/WorkbenchTranscriptReader").default;
  transcriptReconciliation: import("./transcript/WorkbenchTranscriptReconciliationController").default;
  voiceSettings: import("./voice/VoiceSettingsStore").default;
  voice: {
    controller: import("./voice/WorkbenchVoiceController").default;
    settings: import("./voice/VoiceSettingsStore").default;
    agents(): Promise<import("workbench-shared/types").WorkbenchAgentOption[]>;
  };
  providerObservations: {
    observe(
      harness: WorkbenchHarness,
      facts: import("workbench-shared/workbench/provider/provider-observation").WorkbenchProviderObservation,
    ): Promise<import("workbench-shared/workbench/thread/thread-state").WorkbenchThreadLifecycle | null>;
  };
  codexLifecycle: CodexLifecycleController;
  codexConfiguration: WorkbenchProvider["configuration"]["modelContext"] & {
    containsGlobalGuidance(sections: string[]): Promise<boolean[]>;
  };
  codexThreadOperations: CodexThreadOperations;
  codexNativeConfiguration: CodexConfigurationController;
  codexTools: import("./providers/codex/CodexToolsController").default;
  codexExecutor: import("./providers/codex/CodexExecServer").default;
  codexSandboxAcl: import("./providers/codex/CodexSandboxAclController").default;
  commandCapacity: import("./exec/WorkbenchCommandCapacity").default;
  shellRunner: import("./exec/WorkbenchShellRunner").default;
  codexProvider: WorkbenchProvider;
  openCodeService: import("./providers/opencode/OpenCodeServiceController").default;
  openCodeModelCatalog: {
    read(directory?: string): ReturnType<import("./providers/opencode/OpenCodeServiceController").default["readModelCatalog"]>;
  };
  openCodeThreadOperations: import("./providers/opencode/OpenCodeThreadOperations").default;
  openCodeProvider: WorkbenchProvider;
  claudeSessions: import("./providers/claude/ClaudeSessionHost").default;
  claudeThreadOperations: import("./providers/claude/ClaudeThreadOperations").default;
  claudeTranscriptAdapter: import("./providers/claude/ClaudeTranscriptAdapter").default;
  claudeConfiguration: import("./providers/claude/ClaudeConfigurationController").default;
  claudeProvider: WorkbenchProvider;
  agentCommand: WorkbenchAgentCommandController;
  browseExecution: DaemonBrowseExecution;
  browseSessionCleanup: BrowseSessionCleanupSupervisor;
  codexAppServer: DaemonCodexAppServerRuntime;
  codexBridge: CodexStdioBridge;
  toolRevision: WorkbenchToolRevisionController;
  repo: import("./git/WorkbenchRepoController").default;
  codexSandboxNetwork: WorkbenchCodexSandboxNetworkController;
  codexInstructions: WorkbenchCodexInstructionAdapter;
  database: DaemonDatabaseRegistration;
  commandApprovals: WorkbenchCommandApprovalController;
  daemonRequests: WorkbenchDaemonRequestController;
  installationUpdate: WorkbenchInstallationUpdateController;
  threadActions: WorkbenchThreadActionController;
  threadContextRollover: import("./turn/WorkbenchThreadContextRolloverController").default;
  gitArc: WorkbenchGitArcFeature;
  gitPeer: import("./git/WorkbenchGitPeerController").default;
  branchPositions: import("./git/WorkbenchBranchPositionController").default;
  harnesses: WorkbenchHarnessController;
  mcp: WorkbenchAgentMcpController;
  modules: DaemonReloadableModules;
  daemonHttp: WorkbenchDaemonHttpRouter;
  projectCatalog: WorkbenchProjectCatalogController;
  projectSnapshot: WorkbenchProjectSnapshotController;
  projectFiles: import("./project/WorkbenchProjectFileController").default;
  workingTree: import("./git/WorkbenchWorkingTreeController").default;
  accountLimits: import("./providers/WorkbenchAccountLimitsController").default;
  /** Per-thread live provider facts for thread observations. */
  threadRuntime: {
    /** Runtime for many observed thread entries from one batched read; entries it could not read are absent. */
    readMany(entries: readonly Exclude<import("workbench-shared/workbench/thread/thread-state").WorkbenchThreadSidebarEntry, { entryKind: "draft" }>[]): Promise<ReadonlyMap<string, import("workbench-shared/workbench/thread/thread-state").ThreadRuntime>>;
    readTokenUsage(threadId: string): Promise<import("workbench-shared/workbench/thread/thread-state").ThreadRuntime["tokenUsage"]>;
    /** `change` carries pushed values; null means token usage may have changed and must be reread. */
    subscribe(listener: (threadId: string, change: Partial<import("workbench-shared/workbench/thread/thread-state").ThreadRuntime> | null) => void): () => void;
  };
  /** Every observed thread's canonical summary: lean row plus live facts. */
  threadSummaries: import("./thread/WorkbenchThreadSummaryIndex").default;
  projectStore: import("./store/WorkbenchProjectStore").default;
  questionnaires: WorkbenchQuestionnaireController;
  approvals: import("./interactions/WorkbenchApprovalController").default;
  reloadController: WorkbenchDaemonReloadController;
  reloadDirt: WorkbenchReloadDirtController;
  messages: import("./thread/WorkbenchThreadMessageController").default;
  subagents: WorkbenchSubagentFeature;
  subagentQueues: import("./subagents/WorkbenchSubagentQueueController").default;
  stats: WorkbenchStatsController;
  threadGit: WorkbenchThreadGitFeature;
  threadIdentity: WorkbenchThreadIdentityController;
  /** Git transition and thread-state lock manager; its live table survives reloads through handoff. */
  threadTransitions: import("./turn/WorkbenchThreadTransitionCoordinator").default;
  transcriptIdentity: WorkbenchTranscriptIdentityController;
  threadState: WorkbenchThreadStateFeature;
  transcript: DaemonTranscriptRegistration;
  turnRecovery: WorkbenchTurnRecoveryController;
  webSocketRequests: WorkbenchWebSocketRequestController;
}
