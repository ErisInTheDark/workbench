/*
 * Keywords: Codex, identity admission, ordered recording, recovery, bridge lifecycle.
 * Exports:
 * - CodexStdioBridgeOptions: inject app-server, browser, questionnaire, instruction, transcript, and reload-generation boundaries. Keywords: codex, bridge, questionnaire, options, reload.
 * - CodexStdioBridgeReloadState: transferable bridge state preserved across code-only reload. Keywords: codex, reload, state.
 * - default CodexStdioBridge: translate websocket requests, questionnaires, and Codex app-server messages around a stable app-server process. Keywords: codex, stdio, websocket, questionnaire, bridge.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ApplyPatchApprovalParams } from "workbench-shared/codex/generated/app-server/ApplyPatchApprovalParams";
import type { ExecCommandApprovalParams } from "workbench-shared/codex/generated/app-server/ExecCommandApprovalParams";
import type { ReviewDecision } from "workbench-shared/codex/generated/app-server/ReviewDecision";
import type { ServerRequest } from "workbench-shared/codex/generated/app-server/ServerRequest";
import type { ServerNotification } from "workbench-shared/codex/generated/app-server/ServerNotification";
import type { CommandExecutionApprovalDecision } from "workbench-shared/codex/generated/app-server/v2/CommandExecutionApprovalDecision";
import type { CommandExecutionRequestApprovalParams } from "workbench-shared/codex/generated/app-server/v2/CommandExecutionRequestApprovalParams";
import type { FileChangeApprovalDecision } from "workbench-shared/codex/generated/app-server/v2/FileChangeApprovalDecision";
import type { FileChangeRequestApprovalParams } from "workbench-shared/codex/generated/app-server/v2/FileChangeRequestApprovalParams";
import type { GrantedPermissionProfile } from "workbench-shared/codex/generated/app-server/v2/GrantedPermissionProfile";
import type { PermissionsRequestApprovalParams } from "workbench-shared/codex/generated/app-server/v2/PermissionsRequestApprovalParams";
import type { RequestPermissionProfile } from "workbench-shared/codex/generated/app-server/v2/RequestPermissionProfile";
import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import type { ThreadContextUsageSnapshot } from "workbench-shared/workbench/thread/thread-context-usage";
import { readCodexContextUsage, recoverCodexContextUsage } from "./codex-thread-context-usage";
import type { ThreadReadResponse } from "workbench-shared/codex/generated/app-server/v2/ThreadReadResponse";
import type { ThreadResumeResponse } from "workbench-shared/codex/generated/app-server/v2/ThreadResumeResponse";
import { getCurrentInProgressTurn, isThreadStatusActive } from "workbench-shared/codex/thread-state";
import type { ToolRequestUserInputParams } from "workbench-shared/codex/generated/app-server/v2/ToolRequestUserInputParams";
import type { ToolRequestUserInputQuestion } from "workbench-shared/codex/generated/app-server/v2/ToolRequestUserInputQuestion";
import type { ToolRequestUserInputResponse } from "workbench-shared/codex/generated/app-server/v2/ToolRequestUserInputResponse";
import type { TurnSteerResponse } from "workbench-shared/codex/generated/app-server/v2/TurnSteerResponse";
import type { UserInput } from "workbench-shared/codex/generated/app-server/v2/UserInput";
import type { WorkbenchThreadHydrationRequest } from "../lib/codex/thread-hydration";
import type {
    WorkbenchApprovalCommandContext,
    WorkbenchBrowseResultEntry,
    WorkbenchQuestionnaireHistoryEntry,
    WorkbenchSteerHistoryEntry,
    WorkbenchThreadContextReadResponse,
    WorkbenchUserInputQuestion,
    WorkbenchUserInputRequest,
    WorkbenchUserInputResponse,
} from "workbench-shared/types";
import type { resolveAgentEndpointProjectFromCwd } from "../lib/workbench/project/agent-endpoint-project";
import {
  readWorkbenchFileChangeFailureMarker,
  type WorkbenchFileChangeFailureMarker,
  type WorkbenchFileChangeItem,
} from "workbench-shared/workbench/thread/workbench-file-change";
import {
  WORKBENCH_TOOL_CONTEXT_METHOD,
  readWorkbenchToolOutput,
  type WorkbenchToolOutput,
} from "workbench-shared/workbench/thread/thread-tool-output";
import CodexFileChangeController, { type CodexFileChangeState } from "./CodexFileChangeController";
import {
  readWorkbenchThreadPageNextCursor,
  WORKBENCH_THREAD_PAGE_READ_METHOD,
  WorkbenchThreadPageReadParamsSchema,
  type WorkbenchThreadPageResponse,
} from "workbench-shared/workbench/thread/workbench-thread-page";
import { WorkbenchQuestionnaireHistoryEntrySchema } from "workbench-shared/workbench/thread/thread-state";
import type { BridgeClient, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type {
  WorkbenchTranscriptAtomicObservation,
  WorkbenchTranscriptObservation,
  WorkbenchTranscriptRecordingContext,
} from "./database/transcript/workbench-transcript-types.ts";
import {
  createCodexTranscriptSqliteImport,
} from "./codex-transcript-sqlite-import.ts";
import {
  createCodexTranscriptProviderDynamicToolObservation,
  createCodexTranscriptProviderItemObservation,
  createCodexTranscriptProviderThreadScopeObservation,
  createCodexTranscriptProviderThreadObservation,
  createCodexTranscriptProviderThreadObservations,
  createCodexTranscriptProviderTurnScopeObservation,
  createCodexTranscriptProviderTurnObservation,
  createCodexTurnTokenUsageObservationFromNotification,
  createCodexTurnUsageContextObservation,
  createCodexUsageImport,
  createCodexModelRerouteObservation,
  readCodexUsageContext,
  type CodexTranscriptProviderContext,
} from "./codex-transcript-provider-observations.ts";
import {
  createSteerHistoryEntryFromRequest,
  readSteerHistoryRequest,
  getJsonRpcErrorMessage,
  updateMatchingPendingSteerEntriesForUserMessage,
  updateNativeSteerEntriesForInterruptedTurn,
  updateNativeSteerEntriesForUserMessage,
  updatePendingSteerEntriesForInterruptedTurn,
  updateSteerEntryStatus,
} from "./codex-transcript-steer-history.ts";
import { getProcessWorkbenchAgentMcpRequestRegistry } from "./workbench-agent-mcp-request-registry";
import { CODEX_TRANSCRIPT_DIAGNOSTIC_INTERVAL_MS, createCodexTranscriptDiagnostic } from "./codex-transcript-diagnostics";
import { shouldRecordDurableTranscriptNotification } from "./codex-transcript-event-routing";
import {
  encodeTranscriptPathSegment,
  extractItem,
} from "./codex-transcript-normalizers";
import type CodexAppServer from "./CodexAppServer";
import type { WorkbenchCodexInstructionPort } from "./WorkbenchCodexInstructionAdapter";
import type WorkbenchQuestionnaireController from "./WorkbenchQuestionnaireController";
import CodexThreadPageReadController from "./CodexThreadPageReadController";
import CodexThreadWindowLoader, { type CodexThreadWindowStore } from "./CodexThreadWindowLoader";
import CodexTranscriptRecordingController, {
  CodexTranscriptSqliteRecordingFailure,
} from "./CodexTranscriptRecordingController";
import type { OrchestratorTranscriptShadowLog } from "./orchestrator-runtime-objects";
import { logError } from "./process-helpers";
import { WORKBENCH_PROMPT_CONTEXT_FIELD } from "./workbench-prompt-context";
import { admitProviderNotifications, admitProviderThreads } from "./thread-identity-provider-mapping";
import {
  admitNativeTranscriptObservations,
  mapNativeTranscriptObservation,
  type NativeTranscriptIdentityOwners,
} from "./thread-identity-transcript-mapping";

type CodexTranscriptStoreInstance = import("./CodexTranscriptStore").default;
type CodexTranscriptStoreConstructor = new (
  projectRoot: string,
  getProtectedThreadIds?: () => Iterable<string>,
  transcriptShadowLog?: OrchestratorTranscriptShadowLog,
  getRuntimeUserAgent?: () => string | null,
) => CodexTranscriptStoreInstance;

type PendingClientResponse = {
  client: BridgeClient;
  clientRequestId: number | string;
  internal: false;
  method: string | null;
  requestSource: WorkbenchRequestSource;
  threadHydration: WorkbenchThreadHydrationRequest | null;
  upstreamRequest: JsonRpcRequest;
};

type PendingInternalResponse = {
  internal: true;
  method: string | null;
  reject: (reason?: unknown) => void;
  requestSource: WorkbenchRequestSource;
  resolve: (value: JsonRpcResponse) => void;
  threadHydration: WorkbenchThreadHydrationRequest | null;
  upstreamRequest: JsonRpcRequest;
  toolContext?: {
    sent?: boolean;
    threadId: string;
    turnId: string;
    item: WorkbenchToolOutput;
    patch?: { itemId: string; approvalId: number | string | null };
  };
};

type PendingResponse = PendingClientResponse | PendingInternalResponse;

function isPendingInternalResponse(pending: PendingResponse): pending is PendingInternalResponse {
  return pending.internal === true;
}

export type CodexStdioBridgeOptions = {
  appServer: CodexAppServer;
  bridgeUrl: string;
  handleWorkbenchRequest: (request: JsonRpcRequest) => Promise<JsonRpcResponse>;
  initialState?: CodexStdioBridgeReloadState;
  instructions?: WorkbenchCodexInstructionPort;
  identities?: NativeTranscriptIdentityOwners;
  onAcceptedTurnSteer?: (threadId: string) => void;
  onNotification: (notification: JsonRpcNotification) => void;
  onInitialized?: () => void;
  prepareThreadConfiguration?: (
    thread: Thread,
    requests: { resumeRequest: JsonRpcRequest; startRequest: JsonRpcRequest },
    signal: AbortSignal,
  ) => Promise<{ resumeRequest: JsonRpcRequest; startRequest: JsonRpcRequest }>;
  prepareTurnStart?: (
    message: JsonRpcRequest,
    requestProvider: (request: JsonRpcRequest) => Promise<JsonRpcResponse>,
    signal: AbortSignal,
  ) => Promise<void>;
  questionnaires?: Pick<WorkbenchQuestionnaireController, "list" | "respond">;
  recordSqliteTranscript?: (
    observations: readonly WorkbenchTranscriptObservation[],
    context: WorkbenchTranscriptRecordingContext,
  ) => Promise<void>;
  readSqliteTranscriptMaterializedTurnIds?: (
    threadId: string,
    turnIds: readonly string[],
  ) => Promise<readonly string[]>;
  readSqliteContextUsage?: (threadId: string) => Promise<ThreadContextUsageSnapshot | null>;
  restartingAppServer?: boolean;
  resolveProjectFromCwd: typeof resolveAgentEndpointProjectFromCwd;
  sendToClient: (client: BridgeClient, message: unknown) => void;
  storageRoot: string;
  transcriptShadowLog?: OrchestratorTranscriptShadowLog;
};

const UNCONFIGURED_CODEX_INSTRUCTIONS: WorkbenchCodexInstructionPort = {
  augment: async (message) => {
    if (message[WORKBENCH_PROMPT_CONTEXT_FIELD] !== undefined) {
      throw new Error("Codex instruction adaptation is not configured.");
    }
    return message;
  },
  createThreadResume: () => { throw new Error("Codex instruction adaptation is not configured."); },
};

const UNCONFIGURED_WORKBENCH_QUESTIONNAIRES: Pick<WorkbenchQuestionnaireController, "list" | "respond"> = {
  list: () => ({ data: [] }),
  respond: async () => null,
};

type RequestIdAllocator = {
  next: number;
};

export type CodexStdioBridgeReloadState = {
  fileChanges?: CodexFileChangeState;
  fileChangeFailureMarkers?: Map<string, WorkbenchFileChangeFailureMarker>;
  fileChangeTurnCursors?: Map<string, string>;
  initializeResult: unknown;
  unmaterializedThreadIds?: Set<string>;
  pendingResponses: Map<number, PendingResponse>;
  retiringResponses?: Map<number, PendingResponse>;
  pendingUserInputRequests: Map<string, PendingCodexUserInputRequest>;
  requestIdAllocator: RequestIdAllocator;
  transcriptActiveTurns?: Map<string, string>;
  transcriptSteers?: Map<string, WorkbenchSteerHistoryEntry>;
  transcriptThreadContexts?: Map<string, CodexTranscriptThreadContext>;
  upstreamInitialized: boolean;
};

type CodexTranscriptThreadContext = CodexTranscriptProviderContext & {
  usageContext?: ReturnType<typeof readCodexUsageContext>;
};

type CodexSqliteTranscriptObservation = WorkbenchTranscriptObservation;

function threadPageReadKey(message: JsonRpcRequest) {
  const params = WorkbenchThreadPageReadParamsSchema.parse(message.params);
  const fields = [params.threadId, params.cursor ?? "", params.cwd ?? "", params.readScope ?? ""];
  return fields.map((field) => `${field.length}:${field}`).join("|");
}

function transcriptSteerKey(threadId: string, entryKey: string) {
  return `${threadId}\0${entryKey}`;
}

type CodexStdioBridgeReloadOptions = {
  idleTimeoutMs?: number;
  restartingAppServer?: boolean;
};

type PendingCodexUserInputRequestBase = {
  itemId: string | null;
  request: WorkbenchUserInputRequest;
  requestKey: string;
  threadId: string;
  turnId: string | null;
  upstreamRequestId: number | string;
};

type PendingCodexQuestionnaire = PendingCodexUserInputRequestBase & {
  kind: "questionnaire";
};

type PendingCodexCommandExecutionApproval = PendingCodexUserInputRequestBase & {
  kind: "commandExecutionApproval";
  params: CommandExecutionRequestApprovalParams;
};

type PendingCodexFileChangeApproval = PendingCodexUserInputRequestBase & {
  kind: "fileChangeApproval";
  params: FileChangeRequestApprovalParams;
};

type PendingCodexPermissionsApproval = PendingCodexUserInputRequestBase & {
  kind: "permissionsApproval";
  params: PermissionsRequestApprovalParams;
};

type PendingCodexApplyPatchApproval = PendingCodexUserInputRequestBase & {
  kind: "applyPatchApproval";
  params: ApplyPatchApprovalParams;
};

type PendingCodexExecCommandApproval = PendingCodexUserInputRequestBase & {
  kind: "execCommandApproval";
  params: ExecCommandApprovalParams;
};

type PendingCodexUserInputRequest =
  | PendingCodexQuestionnaire
  | PendingCodexCommandExecutionApproval
  | PendingCodexFileChangeApproval
  | PendingCodexPermissionsApproval
  | PendingCodexApplyPatchApproval
  | PendingCodexExecCommandApproval;

type ApprovalDecisionChoice = "allow-once" | "allow-session" | "decline";

const APPROVAL_DECISION_QUESTION_ID = "decision";
const APPROVAL_ALLOW_ONCE_LABEL = "Allow once";
const APPROVAL_ALLOW_SESSION_LABEL = "Allow for session";
const APPROVAL_DECLINE_LABEL = "Decline";
const WORKBENCH_REQUEST_SOURCE_FIELD = "workbenchRequestSource";
const WORKBENCH_THREAD_HYDRATION_FIELD = "workbenchThreadHydration";
const WORKBENCH_THREAD_CONTEXT_ENTRIES_FIELD = "workbenchThreadContextEntries";
type WorkbenchRequestSource = "autoRefresh" | "internal" | "sqliteRecovery" | "user";

type PendingCompatibilityWindowImport = {
  thread: Thread;
};

function transcriptCompatibilityWindowKey(thread: Thread) {
  return [thread.id, ...thread.turns.map(({ id }) => id)]
    .map((part) => `${part.length}:${part}`)
    .join("|");
}

function isJsonRpcResponse(message: unknown): message is JsonRpcResponse {
  return !!message
    && typeof message === "object"
    && "id" in message
    && ("result" in message || "error" in message);
}

function isJsonRpcNotification(message: unknown): message is JsonRpcNotification {
  return !!message
    && typeof message === "object"
    && "method" in message
    && "params" in message
    && !("id" in message);
}

function isJsonRpcServerRequest(message: unknown): message is ServerRequest {
  return !!message
    && typeof message === "object"
    && "id" in message
    && "method" in message
    && "params" in message
    && !("result" in message)
    && !("error" in message);
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function truncateText(value: string, maxLength = 400) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function sanitizeTranscriptErrorMessage(error: unknown) {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>]*/gu, "[path]")
    .replace(/(^|\s)\/(?:Users|home|private|tmp|var|etc|opt|srv|mnt)\/[^\s"'<>]*/giu, "$1[path]")
    .replace(/\b(Bearer\s+)[^\s,;]+/giu, "$1[redacted]")
    .replace(/\b(api[_-]?key|authorization|secret|token)(\s*[:=]\s*)[^\s,;]+/giu, "$1$2[redacted]");
  return truncateText(message, 1000) || "turn/steer transport failed.";
}

function shouldRecordHydratedThreadSnapshot(
  originalRequest: JsonRpcRequest,
  originalResponse: JsonRpcResponse,
  hydratedResponse: JsonRpcResponse,
) {
  return hydratedResponse !== originalResponse
    && asString(originalRequest.method) === "thread/read"
    && Boolean(originalResponse.error)
    && !hydratedResponse.error;
}

function readNotificationStringParam(notification: JsonRpcNotification, key: string) {
  return asString(asRecord(notification.params)?.[key]);
}

function readNotificationNumberParam(notification: JsonRpcNotification, key: string) {
  return asNumber(asRecord(notification.params)?.[key]);
}

function readRequestSource(message: JsonRpcRequest): WorkbenchRequestSource {
  return message[WORKBENCH_REQUEST_SOURCE_FIELD] === "autoRefresh" ? "autoRefresh" : "user";
}

function readThreadHydration(message: JsonRpcRequest): WorkbenchThreadHydrationRequest | null {
  const value = asRecord(message[WORKBENCH_THREAD_HYDRATION_FIELD]);
  if (!value) {
    return null;
  }

  switch (value.mode) {
    case "latest":
      return { mode: "latest" };
    case "legacyFull":
      return { mode: "legacyFull" };
    case "previous":
      return typeof value.beforeTurnId === "string"
        ? { beforeTurnId: value.beforeTurnId, mode: "previous" }
        : null;
    default:
      return null;
  }
}

function requestsHydratedTurnContextEntries(message: JsonRpcRequest) {
  return asRecord(message[WORKBENCH_THREAD_CONTEXT_ENTRIES_FIELD])?.mode === "hydratedTurns";
}

function createUpstreamRequest(message: JsonRpcRequest, upstreamRequestId: number) {
  const upstreamMessage = {
    ...message,
    id: upstreamRequestId,
  };
  delete upstreamMessage[WORKBENCH_PROMPT_CONTEXT_FIELD];
  delete upstreamMessage[WORKBENCH_REQUEST_SOURCE_FIELD];
  delete upstreamMessage[WORKBENCH_THREAD_HYDRATION_FIELD];
  return upstreamMessage;
}

function shouldCapturePollingTranscript(method: string | null, requestSource: WorkbenchRequestSource) {
  if (requestSource === "sqliteRecovery") return false;
  if (requestSource !== "autoRefresh" && requestSource !== "internal") {
    return true;
  }

  switch (method) {
    case "account/rateLimits/read":
    case "questionnaire/list":
    case "thread/list":
    case "thread/read":
    case "thread/turns/list":
      return false;
    default:
      return true;
  }
}

function shouldHydrateThreadResponse(
  request: JsonRpcRequest,
  hydration: WorkbenchThreadHydrationRequest | null,
) {
  const method = asString(request.method);
  if (method === "thread/resume"
    && asRecord(request.params)?.excludeTurns === true) {
    return false;
  }
  if (method === "thread/read"
    && asRecord(request.params)?.includeTurns === false
    && hydration === null) {
    return false;
  }

  switch (method) {
    case "thread/fork":
    case "thread/read":
    case "thread/resume":
    case "thread/start":
      return true;
    default:
      return false;
  }
}

function normalizeQuestionId(value: string | null, index: number) {
  const sanitized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || `question-${index + 1}`;
}

function normalizeQuestionOptions(options: ToolRequestUserInputQuestion["options"]) {
  if (!Array.isArray(options)) {
    return [];
  }

  return options.map((option) => {
    const label = option.label.trim();
    if (!label) {
      return null;
    }

    return {
      description: option.description.trim(),
      label,
    };
  }).filter((option): option is WorkbenchUserInputQuestion["options"][number] => option !== null);
}

function normalizeQuestion(
  question: ToolRequestUserInputQuestion,
  index: number,
): WorkbenchUserInputQuestion | null {
  const header = question.header.trim();
  const questionText = question.question.trim();
  const options = normalizeQuestionOptions(question.options);
  if (!header && !questionText && !options.length) {
    return null;
  }

  return {
    allowOther: false,
    header,
    id: normalizeQuestionId(question.id, index),
    isSecret: question.isSecret,
    options,
    question: questionText || header || `Question ${index + 1}`,
  };
}

function createFallbackQuestion(): WorkbenchUserInputQuestion {
  return {
    allowOther: false,
    header: "Question 1",
    id: "question-1",
    isSecret: false,
    options: [],
    question: "How should Codex continue?",
  };
}

function normalizeQuestionnaireRequest(
  params: ToolRequestUserInputParams,
  requestKey: string,
): WorkbenchUserInputRequest {
  const questions = params.questions
    .map((question, index) => normalizeQuestion(question, index))
    .filter((question): question is WorkbenchUserInputQuestion => question !== null)
    .slice(0, 3);
  const normalizedQuestions = questions.length ? questions : [createFallbackQuestion()];
  const singleQuestion = normalizedQuestions.length === 1 ? normalizedQuestions[0] : null;

  return {
    id: `codex:${params.threadId}:${requestKey}`,
    questions: normalizedQuestions,
    submitLabel: "Submit response",
    summary: singleQuestion ? "" : "The agent is paused until you provide a response.",
    title: singleQuestion?.question.trim() || "Follow-up questions",
  };
}

function createApprovalQuestionText(prompt: string, details: Array<string | null>) {
  return [prompt, ...details.filter((value): value is string => Boolean(value?.trim()))].join("\n\n");
}

function createApprovalDetail(label: string, value: string | null | undefined) {
  const normalizedValue = value?.trim();
  if (!normalizedValue) {
    return null;
  }

  return `${label}\n${truncateText(normalizedValue)}`;
}

function summarizeList(values: string[], maxItems = 5) {
  const normalizedValues = values.map((value) => value.trim()).filter(Boolean);
  if (!normalizedValues.length) {
    return null;
  }

  const visibleValues = normalizedValues.slice(0, maxItems);
  const hiddenCount = normalizedValues.length - visibleValues.length;
  return `${visibleValues.map((value) => truncateText(value)).join("\n")}${hiddenCount > 0 ? `\n+${hiddenCount} more` : ""}`;
}

function normalizeFileSystemPath(
  value: string | NonNullable<NonNullable<RequestPermissionProfile["fileSystem"]>["entries"]>[number]["path"],
) {
  if (typeof value === "string") {
    return value;
  }

  switch (value.type) {
    case "path":
      return value.path;
    case "glob_pattern":
      return value.pattern;
    case "special":
      return `special:${value.value}`;
  }
}

function normalizeFileSystemPermissionPaths(permissions: RequestPermissionProfile["fileSystem"]) {
  if (!permissions) {
    return [];
  }

  const entryPaths = permissions.entries?.map((entry) => normalizeFileSystemPath(entry.path)).filter(Boolean) ?? [];
  return [
    ...entryPaths,
    ...(permissions.read ?? []),
    ...(permissions.write ?? []),
  ];
}

function describeRequestedPermissions(permissions: RequestPermissionProfile) {
  const sections: string[] = [];
  if (permissions.network?.enabled) {
    sections.push("Network access\nEnabled");
  }

  const fileSystemPaths = summarizeList(normalizeFileSystemPermissionPaths(permissions.fileSystem));
  if (fileSystemPaths) {
    sections.push(`File system access\n${fileSystemPaths}`);
  }

  return sections.length ? sections.join("\n\n") : null;
}

function createApprovalQuestionOptions(actionLabel: string) {
  return [
    {
      description: `Approve this ${actionLabel} just for the current action.`,
      label: APPROVAL_ALLOW_ONCE_LABEL,
    },
    {
      description: `Approve this ${actionLabel} for the rest of the session.`,
      label: APPROVAL_ALLOW_SESSION_LABEL,
    },
    {
      description: `Do not approve this ${actionLabel}.`,
      label: APPROVAL_DECLINE_LABEL,
    },
  ] satisfies WorkbenchUserInputQuestion["options"];
}

function createApprovalRequest(
  threadId: string,
  requestKey: string,
  {
    actionLabel,
    approval,
    details,
    prompt,
    title,
  }: {
    actionLabel: string;
    approval?: WorkbenchUserInputRequest["approval"];
    details: Array<string | null>;
    prompt: string;
    title: string;
  },
): WorkbenchUserInputRequest {
  return {
    id: `codex:${threadId}:${requestKey}`,
    approval,
    questions: [{
      allowOther: false,
      header: "Approval",
      id: APPROVAL_DECISION_QUESTION_ID,
      isSecret: false,
      options: createApprovalQuestionOptions(actionLabel),
      question: createApprovalQuestionText(prompt, details),
    }],
    submitLabel: "Submit response",
    summary: "Codex cannot continue until you respond to this request.",
    title,
  };
}

function createCommandApprovalContext({
  command,
  commandActions,
  cwd,
}: {
  command: string | null | undefined;
  commandActions?: WorkbenchApprovalCommandContext["commandActions"] | null;
  cwd: string | null | undefined;
}): WorkbenchUserInputRequest["approval"] | undefined {
  const normalizedCommand = command?.trim();
  if (!normalizedCommand) {
    return undefined;
  }

  return {
    command: {
      command: normalizedCommand,
      commandActions: commandActions ?? [],
      cwd: cwd?.trim() ?? "",
    },
  };
}

function normalizeCommandExecutionApprovalRequest(
  requestKey: string,
  params: CommandExecutionRequestApprovalParams,
): WorkbenchUserInputRequest {
  const commandActionsText = summarizeList((params.commandActions ?? []).map((action) => action.command));
  const networkTarget = params.networkApprovalContext
    ? `${params.networkApprovalContext.protocol}://${params.networkApprovalContext.host}`
    : null;

  return createApprovalRequest(params.threadId, requestKey, {
    actionLabel: "command",
    approval: createCommandApprovalContext({
      command: params.command,
      commandActions: params.commandActions,
      cwd: params.cwd,
    }),
    details: [
      createApprovalDetail("Command", params.command ?? null),
      createApprovalDetail("Working directory", params.cwd ?? null),
      createApprovalDetail("Reason", params.reason ?? null),
      createApprovalDetail("Parsed actions", commandActionsText),
      createApprovalDetail("Network target", networkTarget),
    ],
    prompt: "Should Codex run this command?",
    title: "Approve command execution",
  });
}

function normalizeFileChangeApprovalRequest(
  requestKey: string,
  params: FileChangeRequestApprovalParams,
): WorkbenchUserInputRequest {
  return createApprovalRequest(params.threadId, requestKey, {
    actionLabel: "file change",
    details: [
      createApprovalDetail("Reason", params.reason ?? null),
      createApprovalDetail("Grant root", params.grantRoot ?? null),
    ],
    prompt: "Should Codex write these file changes?",
    title: "Approve file changes",
  });
}

function normalizePermissionsApprovalRequest(
  requestKey: string,
  params: PermissionsRequestApprovalParams,
): WorkbenchUserInputRequest {
  return createApprovalRequest(params.threadId, requestKey, {
    actionLabel: "permission request",
    details: [
      createApprovalDetail("Working directory", params.cwd),
      createApprovalDetail("Reason", params.reason),
      createApprovalDetail("Requested permissions", describeRequestedPermissions(params.permissions)),
    ],
    prompt: "Should Codex receive these extra permissions?",
    title: "Grant requested permissions",
  });
}

function normalizeApplyPatchApprovalRequest(
  requestKey: string,
  params: ApplyPatchApprovalParams,
): WorkbenchUserInputRequest {
  return createApprovalRequest(params.conversationId, requestKey, {
    actionLabel: "patch",
    details: [
      createApprovalDetail("Reason", params.reason),
      createApprovalDetail("Grant root", params.grantRoot),
      createApprovalDetail("Changed paths", summarizeList(Object.keys(params.fileChanges ?? {}))),
    ],
    prompt: "Should Codex apply this patch?",
    title: "Approve patch application",
  });
}

function normalizeExecCommandApprovalRequest(
  requestKey: string,
  params: ExecCommandApprovalParams,
): WorkbenchUserInputRequest {
  const command = params.command.join(" ");
  return createApprovalRequest(params.conversationId, requestKey, {
    actionLabel: "command",
    approval: createCommandApprovalContext({
      command,
      cwd: params.cwd,
    }),
    details: [
      createApprovalDetail("Command", command),
      createApprovalDetail("Working directory", params.cwd),
      createApprovalDetail("Reason", params.reason),
      createApprovalDetail("Parsed command", summarizeList((params.parsedCmd ?? []).map((entry) => entry.cmd))),
    ],
    prompt: "Should Codex run this command?",
    title: "Approve command execution",
  });
}

function toToolRequestUserInputResponse(response: WorkbenchUserInputResponse): ToolRequestUserInputResponse {
  return {
    answers: Object.fromEntries(Object.entries(response.answers).map(([questionId, answer]) => [
      questionId,
      {
        answers: answer?.answers.filter((entry): entry is string => typeof entry === "string") ?? [],
      },
    ])),
  };
}

function readApprovalDecision(response: WorkbenchUserInputResponse) {
  const answers = response.answers[APPROVAL_DECISION_QUESTION_ID]?.answers ?? [];
  if (answers.includes(APPROVAL_ALLOW_ONCE_LABEL)) {
    return "allow-once" satisfies ApprovalDecisionChoice;
  }
  if (answers.includes(APPROVAL_ALLOW_SESSION_LABEL)) {
    return "allow-session" satisfies ApprovalDecisionChoice;
  }
  if (answers.includes(APPROVAL_DECLINE_LABEL)) {
    return "decline" satisfies ApprovalDecisionChoice;
  }

  return null;
}

function toGrantedPermissionProfile(permissions: RequestPermissionProfile): GrantedPermissionProfile {
  const grantedPermissions: GrantedPermissionProfile = {};
  if (permissions.fileSystem) {
    grantedPermissions.fileSystem = permissions.fileSystem;
  }
  if (permissions.network) {
    grantedPermissions.network = permissions.network;
  }
  return grantedPermissions;
}

function toLegacyApprovalDecision(choice: ApprovalDecisionChoice): ReviewDecision {
  switch (choice) {
    case "allow-once":
      return "approved";
    case "allow-session":
      return "approved_for_session";
    case "decline":
      return { denied: { rejection: "User declined the request." } };
  }
}

function toCommandExecutionApprovalDecision(choice: ApprovalDecisionChoice): CommandExecutionApprovalDecision {
  switch (choice) {
    case "allow-once":
      return "accept";
    case "allow-session":
      return "acceptForSession";
    case "decline":
      return "decline";
  }
}

function toFileChangeApprovalDecision(choice: ApprovalDecisionChoice): FileChangeApprovalDecision {
  switch (choice) {
    case "allow-once":
      return "accept";
    case "allow-session":
      return "acceptForSession";
    case "decline":
      return "decline";
  }
}

function collectCacheSubtree(moduleId: string, visited = new Set<string>()) {
  if (visited.has(moduleId)) {
    return visited;
  }

  const cachedModule = require.cache[moduleId];
  if (!cachedModule) {
    return visited;
  }

  visited.add(moduleId);
  for (const child of cachedModule.children) {
    if (!child?.id || /[\\/]node_modules[\\/]/u.test(child.id)) {
      continue;
    }

    collectCacheSubtree(child.id, visited);
  }

  return visited;
}

function loadCodexTranscriptStore({ reload = false }: { reload?: boolean } = {}) {
  const resolvedPath = require.resolve("./CodexTranscriptStore");
  if (reload) {
    for (const moduleId of collectCacheSubtree(resolvedPath)) {
      delete require.cache[moduleId];
    }
  }

  return (require("./CodexTranscriptStore") as { default: CodexTranscriptStoreConstructor }).default;
}

export default class CodexStdioBridge {
  private readonly appServer: CodexAppServer;
  private readonly bridgeUrl: string;
  private readonly fileChanges: CodexFileChangeController;
  private readonly onAcceptedTurnSteer: NonNullable<CodexStdioBridgeOptions["onAcceptedTurnSteer"]>;
  private readonly onNotification: CodexStdioBridgeOptions["onNotification"];
  private readonly prepareTurnStart: NonNullable<CodexStdioBridgeOptions["prepareTurnStart"]>;
  private readonly prepareThreadConfiguration: CodexStdioBridgeOptions["prepareThreadConfiguration"];
  private readonly questionnaires: NonNullable<CodexStdioBridgeOptions["questionnaires"]>;
  private readonly sqliteTranscriptEnabled: boolean;
  private readonly sendToClient: CodexStdioBridgeOptions["sendToClient"];
  private readonly storageRoot: string;
  private readonly threadPageReads = new CodexThreadPageReadController();
  private readonly readSqliteContextUsage: CodexStdioBridgeOptions["readSqliteContextUsage"];
  private generation = new AbortController();
  private readonly transcriptPersistence = new Set<Promise<unknown>>();
  private threadPageReadsPreparedForReload = false;
  private transcriptStore: CodexTranscriptStoreInstance | null = null;
  private transcriptStoreReloadPending = false;
  private initializeResult: unknown;
  private acceptingWork = true;
  private commandQueue: Promise<unknown> = Promise.resolve();
  private readonly pendingUserInputRequests: Map<string, PendingCodexUserInputRequest>;
  private readonly pendingResponses: Map<number, PendingResponse>;
  private readonly retiringResponses: Map<number, PendingResponse>;
  private readonly requestIdAllocator: RequestIdAllocator;
  private transcriptQueue: Promise<void> = Promise.resolve();
  private readonly transcriptTasks = new Set<Promise<void>>();
  private readonly transcriptPendingTasks = new Map<number, { label: string; startedAt: number }>();
  private readonly pendingCompatibilityWindowImports = new Map<string, PendingCompatibilityWindowImport>();
  private transcriptInstrumentationTimer: NodeJS.Timeout | null = null;
  private nextTranscriptTaskId = 1;
  private transcriptLastLogAt: number | null = null;
  private transcriptSqliteFailureReported = false;
  private readonly transcriptActiveTurns: Map<string, string>;
  private readonly transcriptThreadContexts: Map<string, CodexTranscriptThreadContext>;
  private readonly transcriptSteers: Map<string, WorkbenchSteerHistoryEntry>;
  private readonly unmaterializedThreadIds: Set<string>;
  private readonly transcriptShadowLog: OrchestratorTranscriptShadowLog | undefined;
  private readonly transcriptRecording: CodexTranscriptRecordingController;
  private readonly readSqliteTranscriptMaterializedTurnIds: NonNullable<
    CodexStdioBridgeOptions["readSqliteTranscriptMaterializedTurnIds"]
  >;
  private upstreamInitialized: boolean;
  private upstreamInitializePromise: Promise<void> | null = null;
  private readonly resolveProjectFromCwd: CodexStdioBridgeOptions["resolveProjectFromCwd"];
  private readonly handleWorkbenchRequest: CodexStdioBridgeOptions["handleWorkbenchRequest"];
  private readonly instructions: WorkbenchCodexInstructionPort;
  private readonly identities: CodexStdioBridgeOptions["identities"];
  private readonly onInitialized: () => void;

  constructor({ appServer, bridgeUrl, handleWorkbenchRequest, initialState, instructions = UNCONFIGURED_CODEX_INSTRUCTIONS, identities, onAcceptedTurnSteer = (threadId) => { getProcessWorkbenchAgentMcpRequestRegistry().interruptThreadWaits(threadId); }, onInitialized = () => undefined, onNotification, prepareThreadConfiguration, prepareTurnStart = async () => undefined, questionnaires = UNCONFIGURED_WORKBENCH_QUESTIONNAIRES, readSqliteTranscriptMaterializedTurnIds = async () => [], readSqliteContextUsage, recordSqliteTranscript, restartingAppServer = false, resolveProjectFromCwd, sendToClient, storageRoot, transcriptShadowLog }: CodexStdioBridgeOptions) {
    this.appServer = appServer;
    this.bridgeUrl = bridgeUrl;
    this.onAcceptedTurnSteer = onAcceptedTurnSteer;
    this.onNotification = onNotification;
    this.onInitialized = onInitialized;
    this.prepareTurnStart = prepareTurnStart;
    this.prepareThreadConfiguration = prepareThreadConfiguration;
    this.questionnaires = questionnaires;
    this.sqliteTranscriptEnabled = Boolean(recordSqliteTranscript);
    this.readSqliteTranscriptMaterializedTurnIds = readSqliteTranscriptMaterializedTurnIds;
    this.readSqliteContextUsage = readSqliteContextUsage;
    this.resolveProjectFromCwd = resolveProjectFromCwd;
    this.handleWorkbenchRequest = handleWorkbenchRequest;
    this.instructions = instructions;
    this.identities = identities;
    this.sendToClient = sendToClient;
    this.storageRoot = storageRoot;
    this.transcriptShadowLog = transcriptShadowLog;
    this.fileChanges = new CodexFileChangeController(structuredClone(initialState?.fileChanges ?? {
      items: initialState?.fileChangeFailureMarkers ?? new Map(),
      turnCursors: initialState?.fileChangeTurnCursors ?? new Map(),
    }));
    this.initializeResult = initialState?.initializeResult ?? null;
    this.pendingResponses = new Map([...initialState?.pendingResponses ?? []].map(([id, pending]) => [
      id,
      isPendingInternalResponse(pending) && pending.toolContext
        ? { ...pending, toolContext: structuredClone(pending.toolContext) }
        : pending,
    ]));
    this.retiringResponses = new Map(initialState?.retiringResponses ?? (restartingAppServer ? initialState?.pendingResponses : undefined));
    this.pendingUserInputRequests = new Map(initialState?.pendingUserInputRequests);
    this.requestIdAllocator = initialState?.requestIdAllocator ?? { next: 1 };
    this.transcriptActiveTurns = new Map(initialState?.transcriptActiveTurns);
    this.transcriptThreadContexts = structuredClone(initialState?.transcriptThreadContexts ?? new Map());
    if (restartingAppServer) {
      for (const context of this.transcriptThreadContexts.values()) delete context.usageContext;
    }
    this.transcriptSteers = structuredClone(initialState?.transcriptSteers ?? new Map());
    this.unmaterializedThreadIds = new Set(initialState?.unmaterializedThreadIds);
    this.transcriptRecording = new CodexTranscriptRecordingController({
      ...(recordSqliteTranscript ? { recordSqlite: async (
        observations: readonly WorkbenchTranscriptObservation[],
        context: WorkbenchTranscriptRecordingContext,
      ) => {
        if (!identities) return recordSqliteTranscript(observations, context);
        await admitNativeTranscriptObservations(identities, observations);
        const mapped = observations.map((observation) => {
          const threadId = "entry" in observation ? observation.entry.threadId : observation.threadId;
          if (threadId === null) return observation;
          return mapNativeTranscriptObservation(
            identities, identities.threads.knownNativeBinding("codex", threadId), observation,
          );
        });
        await recordSqliteTranscript(mapped, context);
      } } : {}),
    });
    this.upstreamInitialized = initialState?.upstreamInitialized ?? false;
    if (restartingAppServer) {
      // A private candidate must not settle callbacks still owned by the retained bridge.
      this.pendingResponses.clear();
      this.pendingUserInputRequests.clear();
      this.transcriptActiveTurns.clear();
      this.unmaterializedThreadIds.clear();
      this.initializeResult = null;
      this.upstreamInitialized = false;
    }
    this.startTranscriptInstrumentation();
  }

  private startTranscriptInstrumentation() {
    if (this.transcriptInstrumentationTimer) return;
    this.transcriptInstrumentationTimer = setInterval(() => {
      this.logTranscriptInstrumentation();
    }, CODEX_TRANSCRIPT_DIAGNOSTIC_INTERVAL_MS);
    this.transcriptInstrumentationTimer.unref();
  }

  getInitializeResult() {
    return this.initializeResult;
  }

  getListenDescriptor() {
    const parsedUrl = new URL(this.bridgeUrl);
    if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") {
      throw new Error(`Codex bridge URL must use ws:// or wss://, received ${this.bridgeUrl}`);
    }

    return {
      host: parsedUrl.hostname || "127.0.0.1",
      port: Number(parsedUrl.port || (parsedUrl.protocol === "wss:" ? 443 : 80)),
    };
  }

  stop() {
    this.beginStopping();
    if (this.transcriptInstrumentationTimer) clearInterval(this.transcriptInstrumentationTimer);
    this.transcriptInstrumentationTimer = null;
    this.fileChanges.clear();
    this.transcriptSteers.clear();
  }

  beginStopping(reason = "Codex bridge stopped before the upstream response arrived.") {
    this.acceptingWork = false;
    this.threadPageReads.beginDrain();
    this.resetUpstreamState(reason);
  }

  async dispose() {
    await this.stopAfterFlushingTranscripts();
    if (this.transcriptStore) {
      await this.transcriptStore.dispose();
      this.transcriptStore = null;
    }
  }

  async stopAfterFlushingTranscripts() {
    this.threadPageReads.beginDrain();
    await this.threadPageReads.waitForIdle();
    await this.waitForIdle();
    this.stop();
    await this.waitForIdle();
  }

  async prepareForReload(_options: CodexStdioBridgeReloadOptions = {}) {
    if (this.threadPageReadsPreparedForReload) return;
    this.threadPageReads.beginDrain();
    try {
      await this.threadPageReads.waitForIdle();
      this.threadPageReadsPreparedForReload = true;
    } catch (error) {
      this.threadPageReads.resumeAfterFailedReload();
      throw error;
    }
  }

  resumeAfterReloadFailure() {
    const expired = this.generation.signal.aborted;
    if (expired) this.generation = new AbortController();
    this.acceptingWork = true;
    this.threadPageReadsPreparedForReload = false;
    this.threadPageReads.resumeAfterFailedReload();
    this.transcriptStore?.resumeAfterFailedReload();
    this.startTranscriptInstrumentation();
    if (expired) this.resumePendingToolContexts();
  }

  expireForReload() {
    this.acceptingWork = false;
    this.threadPageReads.expire();
    this.generation.abort(new Error("Codex bridge generation retired."));
    this.upstreamInitializePromise = null;
  }

  async detachForReload(options: CodexStdioBridgeReloadOptions = {}): Promise<CodexStdioBridgeReloadState> {
    await this.prepareForReload(options);
    await this.waitForIdle();
    this.acceptingWork = false;
    if (this.transcriptInstrumentationTimer) clearInterval(this.transcriptInstrumentationTimer);
    this.transcriptInstrumentationTimer = null;
    if (this.transcriptStore) {
      await this.transcriptStore.dispose();
    }
    return {
      fileChanges: structuredClone(this.fileChanges.state),
      initializeResult: options.restartingAppServer ? null : this.initializeResult,
      pendingResponses: options.restartingAppServer ? new Map() : new Map(this.pendingResponses),
      retiringResponses: options.restartingAppServer ? new Map(this.pendingResponses) : new Map(this.retiringResponses),
      pendingUserInputRequests: options.restartingAppServer ? new Map() : new Map(this.pendingUserInputRequests),
      requestIdAllocator: this.requestIdAllocator,
      transcriptActiveTurns: options.restartingAppServer ? new Map() : new Map(this.transcriptActiveTurns),
      transcriptSteers: structuredClone(this.transcriptSteers),
      transcriptThreadContexts: structuredClone(this.transcriptThreadContexts),
      unmaterializedThreadIds: options.restartingAppServer ? new Set() : new Set(this.unmaterializedThreadIds),
      upstreamInitialized: options.restartingAppServer ? false : this.upstreamInitialized,
    };
  }

  private resetUpstreamState(reason: string) {
    this.pendingUserInputRequests.clear();
    this.transcriptActiveTurns.clear();
    this.unmaterializedThreadIds.clear();
    for (const pending of this.pendingResponses.values()) {
      if (!isPendingInternalResponse(pending)) continue;
      if (pending.toolContext) {
        if (pending.toolContext.patch) pending.toolContext.patch.approvalId = null;
        void this.settleToolContext(pending, {
          id: pending.upstreamRequest.id ?? null, error: { code: -32000, message: reason },
        }).then(pending.resolve);
      } else pending.reject(new Error(reason));
    }
    this.pendingResponses.clear();
    this.initializeResult = null;
    this.upstreamInitialized = false;
    if (this.upstreamInitializePromise) this.upstreamInitializePromise.catch(() => undefined);
    this.upstreamInitializePromise = null;
  }

  async disposeImmediately() {
    this.threadPageReads.beginDrain();
    this.stop();
    await this.waitForIdle();
    if (this.transcriptStore) {
      await this.transcriptStore.dispose();
      this.transcriptStore = null;
    }
  }

  async reloadTranscriptStore() {
    if (!this.transcriptStore) {
      this.transcriptStoreReloadPending = true;
      return;
    }

    await this.transcriptStore.dispose();
    this.transcriptStore = this.createTranscriptStore({ reload: true });
  }

  async ensureInitialized(initializeMessage: JsonRpcRequest) {
    this.assertAcceptingWork();
    if (this.upstreamInitialized) {
      return;
    }

    if (this.upstreamInitializePromise) {
      await this.upstreamInitializePromise;
      return;
    }

    const signal = this.generation.signal;
    const initialization = (async () => {
      const dispatch = await this.dispatchRequest(initializeMessage, { internal: true, signal });
      if (!dispatch.response) {
        throw new Error("Codex initialize request did not create an internal response.");
      }
      const response = await dispatch.response;
      signal.throwIfAborted();
      if (response.error) {
        throw new Error(response.error.message);
      }

      this.initializeResult = response.result;
      this.send({ method: "initialized" });
      this.upstreamInitialized = true;
      this.onInitialized();
    })();
    this.upstreamInitializePromise = initialization;

    try {
      await initialization;
    } finally {
      if (this.upstreamInitializePromise === initialization) this.upstreamInitializePromise = null;
    }
  }

  async forwardRequest(message: JsonRpcRequest, client: BridgeClient, clientRequestId: number | string) {
    if (message.method === "turn/start") {
      const response = await this.enqueueCommand(async () => {
        this.assertAcceptingWork();
        const admission = await this.admitNativeCodexTurn({
          requestId: message.id ?? clientRequestId,
          startRequest: message,
        });
        return this.toNativeTurnStartResponse(admission, clientRequestId);
      });
      this.sendToClient(client, response);
      return;
    }
    if (message.method === "thread/resume" || message.method === "thread/unsubscribe") {
      this.sendToClient(client, {
        id: clientRequestId,
        error: { code: -32600, message: `${message.method} is owned by the Workbench turn-start lifecycle.` },
      });
      return;
    }
    await this.enqueueCommand(() => {
      this.assertAcceptingWork();
      return this.dispatchRequest(message, { client, clientRequestId });
    });
  }

  async forwardNotification(message: JsonRpcRequest) {
    await this.enqueueCommand(() => {
      this.assertAcceptingWork();
      this.send(message);
    });
  }

  async handleBridgeRequest(message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    if (message.method === WORKBENCH_TOOL_CONTEXT_METHOD) {
      this.assertAcceptingWork();
      const params = asRecord(message.params);
      const threadId = asString(params?.threadId)?.trim();
      const turnId = asString(params?.expectedTurnId)?.trim();
      const item = readWorkbenchToolOutput({
        ...asRecord(params?.toolOutput), id: randomUUID(), type: "functionCallOutput",
      });
      if (!threadId || !turnId || !item) {
        return { id: message.id ?? null, error: { code: -32602, message: "Passive context requires a thread, originating turn and supported tool output." } };
      }
      const response = await this.queueToolContext({ threadId, turnId, item });
      return { ...response, id: message.id ?? null };
    }
    if (message.method === "workbench/codex/message/admit") {
      return await this.enqueueCommand(() => this.handleManagedMessageAdmission(message));
    }
    if (message.method?.startsWith("workbench/subagent/")) {
      this.assertAcceptingWork();
      return await this.handleWorkbenchRequest(message);
    }
    if (message.method === WORKBENCH_THREAD_PAGE_READ_METHOD) {
      return await this.handleThreadPageReadRequest(message);
    }
    if (message.method === "workbench/thread-recall/materialize") {
      return await this.handleThreadRecallMaterializeRequest(message);
    }
    if (message.method === "workbench/transcript/materialize") {
      return await this.handleTranscriptMaterializeRequest(message);
    }
    if (message.method === "workbench/stats/usage/hydrate") {
      return await this.handleStatsUsageHydrateRequest(message);
    }
    if (message.method === "thread/context/read") {
      return await this.handleThreadContextReadRequest(message);
    }
    if (message.method === "thread/resume" || message.method === "thread/unsubscribe") {
      return {
        id: message.id ?? null,
        error: { code: -32600, message: `${message.method} is owned by the Workbench turn-start lifecycle.` },
      };
    }

    return await this.enqueueCommand(() => this.handleBridgeRequestImmediately(message));
  }

  async handleServerRequest(message: JsonRpcRequest, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<JsonRpcResponse> {
    const controller = options.timeoutMs === undefined && !options.signal ? null : new AbortController();
    const abortFromCaller = () => controller?.abort(options.signal?.reason);
    if (options.signal?.aborted) abortFromCaller();
    else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const run = async () => {
      if (message.method === "turn/start") {
        return await this.enqueueCommand(async () => {
          if (controller?.signal.aborted) throw controller.signal.reason;
          this.assertAcceptingWork();
          const admission = await this.admitNativeCodexTurn({
            requestId: message.id ?? `workbench:internal-start:${Date.now()}`,
            startRequest: message,
          });
          return this.toNativeTurnStartResponse(admission, message.id ?? null);
        });
      }
      const bridgeResponse = await this.handleBridgeRequest(message);
      if (bridgeResponse) return bridgeResponse;
      const dispatch = await this.enqueueCommand(() => {
        if (controller?.signal.aborted) throw controller.signal.reason;
        this.assertAcceptingWork();
        return this.dispatchRequest(message, { internal: true, signal: controller?.signal });
      });
      if (!dispatch.response) throw new Error(`Codex internal request ${message.method} did not create a response.`);
      return await dispatch.response;
    };
    if (!controller || options.timeoutMs === undefined) {
      try {
        return await run();
      } finally {
        options.signal?.removeEventListener("abort", abortFromCaller);
      }
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Codex internal request ${message.method} timed out after ${options.timeoutMs}ms.`);
        controller.abort(error);
        reject(error);
      }, options.timeoutMs);
      timer.unref();
    });
    try {
      return await Promise.race([run(), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  async readThreadForBrowse(threadId: string): Promise<ThreadReadResponse> {
    this.assertAcceptingWork();
    const response = await this.readThreadContext({
      method: "thread/context/read",
      params: { includeTurns: false, threadId },
      workbenchThreadHydration: { mode: "latest" },
    });
    return { thread: response.thread };
  }

  async recoverSqliteTranscriptThread(threadId: string, signal?: AbortSignal) {
    await this.captureSqliteTranscriptThread(threadId, true, signal);
  }

  get activeSqliteTranscriptThreadIds() {
    return [...new Set([...this.transcriptActiveTurns.values()].map((threadId) => (
      this.identities
        ? this.identities.threads.workbenchIdForNative(this.identities.threads.knownNativeBinding("codex", threadId))
        : threadId
    )))];
  }

  async baselineSqliteTranscriptThread(threadId: string, signal?: AbortSignal) {
    await this.captureSqliteTranscriptThread(threadId, false, signal);
  }

  private async captureSqliteTranscriptThread(threadId: string, recoveryBoundary: boolean, signal?: AbortSignal) {
    this.assertAcceptingWork();
    signal?.throwIfAborted();
    const identity = await this.identities?.threads.resolve({ threadId, harness: "codex" });
    const bindings = identity?.bindings.filter((binding) => binding.harness === "codex") ?? [];
    if (this.identities && bindings.length !== 1) {
      throw new Error(`SQLite transcript recovery has no unique admitted Codex binding for thread ${threadId}.`);
    }
    const nativeThreadId = bindings[0]?.nativeThreadId ?? threadId;
    this.transcriptShadowLog?.write({
      event: "capture-recovery-started",
      fields: { threadId, recoveryBoundary },
      level: "info", source: "codex-transcript",
    });
    const response = await this.dispatchManagedProviderRequest({
      method: "thread/read",
      params: { includeTurns: false, threadId: nativeThreadId },
    }, signal);
    if (response.error) throw new Error(response.error.message);
    const thread = asRecord(response.result)?.thread as Thread | undefined;
    if (thread?.id !== nativeThreadId || !Array.isArray(thread.turns)) {
      throw new Error(`Codex SQLite transcript recovery returned the wrong thread for ${threadId}.`);
    }
    const context = await this.resolveTranscriptThreadContext(thread);
    const store = this.ensureTranscriptStore();
    const loader = new CodexThreadWindowLoader((request) => this.dispatchManagedProviderRequest({
      ...request, [WORKBENCH_REQUEST_SOURCE_FIELD]: "sqliteRecovery",
    }, signal));
    const turns = await loader.recoverThread(thread, async ({ turn, previousCursor }) => {
      signal?.throwIfAborted();
      await this.captureTranscript(`sqlite-recovery-page:${threadId}:${turn.id}`, async () => {
        const normalized = (await this.persistTranscript(() => store.externalizeInlineImages(nativeThreadId, turn))).value;
        await this.persistTranscript(() => this.transcriptRecording.recordProviderFact({
          observations: [
            createCodexTranscriptProviderThreadObservation(nativeThreadId, context),
            createCodexTranscriptProviderTurnScopeObservation({ context, threadId: nativeThreadId, turn: normalized }),
          ],
          recordLegacy: () => store.recordProviderTurnPage(thread, turn, previousCursor),
        }));
      }, { requireSqlite: true });
    }, async (catalog) => {
      signal?.throwIfAborted();
      await this.captureTranscript(`sqlite-recovery-catalog:${threadId}`, async () => {
        const observations = this.createSqliteProviderWindowObservations({ ...thread, turns: catalog }, context);
        await this.persistTranscript(() => this.transcriptRecording.recordProviderFact({
          observations,
          recordLegacy: () => store.recordProviderTurnCatalog(thread, catalog),
        }));
      }, { requireSqlite: true });
    });
    // All full pages have settled. Only compact catalogue metadata remains in memory.
    signal?.throwIfAborted();
    await this.captureTranscript(`sqlite-recovery-complete:${threadId}`, async () => {
      const catalog = { ...thread, turns };
      const observations = this.createSqliteProviderWindowObservations(catalog, context);
      await this.persistTranscript(() => this.transcriptRecording.recordProviderFact({
        observations, recoveryBoundary,
        recordLegacy: () => store.recordProviderTurnCatalog(thread, turns),
      }));
    }, { requireSqlite: true });
    this.transcriptShadowLog?.write({
      event: "capture-recovery-completed",
      fields: { threadId, recoveryBoundary, turnCount: turns.length },
      level: "info", source: "codex-transcript",
    });
  }

  async recordBrowseResultForBrowse(entry: WorkbenchBrowseResultEntry) {
    this.assertAcceptingWork();
    await this.recordBrowseResultEntry(entry);
  }

  async steerTurnForBrowse(threadId: string, expectedTurnId: string, input: UserInput[]) {
    this.assertAcceptingWork();
    const dispatch = await this.dispatchRequest({
      method: "turn/steer",
      params: { expectedTurnId, input, threadId },
    }, { internal: true });
    if (!dispatch.response) throw new Error("turn/steer did not create an internal response.");
    const response = await dispatch.response;
    if (response.error) {
      throw new Error(response.error.message);
    }
    const result = response.result as TurnSteerResponse | undefined;
    return result?.turnId ?? null;
  }

  private async handleThreadContextReadRequest(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    const requestId = message.id ?? null;

    try {
      this.assertAcceptingWork();
      return {
        id: requestId,
        result: await this.readThreadContext(message),
      };
    } catch (error) {
      return {
        id: requestId,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : "Codex user-input bridge request failed.",
        },
      };
    }
  }

  private async handleThreadRecallMaterializeRequest(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    const requestId = message.id ?? null;
    try {
      this.assertAcceptingWork();
      return {
        id: requestId,
        result: await this.materializeThreadRecallTurn(message.params),
      };
    } catch (error) {
      return {
        id: requestId,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : "Codex Thread Recall materialisation failed.",
        },
      };
    }
  }

  private async handleTranscriptMaterializeRequest(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    const requestId = message.id ?? null;
    try {
      this.assertAcceptingWork();
      const record = asRecord(message.params);
      const threadId = asString(record?.threadId)?.trim() ?? "";
      const turnIdsValue = record?.turnIds;
      const turnIds = Array.isArray(turnIdsValue)
        ? turnIdsValue.map((value) => asString(value)?.trim() ?? "")
        : null;
      if (!threadId || !turnIds || turnIds.some((turnId) => !turnId)) {
        throw new Error("Transcript materialisation requires a thread id and exact turn ids.");
      }
      return {
        id: requestId,
        result: await this.materializeSqliteTranscriptWindow({
          endpointName: "Workbench transcript",
          source: "sqlite-transcript-materialisation",
          threadId,
          turnIds: [...new Set(turnIds)],
        }),
      };
    } catch (error) {
      return {
        id: requestId,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : "Workbench transcript materialisation failed.",
        },
      };
    }
  }

  private async handleStatsUsageHydrateRequest(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    const requestId = message.id ?? null;
    try {
      this.assertAcceptingWork();
      const threadId = asString(asRecord(message.params)?.threadId)?.trim() ?? "";
      if (!threadId) throw new Error("Stats usage hydration requires a thread id.");
      const transcriptStore = this.ensureTranscriptStore();
      const evidence = await transcriptStore.readStoredUsageEvidence(threadId);
      if (!evidence) return { id: requestId, result: { state: "unavailable" } };
      if (evidence.thread.id !== threadId) throw new Error("Stats usage evidence changed thread owner");
      const context = await this.resolveTranscriptThreadContext(evidence.thread, false);
      const window = createCodexUsageImport({ ...evidence, context });
      await this.captureTranscript("usage-compatibility-import", async () => {
        try {
          if (this.identities) {
            const native = { harness: "codex", nativeLocation: context.nativeLocation, nativeThreadId: threadId };
            if (!this.identities.threads.findNativeThread(native)) {
              await this.persistTranscript(() => this.identities!.threads.observe({ ...context, native }));
            }
          }
          await this.persistTranscript(() => this.transcriptRecording.importCompatibilityWindow(async () => [window]));
        } catch (error) {
          // Usage import has its own durable failed-work state, not live shadow failure semantics.
          throw new Error(error instanceof Error ? error.message : "Usage import settlement failed", { cause: error });
        }
      }, { propagateFailure: true });
      return { id: requestId, result: { state: "completed" } };
    } catch (error) {
      return {
        id: requestId,
        error: { code: -32000, message: error instanceof Error ? error.message : "Stats usage hydration failed." },
      };
    }
  }

  private async handleThreadPageReadRequest(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    const requestId = message.id ?? null;

    try {
      this.assertAcceptingWork();
      return {
        id: requestId,
        result: await this.threadPageReads.run(
          signal => this.readThreadPage(message, signal),
          { key: threadPageReadKey(message) },
        ),
      };
    } catch (error) {
      return {
        id: requestId,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : "Codex thread-page read failed.",
        },
      };
    }
  }

  private async handleBridgeRequestImmediately(message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const requestId = message.id ?? null;
    const method = typeof message.method === "string" ? message.method : null;
    if (!method) {
      return {
        id: requestId,
        error: {
          code: -32600,
          message: "Invalid JSON-RPC request.",
        },
      };
    }

    try {
      this.assertAcceptingWork();
      switch (method) {
        case "questionnaire/list":
          return {
            id: requestId,
            result: this.listPendingQuestionnaires(),
          };
        case "questionnaire/history/list":
          return {
            id: requestId,
            result: await this.listQuestionnaireHistory(message.params),
          };
        case "questionnaire/history/record":
          return {
            id: requestId,
            result: await this.recordQuestionnaireHistory(message.params),
          };
        case "steer/history/list":
          return {
            id: requestId,
            result: await this.listSteerHistory(message.params),
          };
        case "browse/result/list":
          return {
            id: requestId,
            result: await this.listBrowseResultEntries(message.params),
          };
        case "browse/result/record":
          return {
            id: requestId,
            result: await this.recordBrowseResultEntry(message.params),
          };
        case "questionnaire/respond":
          return {
            id: requestId,
            result: await this.respondToQuestionnaire(message.params),
          };
        default:
          return null;
      }
    } catch (error) {
      return {
        id: requestId,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : "Codex user-input bridge request failed.",
        },
      };
    }
  }

  private nextUpstreamRequestId() {
    const requestId = this.requestIdAllocator.next;
    this.requestIdAllocator.next += 1;
    return requestId;
  }

  private assertAcceptingWork() {
    if (!this.acceptingWork) {
      throw new Error("Codex bridge is reloading.");
    }
  }

  private send(message: unknown) {
    this.assertAcceptingWork();
    this.appServer.send(message);
  }

  private queueToolContext(context: NonNullable<PendingInternalResponse["toolContext"]>) {
    context.sent = false;
    const id = this.nextUpstreamRequestId();
    let pending!: PendingInternalResponse;
    const response = new Promise<JsonRpcResponse>((resolve, reject) => {
      pending = {
        internal: true, method: "thread/inject_items", requestSource: "internal",
        resolve, reject, threadHydration: null, toolContext: context,
        upstreamRequest: { id, method: "thread/inject_items", params: { threadId: context.threadId, items: [] } },
      };
      // Register before filesystem work: resolution can arrive while analysis is still preparing.
      this.pendingResponses.set(id, pending);
    });
    this.prepareQueuedToolContext(id, pending);
    return response;
  }

  private prepareQueuedToolContext(id: number, pending: PendingInternalResponse) {
    const signal = this.generation.signal;
    void this.enqueueCommand(async () => {
      try {
        await this.prepareToolContext(pending);
      } catch (error) {
        if (signal.aborted) return;
        if (this.pendingResponses.get(id) !== pending) return;
        this.pendingResponses.delete(id);
        pending.resolve(await this.settleToolContext(pending, {
          id, error: { code: -32000, message: sanitizeTranscriptErrorMessage(error) },
        }));
      }
    }).catch(error => {
      if (error !== signal.reason) logError("codex-tool-context", sanitizeTranscriptErrorMessage(error));
    });
  }

  resumePendingToolContexts() {
    for (const [id, pending] of this.pendingResponses) {
      if (isPendingInternalResponse(pending) && pending.toolContext?.sent === false) {
        this.prepareQueuedToolContext(id, pending);
      }
    }
  }

  private async prepareToolContext(pending: PendingInternalResponse) {
    const signal = this.generation.signal;
    const context = pending.toolContext!;
    const { threadId, turnId, patch } = context;
    const read = await this.dispatchManagedProviderRequest({
      method: "thread/read", params: { threadId, includeTurns: false },
    }, signal);
    signal.throwIfAborted();
    if (read.error) throw new Error(getJsonRpcErrorMessage(read) ?? "Could not read the originating thread.");
    const thread = asRecord(read.result)?.thread as Thread | undefined;
    if (!thread || thread.id !== threadId) throw new Error("Passive context could not read its originating thread.");
    if (patch) {
      const attempt = this.fileChanges.get(threadId, turnId, patch.itemId)?.item ?? {
        id: patch.itemId, type: "fileChange" as const, status: "failed" as const, changes: [],
      };
      const resolution = await this.resolveProjectFromCwd(thread.cwd, { endpointName: "Codex patch recovery" });
      signal.throwIfAborted();
      const findings = await this.fileChanges.analyse({
        cwd: thread.cwd, roots: resolution?.project.roots.map((root) => root.rootPath) ?? [],
        threadId, turnId, item: { ...attempt, status: "failed", workbenchPolicy: "automaticEscalation" },
      });
      signal.throwIfAborted();
      context.item = {
        ...context.item,
        output: findings.recoveryText + (attempt.changes.length ? "" : "\nAttempted changes were unavailable. Re-read all intended targets before repairing anything."),
      };
      await this.recordPatchFindings(threadId, turnId, findings.item);
    }
    if (!isThreadStatusActive(thread.status)) throw new Error("Passive context requires an active originating turn; no turn was started.");
    const turns = await this.dispatchManagedProviderRequest({
      method: "thread/turns/list",
      params: { threadId, itemsView: "notLoaded", limit: 1, sortDirection: "desc" },
    }, signal);
    signal.throwIfAborted();
    if (turns.error) throw new Error(getJsonRpcErrorMessage(turns) ?? "Could not read the active turn.");
    const data = asRecord(turns.result)?.data;
    const active = Array.isArray(data) ? this.readManagedActiveTurn(thread, data as Turn[]) : null;
    if (active?.id !== turnId) throw new Error("The originating turn is no longer active; passive context was not sent.");
    if (this.pendingResponses.get(Number(pending.upstreamRequest.id)) !== pending) return;
    if (patch && patch.approvalId === null) throw new Error("The patch approval resolved before recovery context could be queued.");
    this.assertAcceptingWork();
    const { id, name, namespace, output } = context.item;
    pending.upstreamRequest = {
      ...pending.upstreamRequest,
      params: { threadId, items: [{ type: "function_call_output", id, name, namespace, output }] },
    };
    await this.captureTranscript("client-request:thread/inject_items", () => (
      this.persistTranscript(() => this.ensureTranscriptStore().recordClientRequest(pending.upstreamRequest, undefined, turnId))
    ), { propagateFailure: true });
    signal.throwIfAborted();
    this.send(pending.upstreamRequest);
    context.sent = true;
  }

  private async recordPatchFindings(threadId: string, turnId: string, item: WorkbenchFileChangeItem) {
    this.fileChanges.remember(threadId, turnId, item);
    this.onNotification({ method: "item/completed", params: { threadId, turnId, item } });
    await this.captureTranscript("workbench:patch/findings", () => this.persistTranscript(() => this.transcriptRecording.recordWorkbenchMutation({
      observations: [createCodexTranscriptProviderItemObservation({
        threadId, turnId, item, lifecycle: "completed", observedAt: Date.now(),
      })],
      recordLegacy: () => this.ensureTranscriptStore().recordWorkbenchFileChange(threadId, turnId, item),
    })), { propagateFailure: true });
  }

  private async analyseFailedPatch(threadId: string, turnId: string, item: WorkbenchFileChangeItem) {
    const signal = this.generation.signal;
    try {
      const response = await this.dispatchManagedProviderRequest({
        method: "thread/read", params: { threadId, includeTurns: false },
      }, signal);
      signal.throwIfAborted();
      const thread = asRecord(response.result)?.thread as Thread | undefined;
      if (response.error || thread?.id !== threadId) {
        throw new Error(getJsonRpcErrorMessage(response) ?? "Failed patch has no readable originating thread.");
      }
      const resolution = await this.resolveProjectFromCwd(thread.cwd, { endpointName: "Codex patch findings" });
      signal.throwIfAborted();
      const findings = await this.fileChanges.analyse({
        cwd: thread.cwd, roots: resolution?.project.roots.map((root) => root.rootPath) ?? [],
        threadId, turnId, item,
      });
      signal.throwIfAborted();
      await this.recordPatchFindings(threadId, turnId, findings.item);
    } catch (failure) {
      if (signal.aborted) return;
      const detail = sanitizeTranscriptErrorMessage(failure);
      logError("codex-patch-findings", detail);
      await this.recordPatchFindings(threadId, turnId, {
        ...item, changes: item.changes.map((change) => ({
          ...change,
          workbenchAnalysis: { outcome: "uncertain", detail, additions: 0, deletions: 0, hunks: [] },
        })),
      });
    }
  }

  private async settleToolContext(pending: PendingInternalResponse, response: JsonRpcResponse): Promise<JsonRpcResponse> {
    const { threadId, turnId, item, patch } = pending.toolContext!;
    const acceptedAt = Date.now();
    const error = response.error
      ? sanitizeTranscriptErrorMessage(new Error(getJsonRpcErrorMessage(response) ?? "Passive context injection failed.")).slice(0, 500)
      : null;
    // Capture the patch before stop clears in-memory attempts. Persistence stays on the transcript queue.
    const attempt = patch ? this.fileChanges.get(threadId, turnId, patch.itemId)?.item : null;
    try {
      if (error) logError("codex-tool-context", error);
      const finding = patch ? {
        ...(attempt ?? { id: patch.itemId, type: "fileChange" as const, changes: [] }),
        status: "failed" as const, workbenchPolicy: "automaticEscalation" as const,
        workbenchRecovery: { state: error ? "failed" as const : "queued" as const, detail: error },
      } : null;
      // Queue synchronously so shutdown's transcript drain includes these facts.
      const patchRecording = finding ? this.recordPatchFindings(threadId, turnId, finding) : null;
      const contextRecording = this.captureTranscript("upstream-response:thread/inject_items", async () => {
        const store = this.ensureTranscriptStore();
        await this.persistTranscript(() => store.recordUpstreamResponse(pending.upstreamRequest, response, turnId));
        if (error || patch) return;
        const accepted = (await this.persistTranscript(() => store.externalizeInlineImages(threadId, {
          ...item, workbenchInjectionAcceptedAt: acceptedAt,
        }))).value;
        await this.persistTranscript(() => this.transcriptRecording.recordWorkbenchMutation({
          observations: [createCodexTranscriptProviderItemObservation({
            threadId, turnId, item: accepted, lifecycle: "completed", observedAt: acceptedAt,
          })],
          recordLegacy: async () => { await store.recordWorkbenchToolContext(threadId, turnId, accepted); },
        }));
        this.onNotification({ method: "item/completed", params: { threadId, turnId, item: accepted } });
      }, { propagateFailure: true });
      await Promise.all([patchRecording, contextRecording]);
      return error ? response : { id: response.id, result: { acceptedAt, itemId: item.id, turnId } };
    } catch (failure) {
      const detail = sanitizeTranscriptErrorMessage(failure);
      logError("codex-tool-context", detail);
      if (patch) {
        const failed: WorkbenchFileChangeItem = {
          ...(attempt ?? { id: patch.itemId, type: "fileChange", changes: [] }),
          status: "failed", workbenchPolicy: "automaticEscalation",
          workbenchRecovery: { state: "failed", detail },
        };
        // The transcript boundary reports persistence failure; retain visible failure even if disk is unavailable.
        this.fileChanges.remember(threadId, turnId, failed);
        this.onNotification({ method: "item/completed", params: { threadId, turnId, item: failed } });
      }
      return { id: response.id, error: { code: -32000, message: detail } };
    } finally {
      if (patch?.approvalId !== null && patch?.approvalId !== undefined) {
        const approvalId = patch.approvalId;
        patch.approvalId = null;
        try {
          this.send({ id: approvalId, result: { decision: "decline" satisfies FileChangeApprovalDecision } });
        } catch (failure) {
          logError("codex-patch-approval", sanitizeTranscriptErrorMessage(failure));
        }
      }
    }
  }

  private async dispatchRequest(
    message: JsonRpcRequest,
    {
      client,
      clientRequestId,
      internal = false,
      signal: callerSignal,
    }: {
      client?: BridgeClient;
      clientRequestId?: number | string;
      internal?: boolean;
      signal?: AbortSignal;
    },
  ) {
    const signal = AbortSignal.any([this.generation.signal, ...(callerSignal ? [callerSignal] : [])]);
    signal.throwIfAborted();
    const upstreamRequestId = this.nextUpstreamRequestId();
    const requestSource: WorkbenchRequestSource = internal
      ? message[WORKBENCH_REQUEST_SOURCE_FIELD] === "autoRefresh"
        ? "autoRefresh"
        : message[WORKBENCH_REQUEST_SOURCE_FIELD] === "sqliteRecovery" ? "sqliteRecovery" : "internal"
      : readRequestSource(message);
    const method = typeof message.method === "string" ? message.method : null;
    const threadHydration = readThreadHydration(message);
    const upstreamMessage = createUpstreamRequest(await this.instructions.augment(message, method), upstreamRequestId);
    signal.throwIfAborted();

    if (internal) {
      if (signal?.aborted) throw signal.reason;
      let rejectResponse!: (error: Error) => void;
      const responsePromise = new Promise<JsonRpcResponse>((resolve, reject) => {
        rejectResponse = reject;
        this.pendingResponses.set(upstreamRequestId, {
          internal: true,
          method,
          reject,
          requestSource,
          resolve,
          threadHydration,
          upstreamRequest: upstreamMessage,
        });
      });
      // Cancellation can settle this before transcript admission returns it to the caller.
      void responsePromise.catch(() => undefined);
      const abortPendingResponse = () => {
        if (!this.pendingResponses.delete(upstreamRequestId)) return;
        rejectResponse(signal?.reason instanceof Error ? signal.reason : new Error("Codex internal request was cancelled."));
      };
      signal?.addEventListener("abort", abortPendingResponse, { once: true });
      if (shouldCapturePollingTranscript(method, requestSource)) {
        const capture = this.captureTranscriptClientRequest(upstreamMessage, {
          propagateFailure: method === "turn/steer",
        });
        if (method === "turn/steer") await capture;
        else void capture;
      }
      try {
        signal.throwIfAborted();
        this.send(upstreamMessage);
      } catch (error) {
        this.pendingResponses.delete(upstreamRequestId);
        rejectResponse(error instanceof Error ? error : new Error(String(error)));
      }
      return {
        response: signal
          ? responsePromise.finally(() => signal.removeEventListener("abort", abortPendingResponse))
          : responsePromise,
      };
    }

    if (!client || clientRequestId === undefined) {
      throw new Error("Bridge client and client request id are required for external requests.");
    }

    this.pendingResponses.set(upstreamRequestId, {
      client,
      clientRequestId,
      internal: false,
      method,
      requestSource,
      threadHydration,
      upstreamRequest: upstreamMessage,
    });
    if (shouldCapturePollingTranscript(method, requestSource)) {
      const capture = this.captureTranscriptClientRequest(upstreamMessage, {
        propagateFailure: method === "turn/steer",
      });
      if (method === "turn/steer") await capture;
      else void capture;
    }
    try {
      signal.throwIfAborted();
      this.send(upstreamMessage);
    } catch (error) {
      this.pendingResponses.delete(upstreamRequestId);
      const errorMessage = sanitizeTranscriptErrorMessage(error);
      if (method === "turn/steer") {
        void this.captureTranscriptSteerFailure(upstreamMessage, errorMessage);
      }
      throw error;
    }
    return { response: null };
  }

  private toNativeTurnStartResponse(admission: JsonRpcResponse, requestId: number | string | null): JsonRpcResponse {
    if (admission.error) return { id: requestId, error: admission.error };
    const result = asRecord(admission.result);
    const turn = result?.kind === "started" ? result.turn : null;
    return turn && typeof turn === "object"
      ? { id: requestId, result: { turn } }
      : { id: requestId, error: { code: -32000, message: "Codex turn start was not admitted as a new turn." } };
  }

  private async enqueueCommand<TValue>(task: () => TValue | Promise<TValue>) {
    const signal = AbortSignal.any([this.generation.signal]);
    signal.throwIfAborted();
    let onAbort!: () => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const work = this.commandQueue
      .catch(() => undefined)
      .then(() => {
        signal.throwIfAborted();
        return task();
      }).catch((error: unknown) => {
        if (signal.aborted && error !== signal.reason) logError("codex-command", sanitizeTranscriptErrorMessage(error));
        throw error;
      });
    const nextCommand = Promise.race([work, cancellation]).finally(() => signal.removeEventListener("abort", onAbort));
    this.commandQueue = nextCommand.catch(() => undefined);
    return await nextCommand;
  }

  async waitForIdle() {
    if (this.generation.signal.aborted) {
      await this.transcriptQueue;
      await this.waitForTranscriptPersistence();
      return;
    }
    while (true) {
      const currentQueue = this.commandQueue;
      await currentQueue.catch(() => undefined);
      if (this.commandQueue === currentQueue) {
        break;
      }
    }
    await Promise.allSettled(Array.from(this.transcriptTasks));
    await this.transcriptQueue.catch(() => undefined);
    await this.waitForTranscriptPersistence();
  }

  private async persistTranscript<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const persistence = operation();
    this.transcriptPersistence.add(persistence);
    try { return await persistence; }
    finally { this.transcriptPersistence.delete(persistence); }
  }

  private async waitForTranscriptPersistence() {
    while (this.transcriptPersistence.size) await Promise.allSettled([...this.transcriptPersistence]);
  }

  private createTranscriptStore({ reload = false }: { reload?: boolean } = {}) {
    const TranscriptStore = loadCodexTranscriptStore({ reload });
    return new TranscriptStore(this.storageRoot, () => (
      Array.from(this.pendingUserInputRequests.values(), (request) => request.threadId)
    ), this.transcriptShadowLog, () => asString(asRecord(this.initializeResult)?.userAgent));
  }

  private ensureTranscriptStore() {
    if (!this.transcriptStore) {
      this.transcriptStore = this.createTranscriptStore({ reload: this.transcriptStoreReloadPending });
      this.transcriptStoreReloadPending = false;
    }

    return this.transcriptStore;
  }

  async handleUpstreamMessage(message: unknown) {
    if (isJsonRpcResponse(message)) {
      await this.handleUpstreamResponse(message);
      return;
    }

    await this.handleUpstreamNonResponseMessage(message);
  }

  private async handleUpstreamResponse(message: JsonRpcResponse) {
    const pending = this.pendingResponses.get(Number(message.id));
    if (!pending) {
      return;
    }

    this.pendingResponses.delete(Number(message.id));
    try {
      await this.settleUpstreamResponse(pending, message);
    } catch (error) {
      // Removing a pending response transfers settlement here. Identity failure
      // must reject that caller, never leave it waiting forever.
      logError("codex-response", sanitizeTranscriptErrorMessage(error));
      if (isPendingInternalResponse(pending)) pending.reject(error);
      else this.sendToClient(pending.client, {
        id: pending.clientRequestId,
        error: { code: -32000, message: sanitizeTranscriptErrorMessage(error) },
      });
    }
  }

  private async settleUpstreamResponse(pending: PendingResponse, message: JsonRpcResponse) {
    const signal = this.generation.signal;
    if (isPendingInternalResponse(pending) && pending.toolContext) {
      const response = await this.settleToolContext(pending, message);
      pending.resolve(response);
      return;
    }
    if (!message.error && pending.method === "thread/start") {
      const threadId = asString(asRecord(asRecord(message.result)?.thread)?.id)?.trim();
      if (threadId) this.unmaterializedThreadIds.add(threadId);
    }
    if (!message.error && pending.method === "turn/start") {
      const threadId = asString(asRecord(pending.upstreamRequest.params)?.threadId)?.trim();
      if (threadId) this.unmaterializedThreadIds.delete(threadId);
    }
    if (!isPendingInternalResponse(pending) && pending.method === "turn/steer" && !message.error) {
      const turnId = asString(asRecord(message.result)?.turnId)?.trim();
      const threadId = asString(asRecord(pending.upstreamRequest.params)?.threadId)?.trim();
      if (turnId && threadId) this.onAcceptedTurnSteer(threadId);
    }
    let hydratedMessage = message;
    const shouldCaptureTranscript = shouldCapturePollingTranscript(pending.method, pending.requestSource);
    if (shouldHydrateThreadResponse(pending.upstreamRequest, pending.threadHydration)) {
      try {
        hydratedMessage = await this.persistTranscript(() => this.ensureTranscriptStore().hydrateThreadResponse(pending.upstreamRequest, message, {
          hydration: pending.threadHydration,
          touchThread: shouldCaptureTranscript,
        }), signal);
      } catch (error) {
        signal.throwIfAborted();
        this.transcriptShadowLog?.write({
          event: "hydration-failed",
          fields: {
            message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
            method: pending.upstreamRequest.method ?? "unknown",
          },
          level: "error",
          source: "codex-transcript",
        });
      }
    }
    if (this.identities && !hydratedMessage.error) {
      const thread = asRecord(hydratedMessage.result)?.thread as Thread | undefined;
      if (thread?.id && Array.isArray(thread.turns)) await this.resolveTranscriptThreadContext(thread, true, signal);
      if (pending.method === "thread/list") {
        const data = asRecord(hydratedMessage.result)?.data;
        if (Array.isArray(data)) {
          const catalog = await Promise.all((data as Thread[]).map(async (entry) => {
            const context = await this.resolveTranscriptThreadContext(entry, false, signal);
            this.transcriptThreadContexts.set(entry.id, context);
            return { thread: entry, metadata: {
              ...context,
              native: { harness: "codex", nativeLocation: context.nativeLocation, nativeThreadId: entry.id },
            } };
          }));
          await this.persistTranscript(() => admitProviderThreads(this.identities!, catalog), signal);
        }
      }
      if (pending.method === "turn/start") {
        const threadId = asString(asRecord(pending.upstreamRequest.params)?.threadId);
        const turn = asRecord(hydratedMessage.result)?.turn as Turn | undefined;
        if (threadId && turn?.id) {
          await this.persistTranscript(() => admitNativeTranscriptObservations(this.identities!, this.createSqliteProviderStartedTurnObservations(threadId, turn)), signal);
        }
      }
      // Recovery admits its chronological catalogue before newest-first body pages.
      if (pending.method === "thread/turns/list" && pending.requestSource !== "sqliteRecovery") {
        const params = asRecord(pending.upstreamRequest.params);
        const threadId = asString(params?.threadId);
        const data = asRecord(hydratedMessage.result)?.data as Turn[] | undefined;
        if (threadId && Array.isArray(data)) {
          const native = this.identities.threads.knownNativeBinding("codex", threadId);
          const turns = params?.sortDirection === "asc" ? data : [...data].reverse();
          await this.persistTranscript(() => admitProviderNotifications(this.identities!, native, turns.map((turn) => ({
            method: "turn/started" as const, params: { threadId, turn },
          }))), signal);
        }
      }
    }
    signal.throwIfAborted();
    if (shouldCaptureTranscript) {
      void this.captureTranscript(`upstream-response:${pending.upstreamRequest.method ?? "unknown"}`, async () => {
        const transcriptStore = this.ensureTranscriptStore();
        const responseToRecord = pending.threadHydration ? hydratedMessage : message;
        const threadId = asString(asRecord(asRecord(message.result)?.thread)?.id)
          ?? asString(asRecord(pending.upstreamRequest.params)?.threadId);
        const normalisedMessage = threadId
          ? (await this.persistTranscript(() => transcriptStore.externalizeInlineImages(threadId, message))).value
          : message;
        const providerObservations = await this.createSqliteProviderResponseObservations(
          pending.upstreamRequest,
          normalisedMessage,
          Boolean(pending.threadHydration),
        );
        await this.persistTranscript(() => this.transcriptRecording.recordProviderFact({
          observations: providerObservations,
          recordLegacy: async () => {
            await transcriptStore.recordUpstreamResponse(pending.upstreamRequest, responseToRecord);
            if (responseToRecord !== hydratedMessage && shouldRecordHydratedThreadSnapshot(pending.upstreamRequest, message, hydratedMessage)) {
              await transcriptStore.recordHydratedThreadSnapshot(hydratedMessage);
            }
          },
          recordCrossedWorkbenchFacts: async () => {
            const steerSettlements = this.settleTranscriptSteerResponse(pending.upstreamRequest, message);
            if (!steerSettlements.length) return [];
            await transcriptStore.recordSteerSettlements(steerSettlements);
            return steerSettlements.map((entry) => ({
              kind: "steer" as const,
              entry,
              observedAt: entry.resolvedAt!,
            }));
          },
        }));
      }, {
        prepare: this.sqliteTranscriptEnabled && !this.identities && !hydratedMessage.error
          ? async signal => {
            const thread = asRecord(hydratedMessage.result)?.thread as Thread | undefined;
            if (thread?.id && Array.isArray(thread.turns)) await this.resolveTranscriptThreadContext(thread, true, signal);
          }
          : undefined,
      });
    }
    const presentedMessage = this.fileChanges.present(hydratedMessage);
    if (isPendingInternalResponse(pending)) {
      pending.resolve(presentedMessage);
      return;
    }

    this.sendToClient(pending.client, {
      ...presentedMessage,
      id: pending.clientRequestId,
    });
  }

  private async handleUpstreamNonResponseMessage(message: unknown) {
    const signal = this.generation.signal;
    if (isJsonRpcServerRequest(message)) {
      const observation = createCodexTranscriptProviderDynamicToolObservation(message, Date.now());
      if (observation && this.identities) await this.persistTranscript(() => admitNativeTranscriptObservations(this.identities!, [observation]), signal);
      signal.throwIfAborted();
      if (this.identities) {
        const params = asRecord(message.params);
        const threadId = asString(params?.threadId);
        const nativeTurnId = asString(params?.turnId);
        const itemId = asString(params?.itemId);
        if (threadId && nativeTurnId && itemId) {
          const native = this.identities.threads.knownNativeBinding("codex", threadId);
          const canonicalThreadId = this.identities.threads.workbenchIdForNative(native);
          const turnId = this.identities.threads.workbenchTurnIdForNative({ ...native, nativeTurnId });
          await this.persistTranscript(() => this.identities!.items.admit([{
            threadId: canonicalThreadId, sources: [{ turnId, kind: "stable", sourceId: itemId }], legacyAliases: [],
          }]), signal);
        }
      }
      signal.throwIfAborted();
      void this.captureTranscript(`upstream-server-request:${message.method}`, async () => {
        await this.persistTranscript(() => this.transcriptRecording.recordProviderFact({
          observations: observation ? [observation] : [],
          recordLegacy: () => this.ensureTranscriptStore().recordUpstreamServerRequest(message),
        }));
      });
      switch (message.method) {
        case "item/tool/requestUserInput":
          this.handleUpstreamQuestionnaireRequest(message);
          return;
        case "item/commandExecution/requestApproval":
          this.handleUpstreamCommandExecutionApprovalRequest(message);
          return;
        case "item/fileChange/requestApproval":
          this.handleUpstreamFileChangeApprovalRequest(message);
          return;
        case "item/permissions/requestApproval":
          this.handleUpstreamPermissionsApprovalRequest(message);
          return;
        case "applyPatchApproval":
          this.handleUpstreamApplyPatchApprovalRequest(message);
          return;
        case "execCommandApproval":
          this.handleUpstreamExecCommandApprovalRequest(message);
          return;
      }
      return;
    }

    if (isJsonRpcNotification(message)) {
      if (this.identities && message.method === "thread/started") {
        const thread = asRecord(message.params)?.thread as Thread | undefined;
        if (thread?.id) await this.resolveTranscriptThreadContext(thread, true, signal);
      }
      signal.throwIfAborted();
      let syntheticFileChangeNotification: Extract<ServerNotification, { method: "item/completed" }> | null = null;
      if (message.method === "turn/started") {
        const threadId = asString(asRecord(message.params)?.threadId)?.trim();
        const turnId = asString(asRecord(message.params)?.turnId)
          ?? asString(asRecord(asRecord(message.params)?.turn)?.id);
        if (threadId) this.unmaterializedThreadIds.delete(threadId);
        if (threadId && turnId) this.transcriptActiveTurns.set(turnId, threadId);
      }
      if (message.method === "item/started" || message.method === "item/completed") {
        this.fileChanges.recordTurnCursor(message.params);
        const params = asRecord(message.params);
        const item = params?.item as WorkbenchFileChangeItem | undefined;
        const threadId = asString(params?.threadId);
        const turnId = asString(params?.turnId);
        if (message.method === "item/completed" && item?.type === "fileChange" && item.status === "failed" && threadId && turnId) {
          const remembered = this.fileChanges.get(threadId, turnId, item.id)?.item ?? item;
          const recovering = [...this.pendingResponses.values()].some((pending) => (
            isPendingInternalResponse(pending) && pending.toolContext?.threadId === threadId
            && pending.toolContext.turnId === turnId && pending.toolContext.patch?.itemId === item.id
          ));
          if (!recovering && !remembered.workbenchPolicy && !remembered.workbenchFailureKind
            && !remembered.changes.some((change) => change.workbenchAnalysis)) {
            void this.enqueueCommand(() => this.analyseFailedPatch(threadId, turnId, remembered))
              .catch((failure) => logError("codex-patch-findings", sanitizeTranscriptErrorMessage(failure)));
          }
        }
      }
      if (message.method === "turn/completed") {
        const turnId = asString(asRecord(message.params)?.turnId)
          ?? asString(asRecord(asRecord(message.params)?.turn)?.id);
        if (turnId) this.transcriptActiveTurns.delete(turnId);
        const threadId = asString(asRecord(message.params)?.threadId);
        for (const pending of this.pendingResponses.values()) {
          if (!isPendingInternalResponse(pending)) continue;
          const context = pending.toolContext;
          if (context?.threadId === threadId && context.turnId === turnId && context.patch) {
            context.patch.approvalId = null;
          }
        }
        this.fileChanges.clearTurnCursor(message.params);
      }
      if (message.method === "serverRequest/resolved") {
        this.handleServerRequestResolved(message.params);
      }
      if (message.method === "hook/completed") {
        const marker = readWorkbenchFileChangeFailureMarker(message.params);
        if (marker && this.fileChanges.recordFailure(marker)) {
          syntheticFileChangeNotification = {
            method: "item/completed",
            params: {
              completedAtMs: Date.now(),
              item: marker.item,
              threadId: marker.threadId,
              turnId: marker.turnId,
            },
          };
        }
      }
      if (this.identities) {
        const params = asRecord(message.params);
        const threadId = asString(params?.threadId);
        if (threadId && typeof params?.turnId === "string") {
          const native = this.identities.threads.knownNativeBinding("codex", threadId);
          await this.persistTranscript(() => admitProviderNotifications(this.identities!, native, [message as ServerNotification]), signal);
        }
        if (syntheticFileChangeNotification) {
          const native = this.identities.threads.knownNativeBinding("codex", syntheticFileChangeNotification.params.threadId);
          await this.persistTranscript(() => admitProviderNotifications(this.identities!, native, [syntheticFileChangeNotification!]), signal);
        }
      }
      if (this.identities && ["thread/started", "turn/started", "turn/completed", "item/started", "item/completed"].includes(message.method!)) {
        const observations = await this.createSqliteProviderNotificationObservations(message);
        await this.persistTranscript(() => admitNativeTranscriptObservations(this.identities!, observations), signal);
      }
      if (this.identities && syntheticFileChangeNotification) {
        const observations = await this.createSqliteProviderNotificationObservations(syntheticFileChangeNotification);
        await this.persistTranscript(() => admitNativeTranscriptObservations(this.identities!, observations), signal);
      }
      signal.throwIfAborted();
      this.onNotification(this.fileChanges.present(message));
      if (syntheticFileChangeNotification) this.onNotification(syntheticFileChangeNotification);
      if (!shouldRecordDurableTranscriptNotification(message.method)) {
        return;
      }

      const settingsThreadId = message.method === "thread/settings/updated"
        ? asString(asRecord(message.params)?.threadId) : null;
      // Completion may clear the live map before this event reaches the recording queue.
      const settingsTurnId = settingsThreadId
        ? [...this.transcriptActiveTurns].find(([, threadId]) => threadId === settingsThreadId)?.[0]
        : undefined;
      void this.captureTranscript(`upstream-notification:${message.method}`, async () => {
        const transcriptStore = this.ensureTranscriptStore();
        const threadId = asString(asRecord(message.params)?.threadId)
          ?? asString(asRecord(asRecord(message.params)?.thread)?.id);
        const normalisedMessage = threadId
          ? (await this.persistTranscript(() => transcriptStore.externalizeInlineImages(threadId, message))).value
          : message;
        const providerObservations = await this.createSqliteProviderNotificationObservations(normalisedMessage, settingsTurnId);
        if (syntheticFileChangeNotification) {
          providerObservations.push(
            ...await this.createSqliteProviderNotificationObservations(syntheticFileChangeNotification),
          );
        }
        await this.persistTranscript(() => this.transcriptRecording.recordProviderFact({
          observations: providerObservations,
          recordLegacy: () => transcriptStore.recordUpstreamNotification(message),
          recordCrossedWorkbenchFacts: async () => {
            const steerSettlements = this.settleTranscriptSteerNotification(message);
            if (!steerSettlements.length) return [];
            await transcriptStore.recordSteerSettlements(steerSettlements);
            return steerSettlements.map((entry) => ({
              kind: "steer" as const,
              entry,
              observedAt: entry.resolvedAt!,
            }));
          },
        }));
      }, {
        prepare: this.sqliteTranscriptEnabled && !this.identities && message.method === "thread/started"
          ? async signal => {
            const thread = asRecord(message.params)?.thread as Thread | undefined;
            if (thread?.id) await this.resolveTranscriptThreadContext(thread, true, signal);
          }
          : undefined,
      });
    }
  }

  private handleServerRequestResolved(params: unknown) {
    const record = asRecord(params);
    const threadId = asString(record?.threadId);
    const requestId = record?.requestId;
    if (!threadId || (typeof requestId !== "number" && typeof requestId !== "string")) {
      return;
    }

    const requestKey = String(requestId);
    for (const pending of this.pendingResponses.values()) {
      if (!isPendingInternalResponse(pending)) continue;
      const context = pending.toolContext;
      if (context?.threadId === threadId && context.patch && String(context.patch.approvalId) === requestKey) {
        context.patch.approvalId = null;
      }
    }
    const pendingRequest = this.pendingUserInputRequests.get(requestKey);
    if (!pendingRequest || pendingRequest.threadId !== threadId) {
      return;
    }

    this.pendingUserInputRequests.delete(requestKey);
    this.onNotification({
      method: "questionnaire/resolved",
      params: {
        requestKey,
        threadId,
      },
    });
  }

  private logTranscriptInstrumentation() {
    const timestamp = Date.now();
    const diagnostic = createCodexTranscriptDiagnostic({
      lastLoggedAt: this.transcriptLastLogAt,
      memory: process.memoryUsage(),
      now: timestamp,
      pending: [...this.transcriptPendingTasks.values()],
    });
    if (!diagnostic) return;
    this.transcriptLastLogAt = diagnostic.loggedAt;
    this.transcriptShadowLog?.write({
      event: "backlog",
      fields: { message: diagnostic.message },
      level: "warning",
      source: "codex-transcript",
    });
  }

  private captureTranscriptClientRequest(
    request: JsonRpcRequest,
    options: { propagateFailure?: boolean } = {},
  ) {
    return this.captureTranscript("client-request", async () => {
      const admittedSteer = createSteerHistoryEntryFromRequest(request);
      if (admittedSteer) {
        this.transcriptSteers.set(
          transcriptSteerKey(admittedSteer.threadId, admittedSteer.entryKey),
          admittedSteer,
        );
      }
      await this.persistTranscript(() => this.transcriptRecording.recordWorkbenchMutation({
        observations: admittedSteer
          ? [{ kind: "steer", entry: admittedSteer, observedAt: admittedSteer.attemptedAt }]
          : [],
        recordLegacy: () => this.ensureTranscriptStore().recordClientRequest(request, admittedSteer),
      }));
    }, options);
  }

  private captureTranscriptSteerFailure(request: JsonRpcRequest, errorMessage: string) {
    return this.captureTranscript("client-request-failure:turn/steer", async () => {
      const requestedSteer = readSteerHistoryRequest(request);
      const key = requestedSteer?.entryKey
        ? transcriptSteerKey(requestedSteer.threadId, requestedSteer.entryKey)
        : null;
      const admittedSteer = key ? this.transcriptSteers.get(key) : null;
      const settledSteer = admittedSteer
        ? updateSteerEntryStatus(admittedSteer, "failed", Date.now(), { error: errorMessage })
        : null;
      await this.persistTranscript(() => this.transcriptRecording.recordCrossedWorkbenchMutation({
        observations: settledSteer
          ? [{ kind: "steer", entry: settledSteer, observedAt: settledSteer.resolvedAt! }]
          : [],
        recordLegacy: async () => {
          const transcriptStore = this.ensureTranscriptStore();
          await transcriptStore.recordClientRequestFailure(request, errorMessage);
          if (settledSteer) await transcriptStore.recordSteerSettlements([settledSteer]);
        },
      }));
      if (key && settledSteer) this.transcriptSteers.delete(key);
    });
  }

  private async captureTranscript(
    label: string,
    task: () => Promise<unknown>,
    options: {
      propagateFailure?: boolean;
      requireSqlite?: boolean;
      prepare?: (signal: AbortSignal) => Promise<void>;
    } = {},
  ) {
    const signal = this.generation.signal;
    const taskId = this.nextTranscriptTaskId;
    this.nextTranscriptTaskId += 1;
    this.transcriptPendingTasks.set(taskId, { label, startedAt: Date.now() });
    const transcriptTask = this.transcriptQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          if (options.prepare) {
            signal.throwIfAborted();
            let onAbort!: () => void;
            const cancelled = new Promise<never>((_resolve, reject) => {
              onAbort = () => reject(signal.reason);
              signal.addEventListener("abort", onAbort, { once: true });
            });
            try {
              await Promise.race([options.prepare(signal), cancelled]);
              signal.throwIfAborted();
            } finally {
              signal.removeEventListener("abort", onAbort);
            }
          }
          await this.persistTranscript(task);
        } catch (error) {
          if (options.prepare && error === signal.reason) {
            if (options.requireSqlite || options.propagateFailure) throw error;
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          const reportFailure = !(error instanceof CodexTranscriptSqliteRecordingFailure)
            || !this.transcriptSqliteFailureReported;
          if (error instanceof CodexTranscriptSqliteRecordingFailure) {
            this.transcriptSqliteFailureReported = true;
          }
          if (reportFailure) {
            let cause = error;
            for (let depth = 0; depth < 4 && cause instanceof Error && cause.cause instanceof Error; depth++) {
              cause = cause.cause;
            }
            this.transcriptShadowLog?.write({
              event: "capture-failed",
              fields: {
                label, message: message.slice(0, 500),
                ...(cause !== error ? { cause: sanitizeTranscriptErrorMessage(cause).slice(0, 500) } : {}),
              },
              level: "error",
              source: "codex-transcript",
            });
          }
          if (options.requireSqlite || (options.propagateFailure && !(error instanceof CodexTranscriptSqliteRecordingFailure))) {
            throw error;
          }
        }
      });
    this.transcriptQueue = transcriptTask.catch(() => undefined);
    this.transcriptTasks.add(transcriptTask);
    this.logTranscriptInstrumentation();
    try {
      await transcriptTask;
    } finally {
      this.transcriptTasks.delete(transcriptTask);
      this.transcriptPendingTasks.delete(taskId);
    }
  }

  private handleUpstreamQuestionnaireRequest(
    request: Extract<ServerRequest, { method: "item/tool/requestUserInput" }>,
  ) {
    const requestKey = String(request.id);
    const normalizedRequest = normalizeQuestionnaireRequest(request.params, requestKey);
    this.pendingUserInputRequests.set(requestKey, {
      kind: "questionnaire",
      itemId: request.params.itemId?.trim() || null,
      request: normalizedRequest,
      requestKey,
      threadId: request.params.threadId,
      turnId: request.params.turnId,
      upstreamRequestId: request.id,
    });
    this.onNotification({
      method: "questionnaire/requested",
      params: {
        itemId: request.params.itemId?.trim() || null,
        request: normalizedRequest,
        requestKey,
        threadId: request.params.threadId,
        turnId: request.params.turnId,
      },
    });
  }

  private handleUpstreamCommandExecutionApprovalRequest(
    request: Extract<ServerRequest, { method: "item/commandExecution/requestApproval" }>,
  ) {
    const requestKey = String(request.id);
    const normalizedRequest = normalizeCommandExecutionApprovalRequest(requestKey, request.params);
    this.pendingUserInputRequests.set(requestKey, {
      kind: "commandExecutionApproval",
      itemId: request.params.itemId,
      params: request.params,
      request: normalizedRequest,
      requestKey,
      threadId: request.params.threadId,
      turnId: request.params.turnId,
      upstreamRequestId: request.id,
    });
    this.onNotification({
      method: "questionnaire/requested",
      params: {
        itemId: request.params.itemId,
        request: normalizedRequest,
        requestKey,
        threadId: request.params.threadId,
        turnId: request.params.turnId,
      },
    });
  }

  private handleUpstreamFileChangeApprovalRequest(
    request: Extract<ServerRequest, { method: "item/fileChange/requestApproval" }>,
  ) {
    if (request.params.reason === "command failed; retry without sandbox?" && !request.params.grantRoot) {
      const { threadId, turnId, itemId } = request.params;
      void this.queueToolContext({
        threadId, turnId,
        item: { id: randomUUID(), type: "functionCallOutput", name: "patch_recovery", namespace: "workbench", output: "" },
        patch: { itemId, approvalId: request.id },
      });
      return;
    }
    const requestKey = String(request.id);
    const normalizedRequest = normalizeFileChangeApprovalRequest(requestKey, request.params);
    this.pendingUserInputRequests.set(requestKey, {
      kind: "fileChangeApproval",
      itemId: request.params.itemId,
      params: request.params,
      request: normalizedRequest,
      requestKey,
      threadId: request.params.threadId,
      turnId: request.params.turnId,
      upstreamRequestId: request.id,
    });
    this.onNotification({
      method: "questionnaire/requested",
      params: {
        itemId: request.params.itemId,
        request: normalizedRequest,
        requestKey,
        threadId: request.params.threadId,
        turnId: request.params.turnId,
      },
    });
  }

  private handleUpstreamPermissionsApprovalRequest(
    request: Extract<ServerRequest, { method: "item/permissions/requestApproval" }>,
  ) {
    const requestKey = String(request.id);
    const normalizedRequest = normalizePermissionsApprovalRequest(requestKey, request.params);
    this.pendingUserInputRequests.set(requestKey, {
      kind: "permissionsApproval",
      itemId: request.params.itemId,
      params: request.params,
      request: normalizedRequest,
      requestKey,
      threadId: request.params.threadId,
      turnId: request.params.turnId,
      upstreamRequestId: request.id,
    });
    this.onNotification({
      method: "questionnaire/requested",
      params: {
        itemId: request.params.itemId,
        request: normalizedRequest,
        requestKey,
        threadId: request.params.threadId,
        turnId: request.params.turnId,
      },
    });
  }

  private handleUpstreamApplyPatchApprovalRequest(
    request: Extract<ServerRequest, { method: "applyPatchApproval" }>,
  ) {
    const requestKey = String(request.id);
    const normalizedRequest = normalizeApplyPatchApprovalRequest(requestKey, request.params);
    this.pendingUserInputRequests.set(requestKey, {
      kind: "applyPatchApproval",
      itemId: request.params.callId,
      params: request.params,
      request: normalizedRequest,
      requestKey,
      threadId: request.params.conversationId,
      turnId: null,
      upstreamRequestId: request.id,
    });
    this.onNotification({
      method: "questionnaire/requested",
      params: {
        itemId: request.params.callId,
        request: normalizedRequest,
        requestKey,
        threadId: request.params.conversationId,
        turnId: null,
      },
    });
  }

  private handleUpstreamExecCommandApprovalRequest(
    request: Extract<ServerRequest, { method: "execCommandApproval" }>,
  ) {
    const requestKey = String(request.id);
    const normalizedRequest = normalizeExecCommandApprovalRequest(requestKey, request.params);
    this.pendingUserInputRequests.set(requestKey, {
      kind: "execCommandApproval",
      itemId: request.params.callId,
      params: request.params,
      request: normalizedRequest,
      requestKey,
      threadId: request.params.conversationId,
      turnId: null,
      upstreamRequestId: request.id,
    });
    this.onNotification({
      method: "questionnaire/requested",
      params: {
        itemId: request.params.callId,
        request: normalizedRequest,
        requestKey,
        threadId: request.params.conversationId,
        turnId: null,
      },
    });
  }

  private listPendingQuestionnaires() {
    return {
      data: [
        ...Array.from(this.pendingUserInputRequests.values(), (pendingRequest) => ({
          itemId: pendingRequest.itemId,
          request: pendingRequest.request,
          requestKey: pendingRequest.requestKey,
          threadId: pendingRequest.threadId,
          turnId: pendingRequest.turnId,
        })),
        ...this.questionnaires.list().data,
      ],
    };
  }

  private async listQuestionnaireHistory(params: unknown) {
    const record = asRecord(params);
    const threadId = asString(record?.threadId)?.trim() ?? "";
    if (!threadId) {
      throw new Error("Missing questionnaire/history/list thread id.");
    }

    return {
      data: await this.ensureTranscriptStore().listQuestionnaireHistory(threadId),
    };
  }

  private async recordQuestionnaireHistory(params: unknown) {
    const parsed = WorkbenchQuestionnaireHistoryEntrySchema.safeParse(params);
    if (!parsed.success) {
      throw new Error("Invalid questionnaire/history/record params.");
    }

    return await this.settleQuestionnaireHistoryEntry({
      ...parsed.data,
      insertAfterItemId: parsed.data.insertAfterItemId ?? null,
      insertAfterItemIndex: parsed.data.insertAfterItemIndex ?? null,
      itemId: parsed.data.itemId ?? null,
    });
  }

  private async settleQuestionnaireHistoryEntry(historyEntry: WorkbenchQuestionnaireHistoryEntry) {
    let warning: string | null = null;
    const transcriptStore = this.ensureTranscriptStore();
    await this.captureTranscript("workbench-questionnaire-settlement", async () => {
      try {
        await this.persistTranscript(() => this.transcriptRecording.recordCrossedWorkbenchMutation({
          observations: [{
            kind: "questionnaire",
            entry: historyEntry,
            observedAt: historyEntry.resolvedAt,
          }],
          recordLegacy: async () => {
            try {
              await transcriptStore.recordQuestionnaireResolved(historyEntry);
            } catch (error) {
              warning = "Your response was sent, but Workbench could not save it to local transcript history.";
              this.transcriptShadowLog?.write({
                event: "questionnaire-persist-failed",
                fields: { message: (error instanceof Error ? error.message : String(error)).slice(0, 500) },
                level: "error",
                source: "codex-transcript",
                threadId: historyEntry.threadId,
              });
              throw error;
            }
          },
        }));
      } catch (error) {
        if (error instanceof CodexTranscriptSqliteRecordingFailure) {
          warning = "Your response was sent, but Workbench could not save it to SQLite transcript history.";
        }
        throw error;
      }
    });
    return warning ? { ok: true, warning } : { ok: true };
  }

  private async listSteerHistory(params: unknown) {
    const record = asRecord(params);
    const threadId = asString(record?.threadId)?.trim() ?? "";
    if (!threadId) {
      throw new Error("Missing steer/history/list thread id.");
    }

    return {
      data: await this.ensureTranscriptStore().listSteerHistory(threadId),
    };
  }

  private async listBrowseResultEntries(params: unknown) {
    const record = asRecord(params);
    const threadId = asString(record?.threadId)?.trim() ?? "";
    if (!threadId) {
      throw new Error("Missing browse/result/list thread id.");
    }

    return {
      data: await this.ensureTranscriptStore().listBrowseResultEntries(threadId),
    };
  }

  private async readThreadContext(message: JsonRpcRequest, signal = this.generation.signal): Promise<WorkbenchThreadContextReadResponse> {
    signal.throwIfAborted();
    const record = asRecord(message.params);
    const threadId = asString(record?.threadId)?.trim() ?? "";
    if (!threadId) {
      throw new Error("Missing thread/context/read thread id.");
    }

    const hydration = readThreadHydration(message);
    const isSubagentBackgroundRead = record?.workbenchReadScope === "subagentBackground";
    const isThreadRecallRead = record?.workbenchReadScope === "threadRecall";
    const { workbenchReadScope: _workbenchReadScope, ...upstreamParams } = record ?? {};
    if (isThreadRecallRead) {
      const preflightRequest: JsonRpcRequest = {
        method: "thread/read",
        params: {
          ...upstreamParams,
          includeTurns: false,
          threadId,
        },
      };
      const preflightDispatch = await this.dispatchRequest(preflightRequest, { internal: true, signal });
      if (!preflightDispatch.response) throw new Error("Thread Recall preflight did not create an internal response.");
      const preflightResponse = await preflightDispatch.response;
      signal.throwIfAborted();
      if (preflightResponse.error) throw new Error(preflightResponse.error.message);
      const preflightThread = asRecord(asRecord(preflightResponse.result)?.thread);
      const threadCwd = asString(preflightThread?.cwd)?.trim() ?? "";
      if (!threadCwd) throw new Error("Thread Recall preflight did not receive a readable thread CWD.");
      await this.resolveProjectFromCwd(threadCwd, { endpointName: "Thread Recall" });
      signal.throwIfAborted();
    }
    const readParams = {
      ...upstreamParams,
      includeTurns: isSubagentBackgroundRead ? false : record?.includeTurns ?? true,
      threadId,
    };
    const readRequest: JsonRpcRequest = {
      method: "thread/read",
      params: readParams,
      ...(readParams.includeTurns === false && hydration !== null
        ? { [WORKBENCH_REQUEST_SOURCE_FIELD]: "autoRefresh" as const }
        : {}),
      ...(hydration && readParams.includeTurns !== false
        ? { [WORKBENCH_THREAD_HYDRATION_FIELD]: hydration }
        : {}),
    };
    const dispatch = await this.dispatchRequest(readRequest, { internal: true, signal });
    if (!dispatch.response) throw new Error("thread/context/read did not create an internal response.");
    const upstreamReadResponse = await dispatch.response;
    signal.throwIfAborted();
    const transcriptStore = this.ensureTranscriptStore();
    let readResponse = isSubagentBackgroundRead || (readParams.includeTurns === false && hydration !== null)
      ? await this.persistTranscript(() => transcriptStore.hydrateThreadResponse(readRequest, upstreamReadResponse, {
        hydration,
        touchThread: !isSubagentBackgroundRead,
      }), signal)
      : upstreamReadResponse;
    signal.throwIfAborted();
    if (readParams.includeTurns === false && hydration && !readResponse.error) {
      const metadataThread = asRecord(asRecord(upstreamReadResponse.result)?.thread) as Thread | null;
      const hydratedThread = asRecord(asRecord(readResponse.result)?.thread) as Thread | null;
      if (!metadataThread?.id || !hydratedThread?.id) {
        throw new Error("Bounded thread/context/read did not receive a readable thread.");
      }
      const threadWindowStore = this.createThreadWindowStore(transcriptStore);
      const loader = new CodexThreadWindowLoader(request => this.dispatchManagedProviderRequest({
        ...request, [WORKBENCH_REQUEST_SOURCE_FIELD]: "autoRefresh",
      }, signal));
      const providerWindow = await loader.ensureWindow(
        threadWindowStore,
        metadataThread,
        hydratedThread,
        hydration,
        { recoveryOnly: isSubagentBackgroundRead },
      );
      signal.throwIfAborted();
      if (providerWindow) {
        const providerWindowResponse: JsonRpcResponse = {
          ...upstreamReadResponse,
          result: {
            ...(asRecord(upstreamReadResponse.result) ?? {}),
            thread: providerWindow.thread,
          },
        };
        try {
          readResponse = await this.persistTranscript(() => transcriptStore.hydrateThreadResponse(readRequest, providerWindowResponse, {
            hydration,
            touchThread: false,
          }), signal);
        } finally {
          if (!signal.aborted) threadWindowStore.recordProviderWindow(providerWindow.recording);
        }
        signal.throwIfAborted();
      }
    }
    if (readResponse.error) {
      throw new Error(readResponse.error.message);
    }

    const result = asRecord(readResponse.result);
    const thread = asRecord(result?.thread) as Thread | null;
    if (!thread?.id) {
      throw new Error("thread/context/read did not receive a readable thread.");
    }
    if (this.identities) {
      await this.resolveTranscriptThreadContext(thread, true, signal);
    }
    signal.throwIfAborted();
    if (!isSubagentBackgroundRead && hydration && thread.turns.length) {
      this.scheduleSqliteCompatibilityWindowImport(thread, transcriptStore);
    }

    let browseResultEntries: WorkbenchThreadContextReadResponse["browseResultEntries"] = [];
    let questionnaireEntries: WorkbenchThreadContextReadResponse["questionnaireEntries"] = [];
    let steerEntries: WorkbenchThreadContextReadResponse["steerEntries"] = [];
    let entryScope: WorkbenchThreadContextReadResponse["entryScope"];
    if (!isSubagentBackgroundRead) {
      const shouldScopeEntries = requestsHydratedTurnContextEntries(message) && hydration?.mode !== "legacyFull";
      const turnIds = shouldScopeEntries ? thread.turns.map((turn) => turn.id) : null;
      const entries = await transcriptStore.readThreadContextEntries(
        thread.id,
        turnIds ? { turnIds } : {},
      );
      signal.throwIfAborted();
      browseResultEntries = entries.browseResultEntries;
      questionnaireEntries = entries.questionnaireEntries;
      steerEntries = entries.steerEntries;
      if (turnIds) {
        entryScope = { mode: "turns", turnIds };
      }
    }

    if (this.identities) {
      await this.persistTranscript(() => admitNativeTranscriptObservations(this.identities!, [
        ...questionnaireEntries.map((entry) => ({ kind: "questionnaire" as const, entry, observedAt: entry.resolvedAt })),
        ...steerEntries.map((entry) => ({ kind: "steer" as const, entry, observedAt: entry.resolvedAt ?? entry.attemptedAt })),
      ]), signal);
    }
    signal.throwIfAborted();
    return {
      browseResultEntries,
      ...(entryScope ? { entryScope } : {}),
      questionnaireEntries,
      steerEntries,
      thread,
    };
  }

  private async materializeThreadRecallTurn(params: unknown) {
    const record = asRecord(params);
    const threadId = asString(record?.threadId)?.trim() ?? "";
    const turnIdValue = record?.turnId;
    const turnId = turnIdValue === null ? null : asString(turnIdValue)?.trim() ?? "";
    if (!threadId || (turnIdValue !== null && !turnId)) {
      throw new Error("Thread Recall materialisation requires a thread id and optional turn id.");
    }
    return await this.materializeSqliteTranscriptWindow({
      endpointName: "Thread Recall",
      source: "sqlite-thread-recall-materialisation",
      threadId,
      turnIds: turnId ? [turnId] : null,
    });
  }

  private async materializeSqliteTranscriptWindow({
    endpointName,
    source,
    threadId,
    turnIds,
  }: {
    endpointName: string;
    source: string;
    threadId: string;
    turnIds: readonly string[] | null;
  }) {
    // Settle transcript facts admitted before this request before classifying turns as historical gaps.
    const admittedTranscriptQueue = this.transcriptQueue;
    await admittedTranscriptQueue.catch(() => undefined);
    const requestedTurnIds = turnIds ? [...new Set(turnIds)] : null;
    const materializedTurnIds = requestedTurnIds
      ? new Set(await this.readSqliteTranscriptMaterializedTurnIds(threadId, requestedTurnIds))
      : new Set<string>();
    const missingTurnIds = requestedTurnIds?.filter((turnId) => !materializedTurnIds.has(turnId)) ?? null;
    if (missingTurnIds?.length === 0) {
      return { materializedTurnIds: requestedTurnIds ?? [], threadId };
    }
    const transcriptStore = this.ensureTranscriptStore();
    const thread = missingTurnIds
      ? await transcriptStore.readStoredThreadWindow(threadId, missingTurnIds)
      : await transcriptStore.readStoredThreadSnapshot(threadId);
    if (!thread?.id) {
      throw new Error(`${endpointName} has no stored compatibility transcript for ${threadId}.`);
    }
    if (thread.id !== threadId) {
      throw new Error(`${endpointName} compatibility transcript changed thread owner from ${threadId} to ${thread.id}.`);
    }
    const storedTurnIds = new Set(thread.turns.map(({ id }) => id));
    const missingStoredTurnId = missingTurnIds?.find((turnId) => !storedTurnIds.has(turnId));
    if (missingStoredTurnId) {
      throw new Error(`${endpointName} has no stored compatibility turn ${missingStoredTurnId}.`);
    }
    if (!thread.turns.length) {
      throw new Error(`${endpointName} compatibility transcript ${threadId} has no stored turns.`);
    }
    const threadCwd = thread.cwd?.trim() ?? "";
    if (!threadCwd) throw new Error(`${endpointName} compatibility transcript has no readable CWD.`);
    await this.resolveProjectFromCwd(threadCwd, { endpointName });
    await this.resolveTranscriptThreadContext(thread);
    await this.captureTranscript(source, () => (
      this.importSqliteCompatibilityWindow(thread, transcriptStore)
    ), { propagateFailure: true, requireSqlite: true });
    return {
      materializedTurnIds: requestedTurnIds ?? thread.turns.map(({ id }) => id),
      threadId,
    };
  }

  private async readThreadPage(message: JsonRpcRequest, signal: AbortSignal): Promise<WorkbenchThreadPageResponse> {
    const params = WorkbenchThreadPageReadParamsSchema.parse(message.params);
    const hydration: WorkbenchThreadHydrationRequest = params.cursor === null
      ? { mode: "latest" }
      : { beforeTurnId: params.cursor, mode: "previous" };
    const context = await this.readThreadContext({
      method: "thread/context/read",
      params: {
        includeTurns: false,
        ...(params.readScope ? { workbenchReadScope: params.readScope } : {}),
        threadId: params.threadId,
      },
      [WORKBENCH_THREAD_CONTEXT_ENTRIES_FIELD]: { mode: "hydratedTurns" },
      [WORKBENCH_THREAD_HYDRATION_FIELD]: hydration,
    }, signal);
    signal.throwIfAborted();
    const usage = params.cursor === null && params.readScope !== "subagentBackground"
      ? await this.readThreadContextUsage(context.thread.id, signal)
      : undefined;
    signal.throwIfAborted();

    return {
      ...context,
      ...(usage ? { tokenUsage: usage.tokenUsage } : {}),
      nextCursor: readWorkbenchThreadPageNextCursor(context.thread),
    };
  }

  async settleRestartedResponses() {
    const reason = "Codex app-server restarted before the upstream response arrived.";
    const settlements = [...this.retiringResponses].map(async ([id, pending]) => {
      this.retiringResponses.delete(id);
      const response: JsonRpcResponse = { id, error: { code: -32000, message: reason } };
      if (isPendingInternalResponse(pending)) {
        if (pending.toolContext) {
          const toolContext = structuredClone(pending.toolContext);
          if (toolContext.patch) toolContext.patch.approvalId = null;
          pending.resolve(await this.settleToolContext({ ...pending, toolContext }, response));
        } else {
          pending.reject(new Error(reason));
        }
      } else {
        this.sendToClient(pending.client, { ...response, id: pending.clientRequestId });
      }
    });
    await Promise.all(settlements);
  }

  async retireAfterHandoff(_options: CodexStdioBridgeReloadOptions = {}) {
    this.acceptingWork = false;
    if (this.transcriptInstrumentationTimer) clearInterval(this.transcriptInstrumentationTimer);
    this.transcriptInstrumentationTimer = null;
    await this.waitForIdle();
    await this.transcriptStore?.dispose();
    this.transcriptStore = null;
    this.pendingResponses.clear();
    this.pendingUserInputRequests.clear();
  }

  private async readThreadContextUsage(threadId: string, signal = this.generation.signal): Promise<ThreadContextUsageSnapshot | undefined> {
    if (!this.readSqliteContextUsage) return undefined;
    try {
      const stored = await this.readSqliteContextUsage(threadId);
      signal.throwIfAborted();
      if (stored) return stored;
      if (!this.sqliteTranscriptEnabled) return undefined;
      const evidence = await this.ensureTranscriptStore().readStoredUsageEvidence(threadId);
      signal.throwIfAborted();
      if (evidence && evidence.thread.id !== threadId) throw new Error("Context evidence changed thread owner.");
      let invalidEvidence = false;
      const tokenUsage = recoverCodexContextUsage(threadId, evidence?.events ?? [], () => { invalidEvidence = true; });
      if (invalidEvidence) logError("codex-context-usage", "Ignored malformed or foreign retained context measurements.");
      await this.captureTranscript("context-usage-initialisation", () => (
        this.persistTranscript(() => this.transcriptRecording.importCompatibilityWindow(async () => [{
          kind: "threadContextUsage", threadId, snapshot: { tokenUsage }, initialise: true,
        }]), signal)
      ), { requireSqlite: true });
      // Read back the winner: a live event may have arrived while historical evidence was being read.
      return await this.readSqliteContextUsage(threadId) ?? undefined;
    } catch {
      signal.throwIfAborted();
      logError("codex-context-usage", "Unable to restore context usage; thread content remains available.");
      return undefined;
    }
  }

  private async recordBrowseResultEntry(params: unknown) {
    const record = asRecord(params);
    const action = asString(record?.action);
    const actionIndex = asNumber(record?.actionIndex);
    const assetUrl = asString(record?.assetUrl)?.trim() || null;
    const detailKind = asString(record?.detailKind)?.trim() || null;
    const detailLabel = asString(record?.detailLabel)?.trim() || null;
    const detailText = asString(record?.detailText)?.trim() || null;
    const durationMs = asNumber(record?.durationMs);
    const entryKey = asString(record?.entryKey);
    const recordedAt = asNumber(record?.recordedAt);
    const session = asString(record?.session)?.trim() || null;
    const state = asString(record?.state)?.trim() || null;
    const threadId = asString(record?.threadId);
    const turnId = asString(record?.turnId);
    if (
      !action
      || actionIndex === null
      || !entryKey
      || recordedAt === null
      || durationMs === null
      || !state
      || !threadId
      || !turnId
    ) {
      throw new Error("Missing browse/result/record params.");
    }

    const entry: WorkbenchBrowseResultEntry = {
      action: action as WorkbenchBrowseResultEntry["action"],
      actionIndex,
      assetUrl,
      commandItemId: asString(record?.commandItemId) ?? null,
      detailKind: detailKind as WorkbenchBrowseResultEntry["detailKind"],
      detailLabel,
      detailText,
      durationMs,
      entryKey,
      recordedAt,
      session,
      state: state as WorkbenchBrowseResultEntry["state"],
      threadId,
      turnId,
    };
    const transcriptStore = this.ensureTranscriptStore();
    const asset = this.sqliteTranscriptEnabled
      ? await this.readSqliteBrowseAsset(threadId, entry.assetUrl)
      : undefined;
    let recordingError: unknown = null;
    await this.captureTranscript("workbench-browse-settlement", async () => {
      try {
        await this.persistTranscript(() => this.transcriptRecording.recordCrossedWorkbenchMutation({
          observations: [{ kind: "browse", entry, ...(asset ? { asset } : {}) }],
          recordLegacy: () => transcriptStore.recordBrowseResultEntry(entry),
        }));
      } catch (error) {
        if (!(error instanceof CodexTranscriptSqliteRecordingFailure)) recordingError = error;
        throw error;
      }
    });
    if (recordingError) throw recordingError;
    this.onNotification({
      method: "browse/result/recorded",
      params: {
        threadId,
        turnId,
      },
    });
    return { ok: true };
  }

  private async readSqliteBrowseAsset(threadId: string, assetUrl: string | null) {
    if (!assetUrl) return undefined;

    const match = /^\/api\/transcript-assets\/codex\/([^/?#]+)\/([^/?#]+)$/u.exec(assetUrl);
    if (!match) throw new Error("Browse asset URL is not a Workbench Codex transcript asset.");

    const encodedThreadId = decodeURIComponent(match[1]!);
    const fileName = decodeURIComponent(match[2]!);
    const identity = await this.identities?.threads.resolve({ threadId, harness: "codex" });
    const nativeSegments = identity
      ? identity.bindings.filter((binding) => binding.harness === "codex").map((binding) => encodeTranscriptPathSegment(binding.nativeThreadId))
      : [encodeTranscriptPathSegment(threadId)];
    const segments = encodedThreadId === identity?.threadId ? [...new Set(nativeSegments)] : [encodedThreadId];
    if (encodedThreadId !== identity?.threadId && !nativeSegments.includes(encodedThreadId)) {
      throw new Error("Browse asset URL belongs to another thread.");
    }

    const fileMatch = /^([a-f0-9]{64})\.(png|jpg|webp|gif)$/u.exec(fileName);
    if (!fileMatch) throw new Error("Browse asset URL has an invalid content-addressed filename.");
    const [, digest, extension] = fileMatch;
    const threadsRoot = path.resolve(
      this.storageRoot,
      ".workbench",
      "transcripts",
      "codex",
      "threads",
    );
    let bytes: Buffer | null = null;
    for (const segment of segments) {
      const assetPath = path.resolve(threadsRoot, segment, "assets", fileName);
      if (!assetPath.startsWith(`${threadsRoot}${path.sep}`)) {
        throw new Error("Browse asset URL resolves outside the transcript store.");
      }
      try {
        bytes = await readFile(assetPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!bytes) throw new Error("Browse asset was not found in its thread's native storage.");
    const actualDigest = createHash("sha256").update(bytes).digest("hex");
    if (actualDigest !== digest) throw new Error("Browse asset contents do not match its digest.");

    return {
      byteLength: bytes.byteLength,
      digest,
      mimeType: extension === "jpg" ? "image/jpeg" : `image/${extension}`,
      storageKey: assetUrl,
    };
  }

  private readQuestionnaireResponse(params: unknown) {
    const record = asRecord(params);
    const threadId = asString(record?.threadId);
    const requestKey = asString(record?.requestKey) ?? asString(record?.toolCallId);
    const turnId = asString(record?.turnId)?.trim() ?? null;
    const insertAfterItemId = asString(record?.insertAfterItemId)?.trim() ?? null;
    const insertAfterItemIndex = asNumber(record?.insertAfterItemIndex);
    const responseRecord = asRecord(record?.response);
    const answersRecord = asRecord(responseRecord?.answers);
    if (!threadId || !requestKey || !answersRecord) {
      return null;
    }

    const response: WorkbenchUserInputResponse = {
      answers: Object.fromEntries(Object.entries(answersRecord).map(([questionId, answerValue]) => {
        const answerRecord = asRecord(answerValue);
        const answers = Array.isArray(answerRecord?.answers)
          ? answerRecord.answers.filter((entry): entry is string => typeof entry === "string")
          : [];
        return [questionId, { answers }];
      })),
    };

    return {
      insertAfterItemId,
      insertAfterItemIndex,
      requestKey,
      response,
      threadId,
      turnId,
    };
  }

  private buildApprovalResponse(
    pendingRequest: Exclude<PendingCodexUserInputRequest, PendingCodexQuestionnaire>,
    response: WorkbenchUserInputResponse,
  ) {
    const decision = readApprovalDecision(response);
    if (!decision) {
      throw new Error("Choose one of the approval options before submitting.");
    }

    switch (pendingRequest.kind) {
      case "commandExecutionApproval":
        return {
          decision: toCommandExecutionApprovalDecision(decision),
        };
      case "fileChangeApproval":
        return {
          decision: toFileChangeApprovalDecision(decision),
        };
      case "permissionsApproval":
        return decision === "decline"
          ? {
            permissions: {},
            scope: "turn",
          }
          : {
            permissions: toGrantedPermissionProfile(pendingRequest.params.permissions),
            scope: decision === "allow-session" ? "session" : "turn",
          };
      case "applyPatchApproval":
      case "execCommandApproval":
        return {
          decision: toLegacyApprovalDecision(decision),
        };
    }
  }

  private async respondToQuestionnaire(params: unknown) {
    const resolvedResponse = this.readQuestionnaireResponse(params);
    if (!resolvedResponse) {
      throw new Error("Missing questionnaire/respond params.");
    }

    const workbenchQuestionnaire = await this.questionnaires.respond({
      requestKey: resolvedResponse.requestKey,
      response: resolvedResponse.response,
      threadId: resolvedResponse.threadId,
    });
    if (workbenchQuestionnaire) {
      return await this.settleQuestionnaireHistoryEntry({
        insertAfterItemId: resolvedResponse.insertAfterItemId,
        insertAfterItemIndex: resolvedResponse.insertAfterItemIndex,
        itemId: workbenchQuestionnaire.itemId,
        request: workbenchQuestionnaire.request,
        requestKey: workbenchQuestionnaire.requestKey,
        resolvedAt: Date.now(),
        response: workbenchQuestionnaire.response,
        threadId: workbenchQuestionnaire.threadId,
        turnId: resolvedResponse.turnId ?? workbenchQuestionnaire.turnId ?? "",
      });
    }

    const pendingRequest = this.pendingUserInputRequests.get(resolvedResponse.requestKey);
    if (!pendingRequest || pendingRequest.threadId !== resolvedResponse.threadId) {
      throw new Error("That questionnaire is no longer pending.");
    }

    if (pendingRequest.kind !== "questionnaire") {
      this.send({
        id: pendingRequest.upstreamRequestId,
        result: this.buildApprovalResponse(pendingRequest, resolvedResponse.response),
      });
      this.pendingUserInputRequests.delete(pendingRequest.requestKey);
      this.onNotification({
        method: "questionnaire/resolved",
        params: {
          requestKey: pendingRequest.requestKey,
          threadId: pendingRequest.threadId,
        },
      });
      return { ok: true };
    }

    const historyEntry: WorkbenchQuestionnaireHistoryEntry = {
      insertAfterItemId: resolvedResponse.insertAfterItemId ?? pendingRequest.itemId,
      insertAfterItemIndex: resolvedResponse.insertAfterItemIndex,
      itemId: pendingRequest.itemId,
      request: pendingRequest.request,
      requestKey: pendingRequest.requestKey,
      resolvedAt: Date.now(),
      response: resolvedResponse.response,
      threadId: pendingRequest.threadId,
      turnId: resolvedResponse.turnId ?? pendingRequest.turnId ?? "",
    };

    this.send({
      id: pendingRequest.upstreamRequestId,
      result: toToolRequestUserInputResponse(resolvedResponse.response),
    });
    const settlement = await this.settleQuestionnaireHistoryEntry(historyEntry);

    this.pendingUserInputRequests.delete(pendingRequest.requestKey);
    this.onNotification({
      method: "questionnaire/resolved",
      params: {
        requestKey: pendingRequest.requestKey,
        threadId: pendingRequest.threadId,
      },
    });

    return settlement;
  }

  private createThreadWindowStore(transcriptStore: CodexTranscriptStoreInstance): CodexThreadWindowStore {
    return {
      readProviderPreviousCursor: (threadId, beforeTurnId) => (
        transcriptStore.readProviderPreviousCursor(threadId, beforeTurnId)
      ),
      recordProviderWindow: (recording) => {
        let context: CodexTranscriptThreadContext | undefined;
        const labelTurnId = recording.page?.turn.id
          ?? recording.catalog?.turns.at(-1)?.id
          ?? "empty";
        void this.captureTranscript(`provider-turn-window:${recording.thread.id}:${labelTurnId}`, async () => {
          const providerThread = {
            ...recording.thread,
            turns: recording.catalog?.turns ?? (recording.page ? [recording.page.turn] : []),
          };
          const observations = this.createSqliteProviderWindowObservations(providerThread, context);
          await this.persistTranscript(() => this.transcriptRecording.recordProviderFact({
            observations,
            recordLegacy: async () => {
              if (recording.catalog) {
                await transcriptStore.recordProviderTurnCatalog(
                  recording.thread,
                  recording.catalog.turns,
                  recording.catalog.boundary,
                );
              }
              if (recording.page) {
                await transcriptStore.recordProviderTurnPage(
                  recording.thread,
                  recording.page.turn,
                  recording.page.previousCursor,
                );
              }
            },
          }));
        }, {
          prepare: this.sqliteTranscriptEnabled
            ? async signal => { context = await this.resolveTranscriptThreadContext(recording.thread, true, signal); }
            : undefined,
        });
      },
    };
  }

  private async handleManagedMessageAdmission(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = asRecord(message.params);
    const threadId = asString(params?.threadId)?.trim();
    const resumeRequest = asRecord(params?.resumeRequest) as JsonRpcRequest | null;
    const startRequest = asRecord(params?.startRequest) as JsonRpcRequest | null;
    const steerRequest = params?.steerRequest === undefined
      ? null
      : asRecord(params.steerRequest) as JsonRpcRequest | null;
    if (
      !threadId
      || resumeRequest?.method !== "thread/resume"
      || startRequest?.method !== "turn/start"
      || (steerRequest !== null && steerRequest.method !== "turn/steer")
      || asString(asRecord(resumeRequest.params)?.threadId)?.trim() !== threadId
      || asString(asRecord(startRequest.params)?.threadId)?.trim() !== threadId
    ) {
      return { id: message.id ?? null, error: { code: -32602, message: "A valid managed Codex message admission is required." } };
    }

    return await this.admitCodexTurn({
      requestId: message.id ?? null,
      resumeRequest,
      startRequest,
      steerRequest,
    });
  }

  private async admitCodexTurn({
    requestId,
    resumeRequest,
    startRequest,
    steerRequest,
  }: {
    requestId: number | string | null;
    resumeRequest: JsonRpcRequest;
    startRequest: JsonRpcRequest;
    steerRequest: JsonRpcRequest | null;
  }): Promise<JsonRpcResponse> {
    const signal = this.generation.signal;
    const threadId = asString(asRecord(startRequest.params)?.threadId)?.trim();
    if (!threadId) {
      return { id: requestId, error: { code: -32602, message: "Codex turn start requires a thread id." } };
    }
    this.assertAcceptingWork();
    const readResponse = await this.dispatchManagedProviderRequest({
      id: `workbench:admission-read:${String(requestId ?? Date.now())}`,
      method: "thread/read",
      params: { includeTurns: false, threadId },
    }, signal);
    signal.throwIfAborted();
    if (readResponse.error) return { id: requestId, error: readResponse.error };
    const readThread = asRecord(readResponse.result)?.thread as ThreadReadResponse["thread"] | undefined;
    if (!readThread || readThread.id !== threadId) return { id: requestId, error: { code: -32000, message: "Codex admission could not read the requested thread." } };
    if (isThreadStatusActive(readThread.status)) {
      if (asRecord(asRecord(startRequest.params)?.toolOutput)) {
        return await this.dispatchAdmittedTurnStart(requestId, startRequest);
      }
      const activeTurnResponse = await this.dispatchManagedProviderRequest({
        id: `workbench:admission-active-turn:${String(requestId ?? Date.now())}`,
        method: "thread/turns/list",
        params: {
          itemsView: "notLoaded",
          limit: 1,
          sortDirection: "desc",
          threadId,
        },
      });
      signal.throwIfAborted();
      if (activeTurnResponse.error) return { id: requestId, error: activeTurnResponse.error };
      const activeTurns = asRecord(activeTurnResponse.result)?.data;
      if (!Array.isArray(activeTurns)) {
        return { id: requestId, error: { code: -32000, message: "Codex admission could not read the active turn." } };
      }
      return await this.dispatchManagedMessageSteer(
        requestId,
        threadId,
        this.readManagedActiveTurn(readThread, activeTurns as Turn[]),
        startRequest,
        steerRequest,
      );
    }
    if (
      readThread.status.type !== "idle"
      && readThread.status.type !== "notLoaded"
      && readThread.status.type !== "systemError"
    ) {
      return { id: requestId, error: { code: -32000, message: `The Codex thread is ${readThread.status.type}, not inactive.` } };
    }

    if (this.prepareThreadConfiguration) {
      ({ resumeRequest, startRequest } = await this.prepareThreadConfiguration(readThread, { resumeRequest, startRequest }, signal));
      signal.throwIfAborted();
      this.assertAcceptingWork();
    }
    // Fresh threads still need stored configuration, but have no rollout to resume.
    if (this.unmaterializedThreadIds.has(threadId)) {
      return await this.dispatchPreparedTurnStart(requestId, startRequest);
    }
    const unsubscribeResponse = await this.dispatchManagedProviderRequest({
      id: `workbench:admission-unsubscribe:${String(requestId ?? Date.now())}`,
      method: "thread/unsubscribe",
      params: { threadId },
    });
    signal.throwIfAborted();
    if (unsubscribeResponse.error) return { id: requestId, error: unsubscribeResponse.error };

    const resumeResponse = await this.dispatchManagedProviderRequest({
      ...resumeRequest,
      id: `workbench:admission-resume:${String(requestId ?? Date.now())}`,
    });
    signal.throwIfAborted();
    if (resumeResponse.error) {
      return { id: requestId, error: resumeResponse.error };
    } else {
      const resumeResult = asRecord(resumeResponse.result) as ThreadResumeResponse | null;
      const resumedThread = resumeResult?.thread;
      if (!resumedThread) {
        return { id: requestId, error: { code: -32000, message: "Codex admission received no resumed thread." } };
      }
      const resumedTurns = resumeResult.initialTurnsPage?.data ?? resumedThread.turns;
      const resumedActiveTurn = this.readManagedActiveTurn(resumedThread, resumedTurns);
      if (resumedActiveTurn) {
        if (asRecord(asRecord(startRequest.params)?.toolOutput)) {
          return await this.dispatchAdmittedTurnStart(requestId, startRequest);
        }
        return await this.dispatchManagedMessageSteer(requestId, threadId, resumedActiveTurn, startRequest, steerRequest);
      }
      if (resumedThread.status.type !== "idle" && resumedThread.status.type !== "systemError") {
        return { id: requestId, error: { code: -32000, message: `The resumed Codex thread is ${resumedThread.status.type}, not inactive.` } };
      }
    }

    return await this.dispatchPreparedTurnStart(requestId, startRequest);
  }

  private async admitNativeCodexTurn({
    requestId,
    startRequest,
  }: {
    requestId: number | string | null;
    startRequest: JsonRpcRequest;
  }): Promise<JsonRpcResponse> {
    const threadId = asString(asRecord(startRequest.params)?.threadId)?.trim();
    if (!threadId) {
      return { id: requestId, error: { code: -32602, message: "Codex turn start requires a thread id." } };
    }
    return await this.admitCodexTurn({
      requestId,
      resumeRequest: this.instructions.createThreadResume({
        excludeTurns: true,
        threadId,
      }, { kind: "request", request: startRequest }),
      startRequest,
      steerRequest: null,
    });
  }

  private async dispatchPreparedTurnStart(
    requestId: number | string | null,
    startRequest: JsonRpcRequest,
  ): Promise<JsonRpcResponse> {
    const signal = this.generation.signal;
    await this.prepareTurnStart(
      startRequest,
      (request) => this.dispatchManagedProviderRequest(request, signal),
      signal,
    );
    signal.throwIfAborted();
    return await this.dispatchAdmittedTurnStart(requestId, startRequest);
  }

  private async dispatchAdmittedTurnStart(requestId: number | string | null, startRequest: JsonRpcRequest): Promise<JsonRpcResponse> {
    const response = await this.dispatchManagedProviderRequest(startRequest);
    if (response.error) return { id: requestId, error: response.error };
    const turn = asRecord(response.result)?.turn;
    return turn && typeof turn === "object"
      ? { id: requestId, result: { kind: "started", turn } }
      : { id: requestId, error: { code: -32000, message: "Managed Codex turn start returned no turn." } };
  }

  private async dispatchManagedProviderRequest(request: JsonRpcRequest, signal?: AbortSignal) {
    const dispatch = await this.dispatchRequest(request, { internal: true, signal });
    if (!dispatch.response) throw new Error(`Managed Codex request ${request.method} produced no response.`);
    return await dispatch.response;
  }

  private readManagedActiveTurn(thread: Thread, turns: Turn[]) {
    if (!isThreadStatusActive(thread.status)) return null;
    const activeTurn = getCurrentInProgressTurn({ turns });
    if (!activeTurn) throw new Error(`Active Codex thread ${thread.id} has no current in-progress turn.`);
    return activeTurn;
  }

  private async dispatchManagedMessageSteer(
    requestId: number | string | null,
    threadId: string,
    activeTurn: Turn,
    startRequest: JsonRpcRequest,
    steerRequest: JsonRpcRequest | null,
  ): Promise<JsonRpcResponse> {
    const startParams = asRecord(startRequest.params);
    const clientUserMessageId = asString(startParams?.clientUserMessageId)?.trim();
    if (!steerRequest) {
      return {
        id: requestId,
        error: {
          code: -32000,
          message: "The questionnaire response cannot start a new turn while the provider reports an active turn.",
        },
      };
    }
    if (!clientUserMessageId || !Array.isArray(startParams?.input)) {
      return { id: requestId, error: { code: -32602, message: "Managed Codex steer context and message input are required." } };
    }
    const response = await this.dispatchManagedProviderRequest({
      ...steerRequest,
      id: `workbench:admission-steer:${String(requestId ?? Date.now())}`,
      method: "turn/steer",
      params: {
        ...asRecord(steerRequest.params),
        clientUserMessageId,
        expectedTurnId: activeTurn.id,
        input: startParams.input,
        threadId,
      },
    });
    if (response.error) return { id: requestId, error: response.error };
    const turnId = asString(asRecord(response.result)?.turnId)?.trim();
    if (!turnId) {
      return { id: requestId, error: { code: -32000, message: "Managed Codex steer returned no turn id." } };
    }
    this.onAcceptedTurnSteer(threadId);
    return { id: requestId, result: { kind: "steered", turnId } };
  }

  private createSqliteProviderWindowObservations(
    thread: Thread,
    context?: CodexTranscriptThreadContext,
  ): WorkbenchTranscriptObservation[] {
    if (!this.sqliteTranscriptEnabled) return [];
    if (!context) throw new Error(`Codex transcript thread ${thread.id} has no admitted provider context.`);
    return [createCodexTranscriptProviderThreadScopeObservation(thread, context)];
  }

  private async createSqliteProviderResponseObservations(
    request: JsonRpcRequest,
    response: JsonRpcResponse,
    historicalHydration: boolean,
  ): Promise<WorkbenchTranscriptObservation[]> {
    if (
      !this.sqliteTranscriptEnabled
      || response.error
      || (request.method === "thread/read" && historicalHydration)
    ) {
      return [];
    }
    if (request.method === "turn/start") {
      const params = asRecord(request.params);
      const threadId = asString(params?.threadId)?.trim();
      const turn = asRecord(response.result)?.turn as Turn | undefined;
      if (!threadId || !turn?.id) return [];
      const context = this.transcriptThreadContexts.get(threadId);
      const override = readCodexUsageContext(params);
      const usageContext = {
        model: override.model ?? context?.usageContext?.model ?? null,
        serviceTier: params?.serviceTier === null ? null : override.serviceTier ?? context?.usageContext?.serviceTier ?? null,
      };
      if (context) context.usageContext = usageContext;
      return [
        ...await this.createSqliteProviderStartedTurnObservations(threadId, turn),
        createCodexTurnUsageContextObservation({
          model: usageContext.model,
          observedAt: Math.round((turn.startedAt ?? Date.now() / 1_000) * 1_000),
          serviceTier: usageContext.serviceTier,
          threadId,
          turnId: turn.id,
        }),
      ];
    }
    if (!["thread/fork", "thread/read", "thread/resume", "thread/start"].includes(request.method ?? "")) {
      return [];
    }
    const thread = asRecord(response.result)?.thread as Thread | undefined;
    if (!thread?.id || !Array.isArray(thread.turns)) return [];
    const context = this.transcriptThreadContexts.get(thread.id);
    if (!context) throw new Error(`Codex transcript thread ${thread.id} has no admitted provider context.`);
    if (request.method === "thread/start" || request.method === "thread/resume" || request.method === "thread/fork") {
      context.usageContext = readCodexUsageContext(response.result);
    }
    if (request.method === "thread/resume") {
      return [createCodexTranscriptProviderThreadObservation(thread.id, context)];
    }
    return request.method === "thread/read" || request.method === "thread/fork"
      ? [createCodexTranscriptProviderThreadScopeObservation(thread, context)]
      : createCodexTranscriptProviderThreadObservations(thread, context);
  }

  private async createSqliteProviderNotificationObservations(
    notification: JsonRpcNotification,
    settingsTurnId?: string,
  ): Promise<WorkbenchTranscriptObservation[]> {
    if (!this.sqliteTranscriptEnabled) return [];
    if (notification.method === "thread/settings/updated") {
      const params = asRecord(notification.params);
      const threadId = asString(params?.threadId);
      const context = threadId ? this.transcriptThreadContexts.get(threadId) : undefined;
      if (!threadId || !context) return [];
      const usageContext = readCodexUsageContext(params?.threadSettings);
      const previous = context.usageContext;
      context.usageContext = usageContext;
      return settingsTurnId && (usageContext.model !== previous?.model || usageContext.serviceTier !== previous?.serviceTier)
        ? [createCodexTurnUsageContextObservation({
          ...usageContext,
          modelChanged: Boolean(previous?.model && usageContext.model && previous.model !== usageContext.model),
          observedAt: Date.now(), threadId, turnId: settingsTurnId,
        })]
        : [];
    }
    const reroute = createCodexModelRerouteObservation(notification, Date.now());
    if (reroute) return [reroute];
    if (notification.method === "thread/started") {
      const thread = asRecord(notification.params)?.thread as Thread | undefined;
      if (!thread?.id) return [];
      const context = this.transcriptThreadContexts.get(thread.id);
      if (!context) throw new Error(`Codex transcript thread ${thread.id} has no admitted provider context.`);
      return createCodexTranscriptProviderThreadObservations(thread, context);
    }
    if (notification.method === "thread/tokenUsage/updated") {
      const observation = createCodexTurnTokenUsageObservationFromNotification(notification, Date.now());
      if (!observation) return [];
      try {
        return [observation, {
          kind: "threadContextUsage", threadId: observation.threadId,
          snapshot: { tokenUsage: readCodexContextUsage(observation.threadId, notification) }, initialise: false,
        }];
      } catch {
        logError("codex-context-usage", "Rejected malformed context measurement; accounting observation retained.");
        return [observation];
      }
    }
    if (!["turn/started", "turn/completed", "item/started", "item/completed"].includes(notification.method ?? "")) {
      return [];
    }
    const params = asRecord(notification.params);
    const threadId = asString(params?.threadId);
    const turnId = asString(params?.turnId) ?? asString(asRecord(params?.turn)?.id);
    if (!threadId || !turnId) return [];
    if (notification.method === "item/started" || notification.method === "item/completed") {
      const item = extractItem(notification);
      if (!item?.id) return [];
      const providerObservedAt = notification.method === "item/started"
        ? readNotificationNumberParam(notification, "startedAtMs")
        : readNotificationNumberParam(notification, "completedAtMs");
      const observedAt = providerObservedAt ?? Date.now();
      return [createCodexTranscriptProviderItemObservation({
        completedAtMs: notification.method === "item/completed" ? observedAt : undefined,
        item,
        lifecycle: notification.method === "item/started" ? "streaming" : "completed",
        observedAt,
        startedAtMs: notification.method === "item/started" ? observedAt : undefined,
        threadId,
        turnId,
      })];
    }
    const turn = asRecord(params?.turn) as Turn | null;
    if (!turn?.id) return [];
    if (notification.method === "turn/started") {
      return this.createSqliteProviderStartedTurnObservations(threadId, turn);
    }
    const context = this.transcriptThreadContexts.get(threadId);
    if (!context) {
      throw new Error(`Codex transcript thread ${threadId} has no provider context for live turn ${turn.id}`);
    }
    if (notification.method === "turn/completed" && turn.items.length > 0) {
      return [createCodexTranscriptProviderTurnScopeObservation({ context, threadId, turn })];
    }
    return [
      createCodexTranscriptProviderTurnObservation({ context, threadId, turn }),
      ...turn.items.map((item) => createCodexTranscriptProviderItemObservation({
        item,
        lifecycle: notification.method === "turn/completed" ? "completed" : "streaming",
        observedAt: Math.round(
          (turn.completedAt ?? turn.startedAt ?? Date.now() / 1_000) * 1_000,
        ),
        threadId,
        turnId: turn.id,
      })),
    ];
  }

  private createSqliteProviderStartedTurnObservations(
    threadId: string,
    turn: Turn,
  ): WorkbenchTranscriptObservation[] {
    const context = this.transcriptThreadContexts.get(threadId);
    if (!context) {
      throw new Error(`Codex transcript thread ${threadId} has no provider context for live turn ${turn.id}`);
    }
    const observedAt = Math.round((turn.startedAt ?? Date.now() / 1_000) * 1_000);
    return [
      createCodexTranscriptProviderTurnObservation({ context, threadId, turn }),
      ...turn.items.map((item) => createCodexTranscriptProviderItemObservation({
        item,
        lifecycle: "streaming",
        observedAt,
        threadId,
        turnId: turn.id,
      })),
    ];
  }

  private async importSqliteCompatibilityWindow(
    thread: Thread,
    transcriptStore: CodexTranscriptStoreInstance,
  ) {
    if (!this.sqliteTranscriptEnabled) return;
    const requestedTurnIds = thread.turns.map(({ id }) => id);
    const materializedTurnIds = new Set(
      await this.readSqliteTranscriptMaterializedTurnIds(thread.id, requestedTurnIds),
    );
    const missingTurns = thread.turns.filter(({ id }) => !materializedTurnIds.has(id));
    if (missingTurns.length === 0) return;
    await this.transcriptRecording.importCompatibilityWindow(async () => [
      await this.loadSqliteCompatibilityWindow({ ...thread, turns: missingTurns }, transcriptStore),
    ]);
  }

  private scheduleSqliteCompatibilityWindowImport(
    thread: Thread,
    transcriptStore: CodexTranscriptStoreInstance,
  ) {
    const key = transcriptCompatibilityWindowKey(thread);
    const existing = this.pendingCompatibilityWindowImports.get(key);
    if (existing) {
      existing.thread = thread;
      return;
    }
    const pending: PendingCompatibilityWindowImport = { thread };
    this.pendingCompatibilityWindowImports.set(key, pending);
    void this.captureTranscript("sqlite-compatibility-window", () => (
      this.importSqliteCompatibilityWindow(pending.thread, transcriptStore)
    ), {
      prepare: this.sqliteTranscriptEnabled
        ? async signal => { await this.resolveTranscriptThreadContext(pending.thread, true, signal); }
        : undefined,
    }).finally(() => {
      if (this.pendingCompatibilityWindowImports.get(key) === pending) {
        this.pendingCompatibilityWindowImports.delete(key);
      }
    });
  }

  private async resolveTranscriptThreadContext(
    thread: Thread,
    remember = true,
    signal = this.generation.signal,
  ): Promise<CodexTranscriptThreadContext> {
    signal.throwIfAborted();
    const resolution = await this.resolveProjectFromCwd(thread.cwd, { endpointName: "Codex transcript" });
    signal.throwIfAborted();
    const context: CodexTranscriptThreadContext = {
      ...(this.transcriptThreadContexts.get(thread.id)?.usageContext
        ? { usageContext: this.transcriptThreadContexts.get(thread.id)!.usageContext } : {}),
      activityAt: Math.round((thread.recencyAt ?? thread.updatedAt) * 1_000),
      createdAt: Math.round(thread.createdAt * 1_000),
      nativeLocation: thread.cwd,
      projectId: resolution.project.id,
      projectRoot: resolution.root.rootPath,
      title: thread.name?.trim() || thread.preview.trim() || "Untitled thread",
      updatedAt: Math.round(thread.updatedAt * 1_000),
    };
    if (remember) this.transcriptThreadContexts.set(thread.id, context);
    if (this.identities && remember) {
      await this.persistTranscript(() => admitProviderThreads(this.identities!, [{ metadata: {
        ...context,
        native: { harness: "codex", nativeLocation: context.nativeLocation, nativeThreadId: thread.id },
      }, thread }]), signal);
    }
    signal.throwIfAborted();
    return context;
  }

  private settleTranscriptSteerResponse(
    request: JsonRpcRequest,
    response: JsonRpcResponse,
  ) {
    const requestedSteer = readSteerHistoryRequest(request);
    if (!requestedSteer?.entryKey) return [];
    const key = transcriptSteerKey(requestedSteer.threadId, requestedSteer.entryKey);
    const admittedSteer = this.transcriptSteers.get(key);
    if (!admittedSteer) return [];
    const errorMessage = getJsonRpcErrorMessage(response);
    const acknowledgedTurnId = asString(asRecord(response.result)?.turnId)?.trim() ?? "";
    if (errorMessage || !acknowledgedTurnId) {
      const settledSteer = updateSteerEntryStatus(admittedSteer, "failed", Date.now(), {
        error: errorMessage ?? "turn/steer returned an empty turn id.",
      });
      this.transcriptSteers.delete(key);
      return [settledSteer];
    }
    if (admittedSteer.turnId !== acknowledgedTurnId) {
      this.transcriptSteers.set(key, { ...admittedSteer, turnId: acknowledgedTurnId });
    }
    return [];
  }

  private settleTranscriptSteerNotification(
    notification: JsonRpcNotification,
  ) {
    const params = asRecord(notification.params);
    const threadId = asString(params?.threadId);
    const turn = asRecord(params?.turn) as Turn | null;
    const turnId = asString(params?.turnId) ?? turn?.id ?? null;
    if (!threadId || !turnId) return [];
    const admitted = [...this.transcriptSteers.values()].filter((entry) => (
      entry.threadId === threadId && entry.turnId === turnId
    ));
    if (!admitted.length) return [];

    let settled = admitted;
    const resolvedAt = Date.now();
    if (notification.method === "item/completed") {
      const item = extractItem(notification);
      if (!item || item.type !== "userMessage") return [];
      settled = updateNativeSteerEntriesForUserMessage(settled, turnId, item, resolvedAt);
      settled = updateMatchingPendingSteerEntriesForUserMessage(settled, item, resolvedAt);
    } else if (notification.method === "turn/completed" && turn) {
      for (const item of turn.items) {
        settled = updateNativeSteerEntriesForUserMessage(settled, turn.id, item, resolvedAt);
        settled = updateMatchingPendingSteerEntriesForUserMessage(settled, item, resolvedAt);
      }
      if (turn.status === "interrupted") {
        settled = updateNativeSteerEntriesForInterruptedTurn(settled, turn, resolvedAt);
        settled = updatePendingSteerEntriesForInterruptedTurn(settled, turn, resolvedAt);
      }
    } else {
      return [];
    }

    const terminal = settled.filter((entry) => entry.status !== "pending");
    for (const entry of terminal) {
      this.transcriptSteers.delete(transcriptSteerKey(entry.threadId, entry.entryKey));
    }
    return terminal;
  }

  private async loadSqliteCompatibilityWindow(
    thread: Thread,
    transcriptStore: CodexTranscriptStoreInstance,
  ): Promise<WorkbenchTranscriptObservation> {
    const context = this.transcriptThreadContexts.get(thread.id);
    if (!context) throw new Error(`Codex transcript thread ${thread.id} has no admitted provider context.`);
    const materializedTurnIds = thread.turns.map(({ id }) => id);
    const entries = await transcriptStore.readThreadContextEntries(thread.id, { turnIds: materializedTurnIds });
    const browseAssets = new Map<string, Extract<WorkbenchTranscriptAtomicObservation, { kind: "browse" }>["asset"]>();
    for (const entry of entries.browseResultEntries) {
      const asset = await this.readSqliteBrowseAsset(thread.id, entry.assetUrl);
      if (asset) browseAssets.set(entry.entryKey, asset);
    }
    return createCodexTranscriptSqliteImport({
      browseAssets,
      browseResultEntries: entries.browseResultEntries,
      context,
      questionnaireEntries: entries.questionnaireEntries,
      steerEntries: entries.steerEntries,
      thread,
    });
  }
}
