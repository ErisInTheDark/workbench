/*
 * Exports:
 * - CodexStdioBridge: translate websocket requests and Codex app-server messages around a stable app-server process. Keywords: codex, stdio, websocket, bridge.
 */
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
import type { ToolRequestUserInputParams } from "../lib/codex/generated/app-server/v2/ToolRequestUserInputParams";
import type { ToolRequestUserInputQuestion } from "../lib/codex/generated/app-server/v2/ToolRequestUserInputQuestion";
import type { ToolRequestUserInputResponse } from "../lib/codex/generated/app-server/v2/ToolRequestUserInputResponse";
import type { Thread } from "../lib/codex/generated/app-server/v2/Thread";
import type {
    WorkbenchApprovalCommandContext,
    WorkbenchBrowseScreenshotEntry,
    WorkbenchCollaborationState,
    WorkbenchQuestionnaireHistoryEntry,
    WorkbenchThreadContextReadResponse,
    WorkbenchThreadHydrationRequest,
    WorkbenchUserInputQuestion,
    WorkbenchUserInputRequest,
    WorkbenchUserInputResponse,
} from "../lib/types";
import { normalizeWorkbenchCollaborationState } from "../lib/workbench/collaboration/collaboration-state";
import {
  buildWorkbenchCollaborationDeveloperInstructions,
  buildWorkbenchPromptInstructions,
  type WorkbenchPromptInstructions,
} from "../lib/workbench/instructions/WorkbenchPromptFiles";
import { isWorkbenchPauseControlRequest, WORKBENCH_PAUSE_CONTROL_KIND } from "../lib/workbench/thread/thread-pause-control";
import type { BridgeClient, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type CodexAppServer from "./CodexAppServer";
import { log, logError } from "./process-helpers";
import { readWorkbenchPromptContext, WORKBENCH_PROMPT_CONTEXT_FIELD } from "./workbench-prompt-context";

type CodexTranscriptStoreInstance = import("./CodexTranscriptStore").default;
type CodexTranscriptStoreConstructor = new (
  projectRoot: string,
  getProtectedThreadIds?: () => Iterable<string>,
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
  reject: (reason?: unknown) => void;
  resolve: (value: JsonRpcResponse) => void;
  threadHydration: WorkbenchThreadHydrationRequest | null;
  upstreamRequest: JsonRpcRequest;
};

type PendingResponse = PendingClientResponse | PendingInternalResponse;

function isPendingInternalResponse(pending: PendingResponse): pending is PendingInternalResponse {
  return pending.internal === true;
}

type CodexStdioBridgeOptions = {
  appServer: CodexAppServer;
  bridgeUrl: string;
  initialState?: CodexStdioBridgeReloadState;
  onNotification: (notification: JsonRpcNotification) => void;
  sendToClient: (client: BridgeClient, message: unknown) => void;
  storageRoot: string;
};

type RequestIdAllocator = {
  next: number;
};

export type CodexStdioBridgeReloadState = {
  initializeResult: unknown;
  pendingResponses: Map<number, PendingResponse>;
  pendingUserInputRequests: Map<string, PendingCodexUserInputRequest>;
  requestIdAllocator: RequestIdAllocator;
  upstreamInitialized: boolean;
};

type CodexStdioBridgeReloadOptions = {
  idleTimeoutMs?: number;
};

type PendingCodexUserInputRequestBase = {
  controlKind?: "pause" | null;
  hidden?: boolean;
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
const TRANSCRIPT_INSTRUMENTATION_INTERVAL_MS = 5000;
const TRANSCRIPT_INSTRUMENTATION_BACKLOG_THRESHOLD = 25;
const TRANSCRIPT_MAX_PENDING_TASKS = 200;
const TRANSCRIPT_COALESCE_FLUSH_MS = 100;
const TRANSCRIPT_COALESCE_MAX_BUFFER_BYTES = 512 * 1024;
const WORKBENCH_REQUEST_SOURCE_FIELD = "workbenchRequestSource";
const WORKBENCH_THREAD_HYDRATION_FIELD = "workbenchThreadHydration";
const WORKBENCH_NOTIFICATION_BROADCAST_METHOD = "workbench/notification/broadcast";

type WorkbenchRequestSource = "autoRefresh" | "internal" | "user";

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

function readCollaborationStateUpdatedNotification(value: unknown): JsonRpcNotification {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("A Collaboration state notification object is required.");
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.method !== "collaboration/state/updated") {
    throw new Error("Unsupported Workbench notification method.");
  }

  const params = candidate.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("A Collaboration state notification params object is required.");
  }

  const candidateParams = params as Record<string, unknown>;
  const projectId = typeof candidateParams.projectId === "string" ? candidateParams.projectId.trim() : "";
  if (!projectId) {
    throw new Error("A Collaboration state notification project id is required.");
  }

  const state: WorkbenchCollaborationState = normalizeWorkbenchCollaborationState(candidateParams.state);
  return {
    method: "collaboration/state/updated",
    params: {
      projectId,
      state,
    },
  };
}

