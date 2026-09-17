/*
 * Exports:
 * - DaemonReloadableModules: helper modules consumed dynamically by persistent provider bridges.
 * - DaemonProviderNotification: provider event routed into the core node.
 * - DaemonCodexAppServerRuntime: persistent Codex app-server registration.
 * - DaemonBrowseExecution: warm Browse execution registration.
 * - DaemonDatabaseRegistration: mandatory SQLite lifecycle and typed statement registration.
 * - WorkbenchCodexSandboxNetworkController: server-owned Codex sandbox network settings.
 * - DaemonTranscriptRegistration: SQLite transcript recording and recovery registration.
 * - DaemonRuntimeObjects: centralized live object registry contract populated by reloadable nodes.
 */
import * as project from "./lib/project";
import type CodexThreadOperations from "./CodexThreadOperations";
import type CodexConfigurationController from "./CodexConfigurationController";
import * as threadBootstrap from "./lib/thread-bootstrap";
import * as workbenchPromptFiles from "./lib/workbench/instructions/WorkbenchPromptFiles";
import * as workbenchLibrary from "./lib/workbench-library";
import type { WorkbenchTranscriptSnapshot } from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import type { TranscriptStreamUpdate, TranscriptLiveUpdate } from "workbench-shared/workbench/transcript/thread-transcript-stream";
import type {
  WorkbenchDatabaseMutation,
  WorkbenchDatabaseQuery,
  WorkbenchDatabaseRow,
} from "workbench-shared/database/workbench-database-statements";
import type {
  WorkbenchTranscriptObservation,
  WorkbenchTranscriptContextSnapshot,
  WorkbenchTranscriptRecordingContext,
} from "./database/transcript/workbench-transcript-types";
import type { WorkbenchDatabaseMutationResult } from "./database/workbench-database-protocol";
import type { WorkbenchProjectPersistence, WorkbenchProjectStartup } from "./database/project/workbench-project-persistence";
import type { WorkbenchThreadIdentityDatabase } from "./database/thread-identity/workbench-thread-identity-types";
import type { WorkbenchSearchRequest, WorkbenchSearchResponse } from "workbench-shared/workbench/search/workbench-search";
import type { WorkbenchStatsReadRequest, WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import type { WorkbenchRateLimitObservation } from "./database/stats/WorkbenchStatsRepository";
import type { WorkbenchGitClaimSnapshot } from "./stats/git-claim-observation";
import type {
  WorkbenchGitClaimImportCandidate,
  WorkbenchGitClaimImportDiscovery,
  WorkbenchGitClaimImportSettlement,
  WorkbenchStatsUsageImportCandidate,
  WorkbenchStatsUsageImportSettlement,
} from "./database/stats/WorkbenchStatsImportRepository";
import type { WorkbenchStatsImportProgress } from "workbench-shared/workbench/stats/workbench-stats-contract";
import type { WorkbenchHarness } from "workbench-shared/types";
import type { ThreadContextUsageSnapshot } from "workbench-shared/workbench/thread/thread-context-usage";
import type BrowseSessionCleanupSupervisor from "./BrowseSessionCleanupSupervisor";
import type CodexAppServer from "./CodexAppServer";
import type CodexStdioBridge from "./CodexStdioBridge";
import type { CodexStdioBridgeReloadState } from "./CodexStdioBridge";
import type CodexLifecycleController from "./CodexLifecycleController";
import type WorkbenchCodexSandboxNetworkController from "./WorkbenchCodexSandboxNetworkController";
import type WorkbenchAgentCommandController from "./WorkbenchAgentCommandController";
import type WorkbenchAgentMcpController from "./WorkbenchAgentMcpController";
import type WorkbenchToolRevisionController from "./WorkbenchToolRevisionController";
import type WorkbenchCodexInstructionAdapter from "./WorkbenchCodexInstructionAdapter";
import type WorkbenchDaemonRequestController from "./WorkbenchDaemonRequestController";
import type WorkbenchThreadActionController from "./WorkbenchThreadActionController";
import type WorkbenchBrowseController from "./WorkbenchBrowseController";
import type WorkbenchGitArcFeature from "./WorkbenchGitArcFeature";
import type WorkbenchHarnessController from "./WorkbenchHarnessController";
import type WorkbenchDaemonHttpRouter from "./WorkbenchDaemonHttpRouter";
import type WorkbenchDaemonReloadController from "./WorkbenchDaemonReloadController";
import type WorkbenchReloadDirtController from "./WorkbenchReloadDirtController";
import type WorkbenchProjectCatalogController from "./WorkbenchProjectCatalogController";
import type WorkbenchProjectSnapshotController from "./WorkbenchProjectSnapshotController";
import type WorkbenchQuestionnaireController from "./WorkbenchQuestionnaireController";
import type WorkbenchSubagentFeature from "./WorkbenchSubagentFeature";
import type WorkbenchThreadGitFeature from "./WorkbenchThreadGitFeature";
import type WorkbenchThreadStateFeature from "./WorkbenchThreadStateFeature";
import type { WorkbenchThreadStateStoreDatabase } from "./WorkbenchThreadStateStore";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import type WorkbenchTranscriptIdentityController from "./WorkbenchTranscriptIdentityController";
import type { WorkbenchTranscriptIdentityDatabase } from "./database/transcript/workbench-transcript-types";
import type WorkbenchTurnRecoveryController from "./WorkbenchTurnRecoveryController";
import type CodexRecoveryController from "./CodexRecoveryController";
import type WorkbenchWebSocketRequestController from "./WorkbenchWebSocketRequestController";
import type WorkbenchStatsController from "./stats/WorkbenchStatsController";
import type WorkbenchProvider from "./WorkbenchProvider";

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
}

