/*
 * Exports:
 * - OrchestratorReloadableModules: helper modules consumed dynamically by persistent provider bridges. Keywords: bridge, module, reload.
 * - OrchestratorProviderNotification: provider event routed into the core node. Keywords: provider, notification, thread state.
 * - OrchestratorCodexAppServerRuntime/OrchestratorBrowseExecution: provider and Browse registrations. Keywords: runtime, lifecycle, registration.
 * - OrchestratorRuntimeObjects: centralized live object registry contract populated by reloadable nodes. Keywords: registry, ownership, graph.
 */
import * as project from "../lib/project";
import * as threadBootstrap from "../lib/thread-bootstrap";
import * as workbenchPromptFiles from "../lib/workbench/instructions/WorkbenchPromptFiles";
import * as workbenchLibrary from "../lib/workbench-library";
import type BrowseSessionCleanupSupervisor from "./BrowseSessionCleanupSupervisor";
import type CodexAppServer from "./CodexAppServer";
import type CodexStdioBridge from "./CodexStdioBridge";
import type { CodexStdioBridgeReloadState } from "./CodexStdioBridge";
import type CodexHealthMonitor from "./CodexHealthMonitor";
import type NextDevHealthSupervisor from "./NextDevHealthSupervisor";
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
  detachBridge(bridge: CodexStdioBridge): Promise<CodexStdioBridgeReloadState>;
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
  readonly failure: Error | null;
  start(): Promise<object>;
  readonly state: "starting" | "ready" | "failed" | "closed";
}

export interface OrchestratorTranscriptRegistration {
  dispose(): void;
  readonly failure: Error | null;
  read(request: { threadId: string; beforeTurnIndex?: number; turnIds?: string[]; turnLimit: number }): Promise<object | null>;
  record(observations: readonly object[]): Promise<{ changedThreadIds: string[] }>;
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
  codexInstructions: WorkbenchCodexInstructionAdapter;
  database: OrchestratorDatabaseRegistration;
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
