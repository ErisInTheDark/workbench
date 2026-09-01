/*
 * Exports:
 * - CodexStdioBridgeOptions: inject app-server, browser, instruction, transcript, and reload-generation boundaries. Keywords: codex, bridge, options, reload.
 * - CodexStdioBridgeReloadState: transferable bridge state preserved across code-only reload. Keywords: codex, reload, state.
 * - default CodexStdioBridge: translate websocket requests and Codex app-server messages around a stable app-server process. Keywords: codex, stdio, websocket, bridge.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ApplyPatchApprovalParams } from "../lib/codex/generated/app-server/ApplyPatchApprovalParams";
import type { ExecCommandApprovalParams } from "../lib/codex/generated/app-server/ExecCommandApprovalParams";
import type { ReviewDecision } from "../lib/codex/generated/app-server/ReviewDecision";
import type { ServerRequest } from "../lib/codex/generated/app-server/ServerRequest";
import type { CommandExecutionApprovalDecision } from "../lib/codex/generated/app-server/v2/CommandExecutionApprovalDecision";
import type { CommandExecutionRequestApprovalParams } from "../lib/codex/generated/app-server/v2/CommandExecutionRequestApprovalParams";
import type { FileChangeApprovalDecision } from "../lib/codex/generated/app-server/v2/FileChangeApprovalDecision";
import type { FileChangeRequestApprovalParams } from "../lib/codex/generated/app-server/v2/FileChangeRequestApprovalParams";
import type { GrantedPermissionProfile } from "../lib/codex/generated/app-server/v2/GrantedPermissionProfile";
import type { PermissionsRequestApprovalParams } from "../lib/codex/generated/app-server/v2/PermissionsRequestApprovalParams";
import type { RequestPermissionProfile } from "../lib/codex/generated/app-server/v2/RequestPermissionProfile";
import type { Thread } from "../lib/codex/generated/app-server/v2/Thread";
import type { ThreadItem } from "../lib/codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "../lib/codex/generated/app-server/v2/Turn";
import type { ThreadReadResponse } from "../lib/codex/generated/app-server/v2/ThreadReadResponse";
import type { ThreadResumeResponse } from "../lib/codex/generated/app-server/v2/ThreadResumeResponse";
import { getCurrentInProgressTurn, isThreadStatusActive } from "../lib/codex/thread-state";
import type { ToolRequestUserInputParams } from "../lib/codex/generated/app-server/v2/ToolRequestUserInputParams";
import type { ToolRequestUserInputQuestion } from "../lib/codex/generated/app-server/v2/ToolRequestUserInputQuestion";
import type { ToolRequestUserInputResponse } from "../lib/codex/generated/app-server/v2/ToolRequestUserInputResponse";
import type { TurnSteerResponse } from "../lib/codex/generated/app-server/v2/TurnSteerResponse";
import type { UserInput } from "../lib/codex/generated/app-server/v2/UserInput";
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
} from "../lib/types";
import type { resolveAgentEndpointProjectFromCwd } from "../lib/workbench/project/agent-endpoint-project";
import {
  getWorkbenchFileChangeFailureKey,
  readWorkbenchFileChangeFailureMarker,
  withWorkbenchFileChangeFailure,
  type WorkbenchFileChangeFailureMarker,
} from "../lib/workbench/thread/workbench-file-change";
import {
  readWorkbenchThreadPageNextCursor,
  WORKBENCH_THREAD_PAGE_READ_METHOD,
  WorkbenchThreadPageReadParamsSchema,
  type WorkbenchThreadPageResponse,
} from "../lib/workbench/thread/workbench-thread-page";
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
  createCodexTranscriptProviderThreadObservation,
  createCodexTranscriptProviderThreadObservations,
  createCodexTranscriptProviderTurnObservation,
  type CodexTranscriptProviderContext,
} from "./codex-transcript-provider-observations.ts";
import {
  createSteerHistoryEntryFromRequest,
  getJsonRpcErrorMessage,
  updateMatchingPendingSteerEntriesForUserMessage,
  updateNativeSteerEntriesForInterruptedTurn,
  updateNativeSteerEntriesForUserMessage,
  updatePendingSteerEntriesForInterruptedTurn,
  updateSteerEntryStatus,
} from "./codex-transcript-steer-history.ts";
import { getProcessWorkbenchAgentMcpRequestRegistry } from "./workbench-agent-mcp-request-registry";
import { CODEX_TRANSCRIPT_DIAGNOSTIC_INTERVAL_MS, createCodexTranscriptDiagnostic } from "./codex-transcript-diagnostics";
import {
  encodeTranscriptPathSegment,
  extractItem,
} from "./codex-transcript-normalizers";
import type CodexAppServer from "./CodexAppServer";
import type { WorkbenchCodexInstructionPort } from "./WorkbenchCodexInstructionAdapter";
import CodexThreadPageReadController from "./CodexThreadPageReadController";
import CodexThreadWindowLoader, { type CodexThreadWindowStore } from "./CodexThreadWindowLoader";
import CodexTranscriptRecordingController, {
  CodexTranscriptSqliteRecordingFailure,
} from "./CodexTranscriptRecordingController";
import type { OrchestratorTranscriptShadowLog } from "./orchestrator-runtime-objects";
import { logError } from "./process-helpers";
import { WORKBENCH_PROMPT_CONTEXT_FIELD } from "./workbench-prompt-context";

type CodexTranscriptStoreInstance = import("./CodexTranscriptStore").default;
type CodexTranscriptStoreConstructor = new (
  projectRoot: string,
  getProtectedThreadIds?: () => Iterable<string>,
  transcriptShadowLog?: OrchestratorTranscriptShadowLog,
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
  onAcceptedTurnSteer?: (threadId: string) => void;
  onNotification: (notification: JsonRpcNotification) => void;
  prepareTurnStart?: (
    message: JsonRpcRequest,
    requestProvider: (request: JsonRpcRequest) => Promise<JsonRpcResponse>,
  ) => Promise<void>;
  recordSqliteTranscript?: (
    observations: readonly WorkbenchTranscriptObservation[],
    context: WorkbenchTranscriptRecordingContext,
  ) => Promise<void>;
  readSqliteTranscriptMaterializedTurnIds?: (
    threadId: string,
    turnIds: readonly string[],
  ) => Promise<readonly string[]>;
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

type RequestIdAllocator = {
  next: number;
};

export type CodexStdioBridgeReloadState = {
  fileChangeFailureMarkers?: Map<string, WorkbenchFileChangeFailureMarker>;
  fileChangeTurnCursors?: Map<string, string>;
  initializeResult: unknown;
  unmaterializedThreadIds?: Set<string>;
  pendingResponses: Map<number, PendingResponse>;
  pendingUserInputRequests: Map<string, PendingCodexUserInputRequest>;
  requestIdAllocator: RequestIdAllocator;
  transcriptActiveTurns?: Map<string, string>;
  transcriptSteers?: Map<string, WorkbenchSteerHistoryEntry>;
  transcriptThreadContexts?: Map<string, CodexTranscriptThreadContext>;
  upstreamInitialized: boolean;
};

type CodexTranscriptThreadContext = CodexTranscriptProviderContext;

type CodexSqliteTranscriptObservation = WorkbenchTranscriptObservation;

const MAX_FILE_CHANGE_FAILURE_MARKERS = 2_048;
const MAX_FILE_CHANGE_TURN_CURSORS = 2_048;

function fileChangeTurnKey(threadId: string, turnId: string) {
  return `${threadId}\0${turnId}`;
}

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
const TRANSCRIPT_MAX_PENDING_TASKS = 200;
const TRANSCRIPT_COALESCE_FLUSH_MS = 100;
const TRANSCRIPT_COALESCE_MAX_BUFFER_BYTES = 512 * 1024;
const WORKBENCH_REQUEST_SOURCE_FIELD = "workbenchRequestSource";
const WORKBENCH_THREAD_HYDRATION_FIELD = "workbenchThreadHydration";
const WORKBENCH_THREAD_CONTEXT_ENTRIES_FIELD = "workbenchThreadContextEntries";
type WorkbenchRequestSource = "autoRefresh" | "internal" | "sqliteBaseline" | "sqliteRecovery" | "user";

type CoalescedTranscriptNotification = {
  key: string;
  notification: JsonRpcNotification;
};

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

function withTimeout<TValue>(promise: Promise<TValue>, timeoutMs: number | undefined, message: string) {
  if (timeoutMs === undefined) {
    return promise;
  }

  return new Promise<TValue>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
    timer.unref();

    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
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
  if (requestSource !== "autoRefresh") {
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

function isStreamingTranscriptNotification(notification: JsonRpcNotification) {
  switch (notification.method) {
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/commandExecution/outputDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
    case "item/fileChange/patchUpdated":
      return true;
    default:
      return false;
  }
}

function getCoalescedTranscriptNotification(notification: JsonRpcNotification): CoalescedTranscriptNotification | null {
  if (!isStreamingTranscriptNotification(notification)) {
    return null;
  }

  const threadId = readNotificationStringParam(notification, "threadId");
  const turnId = readNotificationStringParam(notification, "turnId");
  const itemId = readNotificationStringParam(notification, "itemId");
  if (!threadId || !turnId || !itemId) {
    return null;
  }

  const params = asRecord(notification.params) ?? {};
  const keyParts = [notification.method, threadId, turnId, itemId];
  if (notification.method === "item/reasoning/summaryPartAdded" || notification.method === "item/reasoning/summaryTextDelta") {
    keyParts.push(String(readNotificationNumberParam(notification, "summaryIndex") ?? ""));
  }
  if (notification.method === "item/reasoning/textDelta") {
    keyParts.push(String(readNotificationNumberParam(notification, "contentIndex") ?? ""));
  }

  const key = keyParts.join(":");
  switch (notification.method) {
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/commandExecution/outputDelta":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
      return {
        key,
        notification: {
          ...notification,
          params: {
            ...params,
            delta: asString(params.delta) ?? "",
          },
        },
      };
    default:
      return { key, notification };
  }
}

function mergeCoalescedTranscriptNotification(
  current: JsonRpcNotification,
  incoming: JsonRpcNotification,
) {
  const currentParams = asRecord(current.params) ?? {};
  const incomingParams = asRecord(incoming.params) ?? {};
  switch (incoming.method) {
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/commandExecution/outputDelta":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
      return {
        ...incoming,
        params: {
          ...incomingParams,
          delta: `${asString(currentParams.delta) ?? ""}${asString(incomingParams.delta) ?? ""}`,
        },
      } satisfies JsonRpcNotification;
    default:
      return incoming;
  }
}

function estimateCoalescedTranscriptNotificationBytes(notification: JsonRpcNotification) {
  const params = asRecord(notification.params) ?? {};
  const delta = asString(params.delta);
  if (delta !== null) {
    return delta.length * 2;
  }

  try {
    return JSON.stringify(notification).length * 2;
  } catch {
    return 1024;
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
  private readonly fileChangeFailureMarkers: Map<string, WorkbenchFileChangeFailureMarker>;
  private readonly fileChangeTurnCursors: Map<string, string>;
  private readonly onAcceptedTurnSteer: NonNullable<CodexStdioBridgeOptions["onAcceptedTurnSteer"]>;
  private readonly onNotification: CodexStdioBridgeOptions["onNotification"];
  private readonly prepareTurnStart: NonNullable<CodexStdioBridgeOptions["prepareTurnStart"]>;
  private readonly sqliteTranscriptEnabled: boolean;
  private readonly sendToClient: CodexStdioBridgeOptions["sendToClient"];
  private readonly storageRoot: string;
  private readonly threadPageReads = new CodexThreadPageReadController();
  private readonly threadWindowLoader: CodexThreadWindowLoader;
  private threadPageReadsPreparedForReload = false;
  private transcriptStore: CodexTranscriptStoreInstance | null = null;
  private transcriptStoreReloadPending = false;
  private initializeResult: unknown;
  private acceptingWork = true;
  private commandQueue: Promise<unknown> = Promise.resolve();
  private readonly pendingUserInputRequests: Map<string, PendingCodexUserInputRequest>;
  private readonly pendingResponses: Map<number, PendingResponse>;
  private readonly requestIdAllocator: RequestIdAllocator;
  private transcriptQueue: Promise<void> = Promise.resolve();
  private readonly transcriptTasks = new Set<Promise<void>>();
  private readonly transcriptPendingTasks = new Map<number, { label: string; startedAt: number }>();
  private readonly transcriptInstrumentationTimer: NodeJS.Timeout;
  private readonly coalescedTranscriptNotifications = new Map<string, JsonRpcNotification>();
  private coalescedTranscriptFlushTimer: NodeJS.Timeout | null = null;
  private coalescedTranscriptFlushPromise: Promise<void> | null = null;
  private coalescedTranscriptByteEstimate = 0;
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

  constructor({ appServer, bridgeUrl, handleWorkbenchRequest, initialState, instructions = UNCONFIGURED_CODEX_INSTRUCTIONS, onAcceptedTurnSteer = (threadId) => { getProcessWorkbenchAgentMcpRequestRegistry().interruptThreadWaits(threadId); }, onNotification, prepareTurnStart = async () => undefined, readSqliteTranscriptMaterializedTurnIds = async () => [], recordSqliteTranscript, restartingAppServer = false, resolveProjectFromCwd, sendToClient, storageRoot, transcriptShadowLog }: CodexStdioBridgeOptions) {
    this.appServer = appServer;
    this.bridgeUrl = bridgeUrl;
    this.onAcceptedTurnSteer = onAcceptedTurnSteer;
    this.onNotification = onNotification;
    this.prepareTurnStart = prepareTurnStart;
    this.sqliteTranscriptEnabled = Boolean(recordSqliteTranscript);
    this.readSqliteTranscriptMaterializedTurnIds = readSqliteTranscriptMaterializedTurnIds;
    this.resolveProjectFromCwd = resolveProjectFromCwd;
    this.handleWorkbenchRequest = handleWorkbenchRequest;
    this.instructions = instructions;
    this.sendToClient = sendToClient;
    this.storageRoot = storageRoot;
    this.transcriptShadowLog = transcriptShadowLog;
    this.threadWindowLoader = new CodexThreadWindowLoader(async (request) => {
      const dispatch = await this.dispatchRequest({
        ...request,
        [WORKBENCH_REQUEST_SOURCE_FIELD]: "autoRefresh",
      }, { internal: true });
      if (!dispatch.response) throw new Error(`${request.method ?? "Codex request"} did not create an internal response.`);
      return await dispatch.response;
    });
    this.fileChangeFailureMarkers = initialState?.fileChangeFailureMarkers ?? new Map();
    this.fileChangeTurnCursors = initialState?.fileChangeTurnCursors ?? new Map();
    this.initializeResult = initialState?.initializeResult ?? null;
    this.pendingResponses = initialState?.pendingResponses ?? new Map();
    this.pendingUserInputRequests = initialState?.pendingUserInputRequests ?? new Map();
    this.requestIdAllocator = initialState?.requestIdAllocator ?? { next: 1 };
    this.transcriptActiveTurns = initialState?.transcriptActiveTurns ?? new Map();
    this.transcriptThreadContexts = initialState?.transcriptThreadContexts ?? new Map();
    this.transcriptSteers = initialState?.transcriptSteers ?? new Map();
    this.unmaterializedThreadIds = initialState?.unmaterializedThreadIds ?? new Set();
    this.transcriptRecording = new CodexTranscriptRecordingController({
      ...(recordSqliteTranscript ? { recordSqlite: recordSqliteTranscript } : {}),
    });
    this.upstreamInitialized = initialState?.upstreamInitialized ?? false;
    if (restartingAppServer) {
      this.resetUpstreamState("Codex app-server restarted before the upstream response arrived.");
    }
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
    clearInterval(this.transcriptInstrumentationTimer);
    if (this.coalescedTranscriptFlushTimer) {
      clearTimeout(this.coalescedTranscriptFlushTimer);
      this.coalescedTranscriptFlushTimer = null;
    }
    this.coalescedTranscriptNotifications.clear();
    this.coalescedTranscriptByteEstimate = 0;
    this.fileChangeFailureMarkers.clear();
    this.fileChangeTurnCursors.clear();
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
  }

  async prepareForReload(options: CodexStdioBridgeReloadOptions = {}) {
    if (this.threadPageReadsPreparedForReload) return;
    this.threadPageReads.beginDrain();
    try {
      await withTimeout(
        this.threadPageReads.waitForIdle(),
        options.idleTimeoutMs,
        "Codex bridge is busy with active thread-page reads; retry reload after those reads settle.",
      );
      this.threadPageReadsPreparedForReload = true;
    } catch (error) {
      this.threadPageReads.resumeAfterFailedReload();
      throw error;
    }
  }

  resumeAfterReloadFailure() {
    if (!this.acceptingWork) return;
    this.threadPageReadsPreparedForReload = false;
    this.threadPageReads.resumeAfterFailedReload();
  }

  async detachForReload(options: CodexStdioBridgeReloadOptions = {}): Promise<CodexStdioBridgeReloadState> {
    await this.prepareForReload(options);
    try {
      await withTimeout(
        this.waitForIdle(),
        options.idleTimeoutMs,
        "Codex bridge is busy with active work; retry reload after the current bridge work settles.",
      );
    } catch (error) {
      this.resumeAfterReloadFailure();
      throw error;
    }
    this.acceptingWork = false;
    clearInterval(this.transcriptInstrumentationTimer);
    if (this.transcriptStore) {
      await this.transcriptStore.dispose();
      this.transcriptStore = null;
    }
    if (options.restartingAppServer) {
      this.resetUpstreamState("Codex app-server restarted before the upstream response arrived.");
    }
    return {
      fileChangeFailureMarkers: this.fileChangeFailureMarkers,
      fileChangeTurnCursors: this.fileChangeTurnCursors,
      initializeResult: this.initializeResult,
      pendingResponses: this.pendingResponses,
      pendingUserInputRequests: this.pendingUserInputRequests,
      requestIdAllocator: this.requestIdAllocator,
      transcriptActiveTurns: this.transcriptActiveTurns,
      transcriptSteers: this.transcriptSteers,
      transcriptThreadContexts: this.transcriptThreadContexts,
      unmaterializedThreadIds: this.unmaterializedThreadIds,
      upstreamInitialized: this.upstreamInitialized,
    };
  }

  private resetUpstreamState(reason: string) {
    this.pendingUserInputRequests.clear();
    this.transcriptActiveTurns.clear();
    this.unmaterializedThreadIds.clear();
    for (const pending of this.pendingResponses.values()) {
      if (isPendingInternalResponse(pending)) pending.reject(new Error(reason));
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

    this.upstreamInitializePromise = (async () => {
      const dispatch = await this.dispatchRequest(initializeMessage, { internal: true });
      if (!dispatch.response) {
        throw new Error("Codex initialize request did not create an internal response.");
      }
      const response = await dispatch.response;
      if (response.error) {
        throw new Error(response.error.message);
      }

      this.initializeResult = response.result;
      this.send({ method: "initialized" });
      this.upstreamInitialized = true;
    })();

    try {
      await this.upstreamInitializePromise;
    } finally {
      this.upstreamInitializePromise = null;
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

  async recoverSqliteTranscriptThread(threadId: string) {
    this.assertAcceptingWork();
    const response = await this.dispatchManagedProviderRequest({
      id: `workbench:sqlite-transcript-recovery:${threadId}`,
      method: "thread/read",
      params: { includeTurns: true, threadId },
      [WORKBENCH_REQUEST_SOURCE_FIELD]: "sqliteRecovery",
    });
    if (response.error) {
      throw new Error(`Codex could not recover SQLite transcript thread ${threadId}: ${response.error.message}`);
    }
    const recoveredThreadId = asString(asRecord(asRecord(response.result)?.thread)?.id)?.trim();
    if (recoveredThreadId !== threadId) {
      throw new Error(`Codex SQLite transcript recovery returned the wrong thread for ${threadId}.`);
    }
  }

  get activeSqliteTranscriptThreadIds() {
    return [...new Set(this.transcriptActiveTurns.values())];
  }

  async baselineSqliteTranscriptThread(threadId: string) {
    this.assertAcceptingWork();
    const response = await this.dispatchManagedProviderRequest({
      id: `workbench:sqlite-transcript-baseline:${threadId}`,
      method: "thread/read",
      params: { includeTurns: true, threadId },
      [WORKBENCH_REQUEST_SOURCE_FIELD]: "sqliteBaseline",
    });
    if (response.error) {
      throw new Error(`Codex could not baseline SQLite transcript thread ${threadId}: ${response.error.message}`);
    }
    const baselineThreadId = asString(asRecord(asRecord(response.result)?.thread)?.id)?.trim();
    if (baselineThreadId !== threadId) {
      throw new Error(`Codex SQLite transcript baseline returned the wrong thread for ${threadId}.`);
    }
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

  private async handleThreadPageReadRequest(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    const requestId = message.id ?? null;

    try {
      this.assertAcceptingWork();
      return {
        id: requestId,
        result: await this.threadPageReads.run(
          () => this.readThreadPage(message),
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

  private recordFileChangeFailure(marker: WorkbenchFileChangeFailureMarker) {
    const key = getWorkbenchFileChangeFailureKey({
      itemId: marker.item.id,
      threadId: marker.threadId,
      turnId: marker.turnId,
    });
    if (this.fileChangeFailureMarkers.has(key)) return false;
    this.fileChangeFailureMarkers.set(key, {
      ...marker,
      insertAfterItemId: this.fileChangeTurnCursors.get(fileChangeTurnKey(marker.threadId, marker.turnId)) ?? null,
    });
    while (this.fileChangeFailureMarkers.size > MAX_FILE_CHANGE_FAILURE_MARKERS) {
      const oldestKey = this.fileChangeFailureMarkers.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.fileChangeFailureMarkers.delete(oldestKey);
    }
    return true;
  }

  private recordFileChangeTurnCursor(value: unknown) {
    const params = asRecord(value);
    const item = asRecord(params?.item);
    const itemId = asString(item?.id);
    const threadId = asString(params?.threadId);
    const turnId = asString(params?.turnId);
    if (!itemId || !threadId || !turnId) return;
    const key = fileChangeTurnKey(threadId, turnId);
    this.fileChangeTurnCursors.delete(key);
    this.fileChangeTurnCursors.set(key, itemId);
    while (this.fileChangeTurnCursors.size > MAX_FILE_CHANGE_TURN_CURSORS) {
      const oldestKey = this.fileChangeTurnCursors.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.fileChangeTurnCursors.delete(oldestKey);
    }
  }

  private clearFileChangeTurnCursor(value: unknown) {
    const params = asRecord(value);
    const turn = asRecord(params?.turn);
    const threadId = asString(params?.threadId);
    const turnId = asString(turn?.id);
    if (threadId && turnId) this.fileChangeTurnCursors.delete(fileChangeTurnKey(threadId, turnId));
  }

  private withFileChangeFailurePresentation<TMessage extends JsonRpcNotification | JsonRpcResponse>(message: TMessage): TMessage {
    if ("method" in message && message.method === "item/completed") {
      const params = asRecord(message.params);
      const item = asRecord(params?.item);
      if (item?.type !== "fileChange" || item.status !== "failed") return message;
      const threadId = asString(params?.threadId);
      const turnId = asString(params?.turnId);
      const itemId = asString(item.id);
      if (!threadId || !turnId || !itemId) return message;
      const marker = this.fileChangeFailureMarkers.get(getWorkbenchFileChangeFailureKey({ itemId, threadId, turnId }));
      if (!marker) return message;
      return {
        ...message,
        params: {
          ...params,
          item: withWorkbenchFileChangeFailure(item as Extract<ThreadItem, { type: "fileChange" }>, "unclaimed"),
        },
      } as TMessage;
    }

    if (!("result" in message)) return message;
    const result = asRecord(message.result);
    const thread = asRecord(result?.thread) as Thread | null;
    if (!thread?.id) return message;
    const markersByTurnId = new Map<string, WorkbenchFileChangeFailureMarker[]>();
    for (const marker of this.fileChangeFailureMarkers.values()) {
      if (marker.threadId !== thread.id) continue;
      const turnMarkers = markersByTurnId.get(marker.turnId) ?? [];
      turnMarkers.push(marker);
      markersByTurnId.set(marker.turnId, turnMarkers);
    }
    if (!markersByTurnId.size) return message;
    let threadChanged = false;
    const turns = thread.turns.map((turn) => {
      const turnMarkers = markersByTurnId.get(turn.id);
      if (!turnMarkers?.length) return turn;
      const markerByItemId = new Map(turnMarkers.map((marker) => [marker.item.id, marker]));
      let turnChanged = false;
      const items = turn.items.map((item) => {
        const marker = markerByItemId.get(item.id);
        if (!marker || item.type !== "fileChange" || item.status !== "failed") return item;
        turnChanged = true;
        threadChanged = true;
        return withWorkbenchFileChangeFailure(item, "unclaimed");
      });
      const existingItemIds = new Set(items.map((item) => item.id));
      const missingMarkers = turnMarkers.filter((marker) => !existingItemIds.has(marker.item.id));
      if (missingMarkers.length) {
        const markersByAnchor = new Map<string | null, WorkbenchFileChangeFailureMarker[]>();
        const orphanedMarkers: WorkbenchFileChangeFailureMarker[] = [];
        for (const marker of missingMarkers) {
          if (marker.insertAfterItemId !== null && !existingItemIds.has(marker.insertAfterItemId)) {
            orphanedMarkers.push(marker);
            continue;
          }
          const anchoredMarkers = markersByAnchor.get(marker.insertAfterItemId) ?? [];
          anchoredMarkers.push(marker);
          markersByAnchor.set(marker.insertAfterItemId, anchoredMarkers);
        }
        const orderedItems: ThreadItem[] = [
          ...(markersByAnchor.get(null) ?? []).map((marker) => marker.item),
        ];
        for (const item of items) {
          orderedItems.push(item);
          orderedItems.push(...(markersByAnchor.get(item.id) ?? []).map((marker) => marker.item));
        }
        orderedItems.push(...orphanedMarkers.map((marker) => marker.item));
        items.splice(0, items.length, ...orderedItems);
        turnChanged = true;
        threadChanged = true;
      }
      return turnChanged ? { ...turn, items } : turn;
    });
    return threadChanged
      ? { ...message, result: { ...result, thread: { ...thread, turns } } } as TMessage
      : message;
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

  private async dispatchRequest(
    message: JsonRpcRequest,
    {
      client,
      clientRequestId,
      internal = false,
      signal,
    }: {
      client?: BridgeClient;
      clientRequestId?: number | string;
      internal?: boolean;
      signal?: AbortSignal;
    },
  ) {
    const upstreamRequestId = this.nextUpstreamRequestId();
    const requestSource: WorkbenchRequestSource = internal
      ? message[WORKBENCH_REQUEST_SOURCE_FIELD] === "autoRefresh"
        ? "autoRefresh"
        : message[WORKBENCH_REQUEST_SOURCE_FIELD] === "sqliteBaseline"
          ? "sqliteBaseline"
          : message[WORKBENCH_REQUEST_SOURCE_FIELD] === "sqliteRecovery"
            ? "sqliteRecovery"
            : "internal"
      : readRequestSource(message);
    const method = typeof message.method === "string" ? message.method : null;
    const threadHydration = readThreadHydration(message);
    const upstreamMessage = createUpstreamRequest(await this.instructions.augment(message, method), upstreamRequestId);

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
    const nextCommand = this.commandQueue
      .catch(() => undefined)
      .then(task);
    this.commandQueue = nextCommand.catch(() => undefined);
    return await nextCommand;
  }

  async waitForIdle() {
    while (true) {
      const currentQueue = this.commandQueue;
      await currentQueue.catch(() => undefined);
      if (this.commandQueue === currentQueue) {
        break;
      }
    }
    await this.flushCoalescedTranscriptNotifications();
    await Promise.allSettled(Array.from(this.transcriptTasks));
    await this.transcriptQueue.catch(() => undefined);
    await this.flushCoalescedTranscriptNotifications();
  }

  private createTranscriptStore({ reload = false }: { reload?: boolean } = {}) {
    const TranscriptStore = loadCodexTranscriptStore({ reload });
    return new TranscriptStore(this.storageRoot, () => (
      Array.from(this.pendingUserInputRequests.values(), (request) => request.threadId)
    ), this.transcriptShadowLog);
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
    const sqliteRecoveryBoundary = pending.requestSource === "sqliteRecovery"
      && pending.upstreamRequest.method === "thread/read"
      && !pending.threadHydration
      && asRecord(pending.upstreamRequest.params)?.includeTurns === true;
    const sqliteBaseline = pending.requestSource === "sqliteBaseline"
      && pending.upstreamRequest.method === "thread/read"
      && !pending.threadHydration
      && asRecord(pending.upstreamRequest.params)?.includeTurns === true;
    if (shouldHydrateThreadResponse(pending.upstreamRequest, pending.threadHydration)) {
      try {
        hydratedMessage = await this.ensureTranscriptStore().hydrateThreadResponse(pending.upstreamRequest, message, {
          hydration: pending.threadHydration,
          touchThread: shouldCaptureTranscript,
        });
      } catch (error) {
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
    if (shouldCaptureTranscript) {
      const capture = this.captureTranscript(`upstream-response:${pending.upstreamRequest.method ?? "unknown"}`, async () => {
        const transcriptStore = this.ensureTranscriptStore();
        const responseToRecord = pending.threadHydration ? hydratedMessage : message;
        const providerObservations = await this.createSqliteProviderResponseObservations(
          pending.upstreamRequest,
          message,
          Boolean(pending.threadHydration),
        );
        await this.transcriptRecording.recordProviderFact({
          observations: providerObservations,
          recoveryBoundary: sqliteRecoveryBoundary,
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
        });
      });
      if (sqliteRecoveryBoundary || sqliteBaseline) await capture;
      else void capture;
    }
    const presentedMessage = this.withFileChangeFailurePresentation(hydratedMessage);
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
    if (isJsonRpcServerRequest(message)) {
      void this.captureTranscript(`upstream-server-request:${message.method}`, async () => {
        const observation = createCodexTranscriptProviderDynamicToolObservation(message, Date.now());
        await this.transcriptRecording.recordProviderFact({
          observations: observation ? [observation] : [],
          recordLegacy: () => this.ensureTranscriptStore().recordUpstreamServerRequest(message),
        });
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
      let syntheticFileChangeNotification: JsonRpcNotification | null = null;
      if (message.method === "turn/started") {
        const threadId = asString(asRecord(message.params)?.threadId)?.trim();
        const turnId = asString(asRecord(message.params)?.turnId)
          ?? asString(asRecord(asRecord(message.params)?.turn)?.id);
        if (threadId) this.unmaterializedThreadIds.delete(threadId);
        if (threadId && turnId) this.transcriptActiveTurns.set(turnId, threadId);
      }
      if (message.method === "item/started" || message.method === "item/completed") {
        this.recordFileChangeTurnCursor(message.params);
      }
      if (message.method === "turn/completed") {
        const turnId = asString(asRecord(message.params)?.turnId)
          ?? asString(asRecord(asRecord(message.params)?.turn)?.id);
        if (turnId) this.transcriptActiveTurns.delete(turnId);
        this.clearFileChangeTurnCursor(message.params);
      }
      if (message.method === "serverRequest/resolved") {
        this.handleServerRequestResolved(message.params);
      }
      if (message.method === "hook/completed") {
        const marker = readWorkbenchFileChangeFailureMarker(message.params);
        if (marker && this.recordFileChangeFailure(marker)) {
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
      this.onNotification(this.withFileChangeFailurePresentation(message));
      if (syntheticFileChangeNotification) this.onNotification(syntheticFileChangeNotification);
      const coalescedNotification = getCoalescedTranscriptNotification(message);
      if (coalescedNotification) {
        await this.captureCoalescedTranscriptNotification(coalescedNotification);
        return;
      }

      void this.flushCoalescedTranscriptNotifications().then(() => (
        this.captureTranscript(`upstream-notification:${message.method}`, async () => {
          const transcriptStore = this.ensureTranscriptStore();
          const providerObservations = await this.createSqliteProviderNotificationObservations(message);
          if (syntheticFileChangeNotification) {
            providerObservations.push(
              ...await this.createSqliteProviderNotificationObservations(syntheticFileChangeNotification),
            );
          }
          await this.transcriptRecording.recordProviderFact({
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
          });
        })
      ));
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

  private async captureCoalescedTranscriptNotification({ key, notification }: CoalescedTranscriptNotification) {
    const currentNotification = this.coalescedTranscriptNotifications.get(key);
    const currentBytes = currentNotification ? estimateCoalescedTranscriptNotificationBytes(currentNotification) : 0;
    const nextNotification = currentNotification ? mergeCoalescedTranscriptNotification(currentNotification, notification) : notification;
    this.coalescedTranscriptNotifications.set(
      key,
      nextNotification,
    );
    this.coalescedTranscriptByteEstimate += estimateCoalescedTranscriptNotificationBytes(nextNotification) - currentBytes;

    if (this.coalescedTranscriptByteEstimate >= TRANSCRIPT_COALESCE_MAX_BUFFER_BYTES) {
      await this.flushCoalescedTranscriptNotifications();
      return;
    }

    if (this.coalescedTranscriptFlushTimer) {
      return;
    }
    this.coalescedTranscriptFlushTimer = setTimeout(() => {
      this.coalescedTranscriptFlushTimer = null;
      void this.flushCoalescedTranscriptNotifications().catch((error) => {
        this.transcriptShadowLog?.write({
          event: "notification-flush-failed",
          fields: { message: (error instanceof Error ? error.message : String(error)).slice(0, 500) },
          level: "error",
          source: "codex-transcript",
        });
      });
    }, TRANSCRIPT_COALESCE_FLUSH_MS);
    this.coalescedTranscriptFlushTimer.unref();
  }

  private async flushCoalescedTranscriptNotifications() {
    if (this.coalescedTranscriptFlushTimer) {
      clearTimeout(this.coalescedTranscriptFlushTimer);
      this.coalescedTranscriptFlushTimer = null;
    }

    while (true) {
      if (this.coalescedTranscriptFlushPromise) {
        await this.coalescedTranscriptFlushPromise.catch(() => undefined);
      }

      const notifications = Array.from(this.coalescedTranscriptNotifications.values());
      if (!notifications.length) {
        return;
      }

      if (this.transcriptTasks.size >= TRANSCRIPT_MAX_PENDING_TASKS) {
        this.logTranscriptInstrumentation();
        await Promise.race(Array.from(this.transcriptTasks)).catch(() => undefined);
        continue;
      }

      this.coalescedTranscriptNotifications.clear();
      this.coalescedTranscriptByteEstimate = 0;
      const flushPromise = this.captureTranscript(
        "upstream-notification:coalesced",
        () => this.ensureTranscriptStore().recordUpstreamNotifications(notifications),
      );
      this.coalescedTranscriptFlushPromise = flushPromise;
      try {
        await flushPromise;
      } finally {
        if (this.coalescedTranscriptFlushPromise === flushPromise) {
          this.coalescedTranscriptFlushPromise = null;
        }
      }
    }
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
      await this.transcriptRecording.recordWorkbenchMutation({
        observations: admittedSteer
          ? [{ kind: "steer", entry: admittedSteer, observedAt: admittedSteer.attemptedAt }]
          : [],
        recordLegacy: () => this.ensureTranscriptStore().recordClientRequest(request, admittedSteer),
      });
    }, options);
  }

  private captureTranscriptSteerFailure(request: JsonRpcRequest, errorMessage: string) {
    return this.captureTranscript("client-request-failure:turn/steer", async () => {
      const requestedSteer = createSteerHistoryEntryFromRequest(request);
      const key = requestedSteer
        ? transcriptSteerKey(requestedSteer.threadId, requestedSteer.entryKey)
        : null;
      const admittedSteer = key ? this.transcriptSteers.get(key) ?? requestedSteer : null;
      const settledSteer = admittedSteer
        ? updateSteerEntryStatus(admittedSteer, "failed", Date.now(), { error: errorMessage })
        : null;
      await this.transcriptRecording.recordCrossedWorkbenchMutation({
        observations: settledSteer
          ? [{ kind: "steer", entry: settledSteer, observedAt: settledSteer.resolvedAt! }]
          : [],
        recordLegacy: async () => {
          const transcriptStore = this.ensureTranscriptStore();
          await transcriptStore.recordClientRequestFailure(request, errorMessage);
          if (settledSteer) await transcriptStore.recordSteerSettlements([settledSteer]);
        },
      });
      if (key && settledSteer) this.transcriptSteers.delete(key);
    });
  }

  private async captureTranscript(
    label: string,
    task: () => Promise<unknown>,
    options: { propagateFailure?: boolean } = {},
  ) {
    const taskId = this.nextTranscriptTaskId;
    this.nextTranscriptTaskId += 1;
    this.transcriptPendingTasks.set(taskId, { label, startedAt: Date.now() });
    const transcriptTask = this.transcriptQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          await task();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const reportFailure = !(error instanceof CodexTranscriptSqliteRecordingFailure)
            || !this.transcriptSqliteFailureReported;
          if (error instanceof CodexTranscriptSqliteRecordingFailure) {
            this.transcriptSqliteFailureReported = true;
          }
          if (reportFailure) {
            this.transcriptShadowLog?.write({
              event: "capture-failed",
              fields: { label, message: message.slice(0, 500) },
              level: "error",
              source: "codex-transcript",
            });
          }
          if (options.propagateFailure && !(error instanceof CodexTranscriptSqliteRecordingFailure)) {
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
      // Codex misclassifies ordinary patch failures as possible sandbox denials.
      this.send({ id: request.id, result: { decision: "decline" satisfies FileChangeApprovalDecision } });
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
      data: Array.from(this.pendingUserInputRequests.values(), (pendingRequest) => ({
        itemId: pendingRequest.itemId,
        request: pendingRequest.request,
        requestKey: pendingRequest.requestKey,
        threadId: pendingRequest.threadId,
        turnId: pendingRequest.turnId,
      })),
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

  private async readThreadContext(message: JsonRpcRequest): Promise<WorkbenchThreadContextReadResponse> {
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
      const preflightDispatch = await this.dispatchRequest(preflightRequest, { internal: true });
      if (!preflightDispatch.response) throw new Error("Thread Recall preflight did not create an internal response.");
      const preflightResponse = await preflightDispatch.response;
      if (preflightResponse.error) throw new Error(preflightResponse.error.message);
      const preflightThread = asRecord(asRecord(preflightResponse.result)?.thread);
      const threadCwd = asString(preflightThread?.cwd)?.trim() ?? "";
      if (!threadCwd) throw new Error("Thread Recall preflight did not receive a readable thread CWD.");
      await this.resolveProjectFromCwd(threadCwd, { endpointName: "Thread Recall" });
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
    const dispatch = await this.dispatchRequest(readRequest, { internal: true });
    if (!dispatch.response) throw new Error("thread/context/read did not create an internal response.");
    const upstreamReadResponse = await dispatch.response;
    const transcriptStore = this.ensureTranscriptStore();
    let readResponse = isSubagentBackgroundRead || (readParams.includeTurns === false && hydration !== null)
      ? await transcriptStore.hydrateThreadResponse(readRequest, upstreamReadResponse, {
        hydration,
        touchThread: !isSubagentBackgroundRead,
      })
      : upstreamReadResponse;
    if (readParams.includeTurns === false && hydration && !readResponse.error) {
      const metadataThread = asRecord(asRecord(upstreamReadResponse.result)?.thread) as Thread | null;
      const hydratedThread = asRecord(asRecord(readResponse.result)?.thread) as Thread | null;
      if (!metadataThread?.id || !hydratedThread?.id) {
        throw new Error("Bounded thread/context/read did not receive a readable thread.");
      }
      if (await this.threadWindowLoader.ensureWindow(
        this.createThreadWindowStore(transcriptStore),
        metadataThread,
        hydratedThread,
        hydration,
        { recoveryOnly: isSubagentBackgroundRead },
      )) {
        readResponse = await transcriptStore.hydrateThreadResponse(readRequest, upstreamReadResponse, {
          hydration,
          touchThread: false,
        });
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
    if (!isSubagentBackgroundRead && hydration && thread.turns.length) {
      await this.captureTranscript("sqlite-compatibility-window", () => (
        this.importSqliteCompatibilityWindow(thread, transcriptStore)
      ));
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
      browseResultEntries = entries.browseResultEntries;
      questionnaireEntries = entries.questionnaireEntries;
      steerEntries = entries.steerEntries;
      if (turnIds) {
        entryScope = { mode: "turns", turnIds };
      }
    }

    return {
      browseResultEntries,
      ...(entryScope ? { entryScope } : {}),
      questionnaireEntries,
      steerEntries,
      thread,
    };
  }

  private async readThreadPage(message: JsonRpcRequest): Promise<WorkbenchThreadPageResponse> {
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
    });

    return {
      ...context,
      nextCursor: readWorkbenchThreadPageNextCursor(context.thread),
    };
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
        await this.transcriptRecording.recordCrossedWorkbenchMutation({
          observations: [{ kind: "browse", entry, ...(asset ? { asset } : {}) }],
          recordLegacy: () => transcriptStore.recordBrowseResultEntry(entry),
        });
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
    if (encodedThreadId !== encodeTranscriptPathSegment(threadId)) {
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
    const assetPath = path.resolve(threadsRoot, encodedThreadId, "assets", fileName);
    if (!assetPath.startsWith(`${threadsRoot}${path.sep}`)) {
      throw new Error("Browse asset URL resolves outside the transcript store.");
    }

    const bytes = await readFile(assetPath);
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
    let warning: string | null = null;
    const transcriptStore = this.ensureTranscriptStore();
    await this.captureTranscript("workbench-questionnaire-settlement", async () => {
      await this.transcriptRecording.recordCrossedWorkbenchMutation({
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
      });
    });

    this.pendingUserInputRequests.delete(pendingRequest.requestKey);
    this.onNotification({
      method: "questionnaire/resolved",
      params: {
        requestKey: pendingRequest.requestKey,
        threadId: pendingRequest.threadId,
      },
    });

    return warning ? { ok: true, warning } : { ok: true };
  }

  private createThreadWindowStore(transcriptStore: CodexTranscriptStoreInstance): CodexThreadWindowStore {
    return {
      readProviderPreviousCursor: (threadId, beforeTurnId) => (
        transcriptStore.readProviderPreviousCursor(threadId, beforeTurnId)
      ),
      recordProviderTurnCatalog: (thread, turns, boundary) => (
        transcriptStore.recordProviderTurnCatalog(thread, turns, boundary)
      ),
      recordProviderTurnPage: async (thread, turn, previousCursor) => {
        await this.captureTranscript(`provider-turn-page:${thread.id}:${turn.id}`, async () => {
          const observations = await this.createSqliteProviderTurnPageObservations(thread, turn);
          await this.transcriptRecording.recordProviderFact({
            observations,
            recordLegacy: () => transcriptStore.recordProviderTurnPage(thread, turn, previousCursor),
          });
        }, { propagateFailure: true });
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
    const threadId = asString(asRecord(startRequest.params)?.threadId)?.trim();
    if (!threadId) {
      return { id: requestId, error: { code: -32602, message: "Codex turn start requires a thread id." } };
    }
    this.assertAcceptingWork();
    const readResponse = await this.dispatchManagedProviderRequest({
      id: `workbench:admission-read:${String(requestId ?? Date.now())}`,
      method: "thread/read",
      params: { includeTurns: true, threadId },
      workbenchThreadHydration: { mode: "latest" },
    });
    if (readResponse.error) return { id: requestId, error: readResponse.error };
    const readThread = asRecord(readResponse.result)?.thread as ThreadReadResponse["thread"] | undefined;
    if (!readThread) return { id: requestId, error: { code: -32000, message: "Codex admission could not read the thread." } };
    const activeTurn = this.readManagedActiveTurn(readThread, readThread.turns);
    if (activeTurn) {
      return await this.dispatchManagedMessageSteer(requestId, threadId, activeTurn, startRequest, steerRequest);
    }
    if (
      readThread.status.type !== "idle"
      && readThread.status.type !== "notLoaded"
      && readThread.status.type !== "systemError"
    ) {
      return { id: requestId, error: { code: -32000, message: `The Codex thread is ${readThread.status.type}, not inactive.` } };
    }

    const unsubscribeResponse = await this.dispatchManagedProviderRequest({
      id: `workbench:admission-unsubscribe:${String(requestId ?? Date.now())}`,
      method: "thread/unsubscribe",
      params: { threadId },
    });
    if (unsubscribeResponse.error) return { id: requestId, error: unsubscribeResponse.error };

    const resumeResponse = await this.dispatchManagedProviderRequest({
      ...resumeRequest,
      id: `workbench:admission-resume:${String(requestId ?? Date.now())}`,
    });
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
    if (this.unmaterializedThreadIds.has(threadId)) {
      return await this.dispatchPreparedTurnStart(requestId, startRequest);
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
    await this.prepareTurnStart(
      startRequest,
      (request) => this.dispatchManagedProviderRequest(request),
    );
    const response = await this.dispatchManagedProviderRequest(startRequest);
    if (response.error) return { id: requestId, error: response.error };
    const turn = asRecord(response.result)?.turn;
    return turn && typeof turn === "object"
      ? { id: requestId, result: { kind: "started", turn } }
      : { id: requestId, error: { code: -32000, message: "Managed Codex turn start returned no turn." } };
  }

  private async dispatchManagedProviderRequest(request: JsonRpcRequest) {
    const dispatch = await this.dispatchRequest(request, { internal: true });
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
    if (!steerRequest || !clientUserMessageId || !Array.isArray(startParams?.input)) {
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

  private async createSqliteProviderTurnPageObservations(
    thread: Thread,
    turn: Turn,
  ): Promise<WorkbenchTranscriptAtomicObservation[]> {
    if (!this.sqliteTranscriptEnabled) return [];
    const context = await this.resolveTranscriptThreadContext(thread);
    return [
      createCodexTranscriptProviderThreadObservation(thread.id, context),
      createCodexTranscriptProviderTurnObservation({ context, threadId: thread.id, turn }),
      ...turn.items.map((item) => createCodexTranscriptProviderItemObservation({
        item,
        lifecycle: turn.status === "inProgress" ? "streaming" : "completed",
        observedAt: Math.round((turn.completedAt ?? turn.startedAt ?? thread.updatedAt) * 1_000),
        threadId: thread.id,
        turnId: turn.id,
      })),
    ];
  }

  private async createSqliteProviderResponseObservations(
    request: JsonRpcRequest,
    response: JsonRpcResponse,
    historicalHydration: boolean,
  ): Promise<WorkbenchTranscriptAtomicObservation[]> {
    if (
      !this.sqliteTranscriptEnabled
      || response.error
      || !["thread/fork", "thread/read", "thread/resume", "thread/start"].includes(request.method ?? "")
      || (request.method === "thread/read" && historicalHydration)
    ) {
      return [];
    }
    const thread = asRecord(response.result)?.thread as Thread | undefined;
    if (!thread?.id || !Array.isArray(thread.turns)) return [];
    const context = await this.resolveTranscriptThreadContext(thread);
    return request.method === "thread/resume"
      ? [createCodexTranscriptProviderThreadObservation(thread.id, context)]
      : createCodexTranscriptProviderThreadObservations(thread, context);
  }

  private async createSqliteProviderNotificationObservations(
    notification: JsonRpcNotification,
  ): Promise<WorkbenchTranscriptAtomicObservation[]> {
    if (!this.sqliteTranscriptEnabled) return [];
    if (notification.method === "thread/started") {
      const thread = asRecord(notification.params)?.thread as Thread | undefined;
      if (!thread?.id) return [];
      const context = await this.resolveTranscriptThreadContext(thread);
      return createCodexTranscriptProviderThreadObservations(thread, context);
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
    const context = this.transcriptThreadContexts.get(threadId);
    if (!context) {
      throw new Error(`Codex transcript thread ${threadId} has no provider context for live turn ${turn.id}`);
    }
    return [
      createCodexTranscriptProviderTurnObservation({ context, threadId, turn }),
      ...turn.items.map((item) => createCodexTranscriptProviderItemObservation({
        item,
        lifecycle: turn.status === "inProgress" ? "streaming" : "completed",
        observedAt: Math.round((turn.completedAt ?? turn.startedAt ?? Date.now() / 1_000) * 1_000),
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

  private async resolveTranscriptThreadContext(
    thread: Thread,
  ): Promise<CodexTranscriptThreadContext> {
    const resolution = await this.resolveProjectFromCwd(thread.cwd, { endpointName: "Codex transcript" });
    const context: CodexTranscriptThreadContext = {
      activityAt: Math.round((thread.recencyAt ?? thread.updatedAt) * 1_000),
      createdAt: Math.round(thread.createdAt * 1_000),
      nativeLocation: thread.cwd,
      projectId: resolution.project.id,
      projectRoot: resolution.root.rootPath,
      title: thread.name?.trim() || thread.preview.trim() || "Untitled thread",
      updatedAt: Math.round(thread.updatedAt * 1_000),
    };
    this.transcriptThreadContexts.set(thread.id, context);
    return context;
  }

  private settleTranscriptSteerResponse(
    request: JsonRpcRequest,
    response: JsonRpcResponse,
  ) {
    const requestedSteer = createSteerHistoryEntryFromRequest(request);
    if (!requestedSteer) return [];
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
    const context = await this.resolveTranscriptThreadContext(thread);
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