export interface DaemonBrowseExecution {
  cleanupStaleInactiveSessions(options: Parameters<WorkbenchBrowseController["cleanupStaleInactiveSessions"]>[0]): Promise<void>;
  executeBrowseRequest(body: Buffer, signal: AbortSignal): Promise<Response>;
  executeSessionRequest(request: { body: Buffer; method: string; url: string }, signal: AbortSignal): Promise<Response>;
  handleBrowseHttpRequest: WorkbenchBrowseController["handleBrowseHttpRequest"];
  handleSessionsHttpRequest: WorkbenchBrowseController["handleSessionsHttpRequest"];
  initialize(): Promise<void>;
}

export interface DaemonDatabaseRegistration extends WorkbenchThreadIdentityDatabase, WorkbenchTranscriptIdentityDatabase,
  Pick<import("./database/thread-state/workbench-thread-state-persistence").WorkbenchSubagentPersistence,
    "readSubagents" | "readOwnedSubagents" | "reserveSubagent" | "activateSubagent" | "removeSubagent">,
  WorkbenchThreadStateStoreDatabase,
  WorkbenchProjectPersistence {
  readInitialProjectCatalog(): WorkbenchProjectStartup;
  queryTranscript(request: import("./database/transcript/transcript-query-contract").TranscriptQuery): Promise<import("./database/transcript/transcript-query-contract").TranscriptQueryPage>;
  readThreadContextUsage(threadId: string): Promise<ThreadContextUsageSnapshot | null>;
  readTranscriptProviderCursor?(threadId: string, turnId: string): Promise<string | null | undefined>;
  readTranscriptContext?(threadId: string): Promise<WorkbenchTranscriptContextSnapshot | null>;
  assertReady(): void;
  close(): Promise<void>;
  executeTransaction(statements: readonly WorkbenchDatabaseMutation[]): Promise<WorkbenchDatabaseMutationResult>;
  readonly failure: Error | null;
  query<Row extends WorkbenchDatabaseRow>(statement: WorkbenchDatabaseQuery<Row>): Promise<Row[]>;
  readGitArcProposalDiff(identity: import("./lib/workbench/git/GitArcProposalDiffController").GitArcProposalDiffCacheIdentity): Promise<import("workbench-shared/workbench/git/checkpoint-contracts").GitCheckpointFileChange[] | null>;
  writeGitArcProposalDiff(value: import("./lib/workbench/git/GitArcProposalDiffController").GitArcProposalDiffCacheValue, maxBytes: number): Promise<void>;
  writeTranscriptAsset: import("./database/WorkbenchDatabaseController").default["writeTranscriptAsset"];
  readTranscriptAsset: import("./database/WorkbenchDatabaseController").default["readTranscriptAsset"];
  readLegacyDiffArtifact: import("./database/WorkbenchDatabaseController").default["readLegacyDiffArtifact"];
  executeThreadGitSelection: import("./database/WorkbenchDatabaseController").default["executeThreadGitSelection"];
  readStats(request: WorkbenchStatsReadRequest): Promise<WorkbenchStatsResponse>;
  readStatsDetailed(request: import("workbench-shared/workbench/stats/workbench-stats-detail-contract").WorkbenchStatsDetailedReadRequest): Promise<import("workbench-shared/workbench/stats/workbench-stats-detail-contract").WorkbenchStatsDetailedResponse>;
  readClaimStats(request: import("workbench-shared/workbench/stats/workbench-stats-claims-contract").WorkbenchClaimStatsRequest): Promise<import("workbench-shared/workbench/stats/workbench-stats-claims-contract").WorkbenchClaimStatsResponse>;
  beginStatsImport(runId: string, harnesses: WorkbenchHarness[], now: number): Promise<WorkbenchStatsImportProgress>;
  addStatsClaimDiscoveries(runId: string, discoveries: WorkbenchGitClaimImportDiscovery[], now: number): Promise<WorkbenchStatsImportProgress>;
  claimStatsUsageImport(runId: string, harnesses: WorkbenchHarness[], now: number): Promise<WorkbenchStatsUsageImportCandidate | null>;
  claimStatsClaimImport(runId: string, now: number): Promise<WorkbenchGitClaimImportCandidate | null>;
  settleStatsUsageImport(runId: string, candidate: WorkbenchStatsUsageImportCandidate, settlement: WorkbenchStatsUsageImportSettlement, now: number): Promise<WorkbenchStatsImportProgress>;
  settleStatsClaimImport(runId: string, candidate: WorkbenchGitClaimImportCandidate, settlement: WorkbenchGitClaimImportSettlement, now: number): Promise<WorkbenchStatsImportProgress>;
  repairStatsAttributions(now: number, threadId?: string | null): Promise<WorkbenchDatabaseMutationResult>;
  readStatsImportProgress(state: WorkbenchStatsImportProgress["state"], revision: number, unsupportedClaimCheckpoints?: number): Promise<WorkbenchStatsImportProgress>;
  replaceSearchProjectFiles(projectId: string, paths: readonly string[]): Promise<void>;
  replaceSearchProjects(projects: readonly { id: string; name: string; rootPath: string }[]): Promise<void>;
  recordStatsClaimSnapshot(snapshot: WorkbenchGitClaimSnapshot): Promise<void>;
  recordStatsRateLimits(observation: WorkbenchRateLimitObservation): Promise<void>;
  search(request: WorkbenchSearchRequest): Promise<WorkbenchSearchResponse>;
  start(): Promise<object>;
  readonly state: import("./database/workbench-database-protocol").WorkbenchDatabaseControllerState;
}

