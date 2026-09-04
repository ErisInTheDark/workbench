/*
 * Exports:
 * - OrchestratorReloadableModules: helper modules consumed dynamically by persistent provider bridges. Keywords: bridge, module, reload.
 * - OrchestratorProviderNotification: provider event routed into the core node. Keywords: provider, notification, thread state.
 * - OrchestratorCodexAppServerRuntime: persistent Codex app-server registration. Keywords: codex, runtime, lifecycle.
 * - OrchestratorBrowseExecution: warm Browse execution registration. Keywords: browse, runtime, lifecycle.
 * - OrchestratorDatabaseRegistration: mandatory SQLite lifecycle and typed statement registration. Keywords: database, readiness, lifecycle, statement.
 * - WorkbenchCodexSandboxNetworkController: server-owned Codex sandbox network settings. Keywords: Codex, sandbox, network, settings.
 * - OrchestratorTranscriptRegistration: SQLite transcript recording and recovery registration. Keywords: transcript, recovery, subscription.
 * - OrchestratorTranscriptShadowLog: bounded transcript diagnostic log registration. Keywords: transcript, diagnostics, log.
 * - OrchestratorRuntimeObjects: centralized live object registry contract populated by reloadable nodes. Keywords: registry, ownership, graph.
 */
import * as project from "../lib/project";
import * as threadBootstrap from "../lib/thread-bootstrap";
import * as workbenchPromptFiles from "../lib/workbench/instructions/WorkbenchPromptFiles";
import * as workbenchLibrary from "../lib/workbench-library";
import type { WorkbenchTranscriptSnapshot } from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import type {
  WorkbenchDatabaseMutation,
  WorkbenchDatabaseQuery,
  WorkbenchDatabaseRow,
} from "workbench-shared/database/workbench-database-statements";
import type {
  WorkbenchTranscriptObservation,
  WorkbenchTranscriptRecordingContext,
} from "./database/transcript/workbench-transcript-types";
import type { WorkbenchDatabaseMutationResult } from "./database/workbench-database-protocol";
import type {
  WorkbenchThreadStateShadowRefresh,
  WorkbenchThreadStateShadowStatus,
} from "./database/thread-state/workbench-thread-state-shadow-types";
import type BrowseSessionCleanupSupervisor from "./BrowseSessionCleanupSupervisor";
import type CodexAppServer from "./CodexAppServer";
import type CodexStdioBridge from "./CodexStdioBridge";
import type { CodexStdioBridgeReloadState } from "./CodexStdioBridge";
import type CodexHealthMonitor from "./CodexHealthMonitor";
import type WorkbenchCodexSandboxNetworkController from "./WorkbenchCodexSandboxNetworkController";
import type OpenCodeAppServer from "./OpenCodeAppServer";
import type { OpenCodeBridge } from "./opencode-bridge";
import * as copilotThreadState from "./copilot-thread-state";
import * as opencodeLiveThreadState from "./opencode-live-thread-state";
import * as opencodeThreadState from "./opencode-thread-state";
import * as opencodeWorkbenchInstructions from "./opencode-workbench-instructions";
import type WorkbenchAgentCommandController from "./WorkbenchAgentCommandController";
import type WorkbenchAgentMcpController from "./WorkbenchAgentMcpController";
import type WorkbenchBridgeRequestController from "./WorkbenchBridgeRequestController";
import type WorkbenchCodexMcpGenerationController from "./WorkbenchCodexMcpGenerationController";
import type WorkbenchCodexInstructionAdapter from "./WorkbenchCodexInstructionAdapter";
import type WorkbenchDaemonRequestController from "./WorkbenchDaemonRequestController";
import type WorkbenchBrowseController from "./WorkbenchBrowseController";
import type WorkbenchGitArcFeature from "./WorkbenchGitArcFeature";
import type WorkbenchHarnessController from "./WorkbenchHarnessController";
import type WorkbenchLegacyMigrationSourceController from "./WorkbenchLegacyMigrationSourceController";
import type WorkbenchOrchestratorHttpRouter from "./WorkbenchOrchestratorHttpRouter";
import type WorkbenchOrchestratorReloadController from "./WorkbenchOrchestratorReloadController";
import type WorkbenchReloadDirtController from "./WorkbenchReloadDirtController";
import type WorkbenchProjectCatalogController from "./WorkbenchProjectCatalogController";
import type WorkbenchProjectSnapshotController from "./WorkbenchProjectSnapshotController";
import type WorkbenchSubagentFeature from "./WorkbenchSubagentFeature";
import type WorkbenchThreadGitFeature from "./WorkbenchThreadGitFeature";
import type WorkbenchThreadStateFeature from "./WorkbenchThreadStateFeature";
import type WorkbenchTurnRecoveryController from "./WorkbenchTurnRecoveryController";
import type WorkbenchWebSocketRequestController from "./WorkbenchWebSocketRequestController";
import type WorkbenchTranscriptShadowLog from "./database/transcript/WorkbenchTranscriptShadowLog";
import type { HarnessKind, JsonRpcNotification } from "./bridge-types";

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