function readWorkbenchNotificationBroadcastParams(value: unknown): JsonRpcNotification {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Workbench notification broadcast params are required.");
  }

  const candidate = value as Record<string, unknown>;
  return readCollaborationStateUpdatedNotification(candidate.notification);
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

function formatBytes(value: number) {
  return `${Math.round(value / 1024 / 1024)}MB`;
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

function isPromptAugmentedThreadMethod(method: string | null) {
  return method === "thread/start" || method === "thread/resume" || method === "thread/fork";
}

function isPromptAugmentedTurnMethod(method: string | null) {
  return method === "turn/start";
}

function asMutableParamsRecord(params: unknown) {
  return params && typeof params === "object" && !Array.isArray(params)
    ? params as Record<string, unknown>
    : {};
}

function buildWorkbenchOwnedPromptParams(
  params: Record<string, unknown>,
  promptInstructions: WorkbenchPromptInstructions,
) {
  const existingConfig = asRecord(params.config);
  return {
    ...params,
    baseInstructions: promptInstructions.baseInstructions,
    developerInstructions: promptInstructions.developerInstructions,
    config: {
      ...existingConfig,
      instructions: "",
      developer_instructions: "",
    },
    personality: "none",
  };
}

function buildWorkbenchOwnedCollaborationParams(
  params: Record<string, unknown>,
  developerInstructions: string | null,
) {
  const collaborationMode = asRecord(params.collaborationMode);
  if (!collaborationMode) {
    return params;
  }

  const settings = asRecord(collaborationMode.settings) ?? {};
  return {
    ...params,
    collaborationMode: {
      ...collaborationMode,
      settings: {
        ...settings,
        developer_instructions: developerInstructions,
      },
    },
  };
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
      return false;
    default:
      return true;
  }
}