export interface DaemonTranscriptRegistration {
  acceptLiveUpdate?(update: TranscriptLiveUpdate): void;
  registerLiveBoundary?(boundary: (operation: () => Promise<void>) => Promise<void>): () => void;
  assertReady(): void;
  captureProviderGap(threadId: string, error: unknown): Promise<Error>;
  dispose(): void;
  readonly failure: Error | null;
  readonly pendingRecoveryThreadIds: Promise<readonly string[]>;
  read(request: { threadId: string; beforeTurnIndex?: number; turnIds?: string[]; turnLimit: number }): Promise<WorkbenchTranscriptSnapshot | null>;
  readMaterializedTurnIds(threadId: string, turnIds: readonly string[]): Promise<string[]>;
  record(
    observations: readonly WorkbenchTranscriptObservation[],
    context: WorkbenchTranscriptRecordingContext,
  ): Promise<{ changedThreadIds: string[] }>;
  start(): Promise<void>;
  subscribe(subscription: {
    id: string;
    request: { threadId: string; turnIds?: string[]; turnLimit: number };
    publish(snapshot: WorkbenchTranscriptSnapshot | null): void | Promise<void>;
    publishStream?(update: TranscriptStreamUpdate): void;
  }): Promise<void>;
  unsubscribe(id: string): void;
}


export interface DaemonRuntimeObjects {
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
  codexTools: import("./CodexToolsController").default;
  codexProvider: WorkbenchProvider;
  agentCommand: WorkbenchAgentCommandController;
  browseExecution: DaemonBrowseExecution;
  browseSessionCleanup: BrowseSessionCleanupSupervisor;
  codexAppServer: DaemonCodexAppServerRuntime;
  codexBridge: CodexStdioBridge;
  toolRevision: WorkbenchToolRevisionController;
  codexSandboxNetwork: WorkbenchCodexSandboxNetworkController;
  codexInstructions: WorkbenchCodexInstructionAdapter;
  database: DaemonDatabaseRegistration;
  daemonRequests: WorkbenchDaemonRequestController;
  threadActions: WorkbenchThreadActionController;
  gitArc: WorkbenchGitArcFeature;
  harnesses: WorkbenchHarnessController;
  mcp: WorkbenchAgentMcpController;
  modules: DaemonReloadableModules;
  daemonHttp: WorkbenchDaemonHttpRouter;
  projectCatalog: WorkbenchProjectCatalogController;
  projectSnapshot: WorkbenchProjectSnapshotController;
  questionnaires: WorkbenchQuestionnaireController;
  reloadController: WorkbenchDaemonReloadController;
  reloadDirt: WorkbenchReloadDirtController;
  subagents: WorkbenchSubagentFeature;
  stats: WorkbenchStatsController;
  threadGit: WorkbenchThreadGitFeature;
  threadIdentity: WorkbenchThreadIdentityController;
  transcriptIdentity: WorkbenchTranscriptIdentityController;
  threadState: WorkbenchThreadStateFeature;
  transcript: DaemonTranscriptRegistration;
  turnRecovery: WorkbenchTurnRecoveryController;
  codexRecovery: CodexRecoveryController;
  webSocketRequests: WorkbenchWebSocketRequestController;
}