export interface OrchestratorCodexAppServerRuntime {
  appServer: CodexAppServer;
  attachBridge(bridge: CodexStdioBridge): void;
  detachBridge(bridge: CodexStdioBridge, options?: Parameters<CodexStdioBridge["detachForReload"]>[0]): Promise<CodexStdioBridgeReloadState>;
  isAvailable(): boolean;
  isTransitioning(): boolean;
}

export interface OrchestratorBrowseExecution {
  cleanupStaleInactiveSessions(options: Parameters<WorkbenchBrowseController["cleanupStaleInactiveSessions"]>[0]): Promise<void>;
  executeBrowseRequest(body: Buffer, signal: AbortSignal): Promise<Response>;
  executeSessionRequest(request: { body: Buffer; method: string; url: string }, signal: AbortSignal): Promise<Response>;
  handleBrowseHttpRequest: WorkbenchBrowseController["handleBrowseHttpRequest"];
  handleSessionsHttpRequest: WorkbenchBrowseController["handleSessionsHttpRequest"];
  initialize(): Promise<void>;
}

export interface OrchestratorDatabaseRegistration {
  assertReady(): void;
  close(): Promise<void>;
  executeTransaction(statements: readonly WorkbenchDatabaseMutation[]): Promise<WorkbenchDatabaseMutationResult>;
  readonly failure: Error | null;
  query<Row extends WorkbenchDatabaseRow>(statement: WorkbenchDatabaseQuery<Row>): Promise<Row[]>;
  rebuildThreadStateShadow(request: WorkbenchThreadStateShadowRefresh): Promise<WorkbenchThreadStateShadowStatus>;
  readThreadStateShadowStatus(): Promise<WorkbenchThreadStateShadowStatus | null>;
  recordThreadStateShadowFailure(request: WorkbenchThreadStateShadowRefresh): Promise<WorkbenchThreadStateShadowStatus>;
  start(): Promise<object>;
  readonly state: "starting" | "ready" | "failed" | "closed";
}

export interface OrchestratorTranscriptRegistration {
  assertCutoverReady(): void;
  assertReady(): void;
  captureProviderGap(threadId: string, error: unknown): Promise<Error>;
  readonly cutoverFailure: Error | null;
  dispose(): void;
  readonly failure: Error | null;
  readonly pendingRecoveryThreadIds: readonly string[];
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
    publish(snapshot: object | null): void | Promise<void>;
  }): Promise<void>;
  unsubscribe(id: string): void;
}

export type OrchestratorTranscriptShadowLog = Pick<WorkbenchTranscriptShadowLog, "flush" | "write">;

export interface OrchestratorRuntimeObjects {
  agentCommand: WorkbenchAgentCommandController;
  bridgeRequest: WorkbenchBridgeRequestController;
  browseExecution: OrchestratorBrowseExecution;
  browseSessionCleanup: BrowseSessionCleanupSupervisor;
  codexAppServer: OrchestratorCodexAppServerRuntime;
  codexBridge: CodexStdioBridge;
  codexHealth: CodexHealthMonitor;
  codexMcpGeneration: WorkbenchCodexMcpGenerationController;
  codexSandboxNetwork: WorkbenchCodexSandboxNetworkController;
  codexInstructions: WorkbenchCodexInstructionAdapter;
  database: OrchestratorDatabaseRegistration;
  daemonRequests: WorkbenchDaemonRequestController;
  gitArc: WorkbenchGitArcFeature;
  harnesses: WorkbenchHarnessController;
  legacyMigrationSource: WorkbenchLegacyMigrationSourceController;
  mcp: WorkbenchAgentMcpController;
  modules: OrchestratorReloadableModules;
  openCodeAppServer: OpenCodeAppServer;
  openCodeBridge: OpenCodeBridge;
  orchestratorHttp: WorkbenchOrchestratorHttpRouter;
  projectCatalog: WorkbenchProjectCatalogController;
  projectSnapshot: WorkbenchProjectSnapshotController;
  reloadController: WorkbenchOrchestratorReloadController;
  reloadDirt: WorkbenchReloadDirtController;
  subagents: WorkbenchSubagentFeature;
  threadGit: WorkbenchThreadGitFeature;
  threadState: WorkbenchThreadStateFeature;
  transcript: OrchestratorTranscriptRegistration;
  transcriptShadowLog: OrchestratorTranscriptShadowLog;
  turnRecovery: WorkbenchTurnRecoveryController;
  webSocketRequests: WorkbenchWebSocketRequestController;
}