function shouldHydrateThreadResponse(method: string | null) {
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
      return "denied";
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
  private readonly onNotification: CodexStdioBridgeOptions["onNotification"];
  private readonly sendToClient: CodexStdioBridgeOptions["sendToClient"];
  private readonly storageRoot: string;
  private transcriptStore: CodexTranscriptStoreInstance | null = null;
  private transcriptStoreReloadPending = false;
  private initializeResult: unknown;
  private acceptingWork = true;
  private operationQueue: Promise<unknown> = Promise.resolve();
  private readonly pendingUserInputRequests: Map<string, PendingCodexUserInputRequest>;
  private readonly pendingResponses: Map<number, PendingResponse>;
  private readonly requestIdAllocator: RequestIdAllocator;
  private transcriptQueue: Promise<void> = Promise.resolve();
  private readonly transcriptTasks = new Set<Promise<void>>();
  private readonly transcriptPendingTaskStartedAt = new Map<number, number>();
  private readonly transcriptLabelCounts = new Map<string, number>();
  private readonly transcriptInstrumentationTimer: NodeJS.Timeout;
  private readonly coalescedTranscriptNotifications = new Map<string, JsonRpcNotification>();
  private coalescedTranscriptFlushTimer: NodeJS.Timeout | null = null;
  private coalescedTranscriptFlushPromise: Promise<void> | null = null;
  private coalescedTranscriptByteEstimate = 0;
  private transcriptBackpressureCount = 0;
  private transcriptAutoRefreshSkippedCount = 0;
  private nextTranscriptTaskId = 1;
  private transcriptCompletedCount = 0;
  private transcriptEnqueuedCount = 0;
  private transcriptFailedCount = 0;
  private transcriptLastLoggedAutoRefreshSkippedCount = 0;
  private transcriptLastLabel = "";
  private transcriptLastLogAt = 0;
  private transcriptLastSkipLabel = "";
  private upstreamInitialized: boolean;
  private upstreamInitializePromise: Promise<void> | null = null;

  constructor({ appServer, bridgeUrl, initialState, onNotification, sendToClient, storageRoot }: CodexStdioBridgeOptions) {
    this.appServer = appServer;
    this.bridgeUrl = bridgeUrl;
    this.onNotification = onNotification;
    this.sendToClient = sendToClient;
    this.storageRoot = storageRoot;
    this.initializeResult = initialState?.initializeResult ?? null;
    this.pendingResponses = initialState?.pendingResponses ?? new Map();
    this.pendingUserInputRequests = initialState?.pendingUserInputRequests ?? new Map();
    this.requestIdAllocator = initialState?.requestIdAllocator ?? { next: 1 };
    this.upstreamInitialized = initialState?.upstreamInitialized ?? false;
    this.transcriptInstrumentationTimer = setInterval(() => {
      this.logTranscriptInstrumentation("interval");
    }, TRANSCRIPT_INSTRUMENTATION_INTERVAL_MS);
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
    this.pendingUserInputRequests.clear();
    for (const pending of this.pendingResponses.values()) {
      if (isPendingInternalResponse(pending)) {
        pending.reject(new Error("Codex bridge stopped before the upstream response arrived."));
      }
    }
    this.pendingResponses.clear();
    this.upstreamInitialized = false;
    if (this.upstreamInitializePromise) {
      this.upstreamInitializePromise.catch(() => undefined);
    }
    this.upstreamInitializePromise = null;
  }

  beginStopping() {
    this.acceptingWork = false;
  }

  async dispose() {
    await this.stopAfterFlushingTranscripts();
    if (this.transcriptStore) {
      await this.transcriptStore.dispose();
      this.transcriptStore = null;
    }
  }

  async stopAfterFlushingTranscripts() {
    await this.waitForIdle();
    this.stop();
  }

  async detachForReload(options: CodexStdioBridgeReloadOptions = {}): Promise<CodexStdioBridgeReloadState> {
    await withTimeout(
      this.waitForIdle(),
      options.idleTimeoutMs,
      "Codex bridge is busy with active work; retry reload after the current bridge work settles.",
    );
    this.acceptingWork = false;
    clearInterval(this.transcriptInstrumentationTimer);
    if (this.transcriptStore) {
      await this.transcriptStore.dispose();
      this.transcriptStore = null;
    }
    return {
      initializeResult: this.initializeResult,
      pendingResponses: this.pendingResponses,
      pendingUserInputRequests: this.pendingUserInputRequests,
      requestIdAllocator: this.requestIdAllocator,
      upstreamInitialized: this.upstreamInitialized,
    };
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
      const response = await this.request(initializeMessage, { internal: true });
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
    await this.enqueueOperation(() => {
      this.assertAcceptingWork();
      return this.request(message, { client, clientRequestId });
    });
  }

  async forwardNotification(message: JsonRpcRequest) {
    await this.enqueueOperation(() => {
      this.assertAcceptingWork();
      this.send(message);
    });
  }

  async handleBridgeRequest(message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    return await this.enqueueOperation(() => this.handleBridgeRequestImmediately(message));
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
        case "browse/screenshot/list":
          return {
            id: requestId,
            result: await this.listBrowseScreenshotEntries(message.params),
          };
        case "thread/context/read":
          return {
            id: requestId,
            result: await this.readThreadContext(message),
          };
        case "browse/screenshot/record":
          return {
            id: requestId,
            result: await this.recordBrowseScreenshotEntry(message.params),
          };
        case "questionnaire/respond":
          return {
            id: requestId,
            result: await this.respondToQuestionnaire(message.params),
          };
        case WORKBENCH_NOTIFICATION_BROADCAST_METHOD:
          return {
            id: requestId,
            result: this.broadcastWorkbenchNotification(message.params),
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

  private broadcastWorkbenchNotification(params: unknown) {
    const notification = readWorkbenchNotificationBroadcastParams(params);
    this.onNotification(notification);
    return { ok: true };
  }

  private send(message: unknown) {
    this.appServer.send(message);
  }

  private async request(
    message: JsonRpcRequest,
    {
      client,
      clientRequestId,
      internal = false,
    }: {
      client?: BridgeClient;
      clientRequestId?: number | string;
      internal?: boolean;
    },
  ) {
    const upstreamRequestId = this.nextUpstreamRequestId();
    const requestSource: WorkbenchRequestSource = internal ? "internal" : readRequestSource(message);
    const method = typeof message.method === "string" ? message.method : null;
    const threadHydration = readThreadHydration(message);
    const upstreamMessage = createUpstreamRequest(
      await this.withWorkbenchPromptInstructions(message, method),
      upstreamRequestId,
    );

    if (internal) {
      const responsePromise = new Promise<JsonRpcResponse>((resolve, reject) => {
        this.pendingResponses.set(upstreamRequestId, {
          internal: true,
          reject,
          resolve,
          threadHydration,
          upstreamRequest: upstreamMessage,
        });
      });
      void this.captureTranscript("client-request", () => this.ensureTranscriptStore().recordClientRequest(upstreamMessage));
      this.send(upstreamMessage);
      return responsePromise;
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
      void this.captureTranscript("client-request", () => this.ensureTranscriptStore().recordClientRequest(upstreamMessage));
    } else {
      this.recordSkippedAutoRefreshTranscript(`client-request:${method ?? "unknown"}`);
    }
    this.send(upstreamMessage);
    return null;
  }

  private async withWorkbenchPromptInstructions(message: JsonRpcRequest, method: string | null): Promise<JsonRpcRequest> {
    if (!isPromptAugmentedThreadMethod(method) && !isPromptAugmentedTurnMethod(method)) {
      return message;
    }

    const promptContext = readWorkbenchPromptContext(message);
    if (!promptContext) {
      return message;
    }

    const params = asMutableParamsRecord(message.params);
    if (isPromptAugmentedTurnMethod(method)) {
      const developerInstructions = await buildWorkbenchCollaborationDeveloperInstructions(promptContext);
      return {
        ...message,
        params: buildWorkbenchOwnedCollaborationParams(params, developerInstructions),
      };
    }

    const promptInstructions = await buildWorkbenchPromptInstructions(promptContext);
    return {
      ...message,
      params: buildWorkbenchOwnedPromptParams(params, promptInstructions),
    };
  }

  private async enqueueOperation<TValue>(task: () => TValue | Promise<TValue>) {
    const nextOperation = this.operationQueue
      .catch(() => undefined)
      .then(task);
    this.operationQueue = nextOperation.catch(() => undefined);
    return await nextOperation;
  }

  async waitForIdle() {
    while (true) {
      const currentQueue = this.operationQueue;
      await currentQueue.catch(() => undefined);
      if (this.operationQueue === currentQueue) {
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
    ));
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

    await this.enqueueOperation(() => this.handleUpstreamNonResponseMessage(message));
  }

  private async handleUpstreamResponse(message: JsonRpcResponse) {
    const pending = this.pendingResponses.get(Number(message.id));
    if (!pending) {
      return;
    }

    this.pendingResponses.delete(Number(message.id));
    let hydratedMessage = message;
    const shouldCaptureTranscript = isPendingInternalResponse(pending)
      || shouldCapturePollingTranscript(pending.method, pending.requestSource);
    if (shouldCaptureTranscript || shouldHydrateThreadResponse(pending.method)) {
      try {
        hydratedMessage = await this.ensureTranscriptStore().hydrateThreadResponse(pending.upstreamRequest, message, {
          hydration: pending.threadHydration,
          touchThread: shouldCaptureTranscript,
        });
      } catch (error) {
        logError("codex-transcript", `failed to hydrate thread response: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (shouldCaptureTranscript) {
      void this.captureTranscript(`upstream-response:${pending.upstreamRequest.method ?? "unknown"}`, async () => {
        const transcriptStore = this.ensureTranscriptStore();
        const responseToRecord = pending.threadHydration ? hydratedMessage : message;
        await transcriptStore.recordUpstreamResponse(pending.upstreamRequest, responseToRecord);
        if (responseToRecord !== hydratedMessage && shouldRecordHydratedThreadSnapshot(pending.upstreamRequest, message, hydratedMessage)) {
          await transcriptStore.recordHydratedThreadSnapshot(hydratedMessage);
        }
      });
    } else {
      this.recordSkippedAutoRefreshTranscript(`upstream-response:${pending.method ?? "unknown"}`);
    }
    if (isPendingInternalResponse(pending)) {
      pending.resolve(hydratedMessage);
      return;
    }

    this.sendToClient(pending.client, {
      ...hydratedMessage,
      id: pending.clientRequestId,
    });
  }

  private async handleUpstreamNonResponseMessage(message: unknown) {
    if (isJsonRpcServerRequest(message)) {
      void this.captureTranscript(`upstream-server-request:${message.method}`, () => this.ensureTranscriptStore().recordUpstreamServerRequest(message));
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
      if (message.method === "serverRequest/resolved") {
        this.handleServerRequestResolved(message.params);
      }
      this.onNotification(message);
      const coalescedNotification = getCoalescedTranscriptNotification(message);
      if (coalescedNotification) {
        await this.captureCoalescedTranscriptNotification(coalescedNotification);
        return;
      }

      void this.flushCoalescedTranscriptNotifications().then(() => (
        this.captureTranscript(`upstream-notification:${message.method}`, () => this.ensureTranscriptStore().recordUpstreamNotification(message))
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

  private logTranscriptInstrumentation(reason: "backlog" | "interval") {
    const pendingCount = this.transcriptTasks.size;
    const shouldLog = pendingCount > 0
      || reason === "backlog"
      || this.transcriptEnqueuedCount !== this.transcriptCompletedCount
      || this.transcriptAutoRefreshSkippedCount !== this.transcriptLastLoggedAutoRefreshSkippedCount;
    if (!shouldLog) {
      return;
    }

    const timestamp = Date.now();
    if (reason === "backlog" && timestamp - this.transcriptLastLogAt < TRANSCRIPT_INSTRUMENTATION_INTERVAL_MS) {
      return;
    }

    this.transcriptLastLogAt = timestamp;
    const memory = process.memoryUsage();
    let oldestPendingAgeMs = 0;
    for (const startedAt of this.transcriptPendingTaskStartedAt.values()) {
      oldestPendingAgeMs = Math.max(oldestPendingAgeMs, timestamp - startedAt);
    }

    const topLabels = Array.from(this.transcriptLabelCounts.entries())
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([label, count]) => `${label}=${count}`)
      .join(", ");

    log("codex-transcript-memory", [
      `reason=${reason}`,
      `rss=${formatBytes(memory.rss)}`,
      `heapUsed=${formatBytes(memory.heapUsed)}`,
      `heapTotal=${formatBytes(memory.heapTotal)}`,
      `external=${formatBytes(memory.external)}`,
      `pending=${pendingCount}`,
      `enqueued=${this.transcriptEnqueuedCount}`,
      `completed=${this.transcriptCompletedCount}`,
      `failed=${this.transcriptFailedCount}`,
      `autoRefreshSkipped=${this.transcriptAutoRefreshSkippedCount}`,
      `backpressure=${this.transcriptBackpressureCount}`,
      `oldestPendingMs=${oldestPendingAgeMs}`,
      `last=${this.transcriptLastLabel || "none"}`,
      `lastSkipped=${this.transcriptLastSkipLabel || "none"}`,
      `top=[${topLabels}]`,
    ].join(" "));
    this.transcriptLastLoggedAutoRefreshSkippedCount = this.transcriptAutoRefreshSkippedCount;
  }

  private recordSkippedAutoRefreshTranscript(label: string) {
    this.transcriptAutoRefreshSkippedCount += 1;
    this.transcriptLastSkipLabel = label;
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
        logError("codex-transcript", error instanceof Error ? error.message : String(error));
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
        this.transcriptBackpressureCount += 1;
        this.transcriptLastLabel = "upstream-notification:coalesced";
        this.logTranscriptInstrumentation("backlog");
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

  private async captureTranscript(
    label: string,
    task: () => Promise<unknown>,
  ) {
    const taskId = this.nextTranscriptTaskId;
    this.nextTranscriptTaskId += 1;
    this.transcriptEnqueuedCount += 1;
    this.transcriptLastLabel = label;
    this.transcriptPendingTaskStartedAt.set(taskId, Date.now());
    this.transcriptLabelCounts.set(label, (this.transcriptLabelCounts.get(label) ?? 0) + 1);
    const transcriptTask = this.transcriptQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          await task();
        } catch (error) {
          this.transcriptFailedCount += 1;
          logError("codex-transcript", error instanceof Error ? error.message : String(error));
        }
      });
    this.transcriptQueue = transcriptTask.catch(() => undefined);
    this.transcriptTasks.add(transcriptTask);
    if (this.transcriptTasks.size >= TRANSCRIPT_INSTRUMENTATION_BACKLOG_THRESHOLD) {
      this.logTranscriptInstrumentation("backlog");
    }
    try {
      await transcriptTask;
    } finally {
      this.transcriptCompletedCount += 1;
      this.transcriptTasks.delete(transcriptTask);
      this.transcriptPendingTaskStartedAt.delete(taskId);
    }
  }

  private handleUpstreamQuestionnaireRequest(
    request: Extract<ServerRequest, { method: "item/tool/requestUserInput" }>,
  ) {
    const requestKey = String(request.id);
    const normalizedRequest = normalizeQuestionnaireRequest(request.params, requestKey);
    const isPauseControl = isWorkbenchPauseControlRequest(normalizedRequest);
    this.pendingUserInputRequests.set(requestKey, {
      controlKind: isPauseControl ? WORKBENCH_PAUSE_CONTROL_KIND : null,
      hidden: isPauseControl || undefined,
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
        controlKind: isPauseControl ? WORKBENCH_PAUSE_CONTROL_KIND : null,
        hidden: isPauseControl || undefined,
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
        controlKind: pendingRequest.controlKind ?? null,
        hidden: pendingRequest.hidden || undefined,
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

  private async listBrowseScreenshotEntries(params: unknown) {
    const record = asRecord(params);
    const threadId = asString(record?.threadId)?.trim() ?? "";
    if (!threadId) {
      throw new Error("Missing browse/screenshot/list thread id.");
    }

    return {
      data: await this.ensureTranscriptStore().listBrowseScreenshotEntries(threadId),
    };
  }

  private async readThreadContext(message: JsonRpcRequest): Promise<WorkbenchThreadContextReadResponse> {
    const record = asRecord(message.params);
    const threadId = asString(record?.threadId)?.trim() ?? "";
    if (!threadId) {
      throw new Error("Missing thread/context/read thread id.");
    }

    const hydration = readThreadHydration(message);
    const readParams = {
      ...(record ?? {}),
      includeTurns: record?.includeTurns ?? true,
      threadId,
    };
    const readRequest: JsonRpcRequest = {
      method: "thread/read",
      params: readParams,
      ...(hydration ? { [WORKBENCH_THREAD_HYDRATION_FIELD]: hydration } : {}),
    };
    const readResponse = await this.request(readRequest, { internal: true });
    if (readResponse.error) {
      throw new Error(readResponse.error.message);
    }

    const result = asRecord(readResponse.result);
    const thread = asRecord(result?.thread) as Thread | null;
    if (!thread?.id) {
      throw new Error("thread/context/read did not receive a readable thread.");
    }

    const transcriptStore = this.ensureTranscriptStore();
    const [browseScreenshotEntries, questionnaireEntries, steerEntries] = await Promise.all([
      transcriptStore.listBrowseScreenshotEntries(thread.id),
      transcriptStore.listQuestionnaireHistory(thread.id),
      transcriptStore.listSteerHistory(thread.id),
    ]);

    return {
      browseScreenshotEntries,
      questionnaireEntries,
      steerEntries,
      thread,
    };
  }

  private async recordBrowseScreenshotEntry(params: unknown) {
    const record = asRecord(params);
    const action = asString(record?.action);
    const actionIndex = asNumber(record?.actionIndex);
    const assetUrl = asString(record?.assetUrl);
    const entryKey = asString(record?.entryKey);
    const recordedAt = asNumber(record?.recordedAt);
    const session = asString(record?.session);
    const threadId = asString(record?.threadId);
    const turnId = asString(record?.turnId);
    if (
      !action
      || actionIndex === null
      || !assetUrl
      || !entryKey
      || recordedAt === null
      || !session
      || !threadId
      || !turnId
    ) {
      throw new Error("Missing browse/screenshot/record params.");
    }

    const entry: WorkbenchBrowseScreenshotEntry = {
      action: action as WorkbenchBrowseScreenshotEntry["action"],
      actionIndex,
      assetUrl,
      commandItemId: asString(record?.commandItemId) ?? null,
      entryKey,
      recordedAt,
      session,
      threadId,
      turnId,
    };
    await this.ensureTranscriptStore().recordBrowseScreenshotEntry(entry);
    this.onNotification({
      method: "browse/screenshot/recorded",
      params: {
        threadId,
        turnId,
      },
    });
    return { ok: true };
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
      controlKind: pendingRequest.controlKind ?? null,
      hidden: pendingRequest.hidden || undefined,
      threadId: pendingRequest.threadId,
      turnId: resolvedResponse.turnId ?? pendingRequest.turnId ?? "",
    };

    this.send({
      id: pendingRequest.upstreamRequestId,
      result: toToolRequestUserInputResponse(resolvedResponse.response),
    });
    let warning: string | null = null;
    await this.ensureTranscriptStore().recordQuestionnaireResolved(historyEntry).catch((error) => {
      warning = "Your response was sent, but Workbench could not save it to local transcript history.";
      logError("codex-transcript", `failed to persist questionnaire response: ${error instanceof Error ? error.message : String(error)}`);
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
}
