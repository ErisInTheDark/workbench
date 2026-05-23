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
import type {
    WorkbenchQuestionnaireHistoryEntry,
    WorkbenchUserInputQuestion,
    WorkbenchUserInputRequest,
    WorkbenchUserInputResponse,
} from "../lib/types";
import type { BridgeClient, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type CodexAppServer from "./CodexAppServer";
import { log, logError } from "./process-helpers";

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
  upstreamRequest: JsonRpcRequest;
};

type PendingInternalResponse = {
  internal: true;
  reject: (reason?: unknown) => void;
  resolve: (value: JsonRpcResponse) => void;
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
const TRANSCRIPT_INSTRUMENTATION_INTERVAL_MS = 5000;
const TRANSCRIPT_INSTRUMENTATION_BACKLOG_THRESHOLD = 25;

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

  return {
    id: `codex:${params.threadId}:${requestKey}`,
    questions: questions.length ? questions : [createFallbackQuestion()],
    submitLabel: "Submit response",
    summary: "Codex needs your input before it can continue.",
    title: "Follow-up questions",
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
    details,
    prompt,
    title,
  }: {
    actionLabel: string;
    details: Array<string | null>;
    prompt: string;
    title: string;
  },
): WorkbenchUserInputRequest {
  return {
    id: `codex:${threadId}:${requestKey}`,
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
  return createApprovalRequest(params.conversationId, requestKey, {
    actionLabel: "command",
    details: [
      createApprovalDetail("Command", params.command.join(" ")),
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
  private transcriptStore: CodexTranscriptStoreInstance;
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
  private nextTranscriptTaskId = 1;
  private transcriptCompletedCount = 0;
  private transcriptEnqueuedCount = 0;
  private transcriptFailedCount = 0;
  private transcriptLastLabel = "";
  private transcriptLastLogAt = 0;
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
    this.transcriptStore = this.createTranscriptStore();
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
    clearInterval(this.transcriptInstrumentationTimer);
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
    this.acceptingWork = false;
  }

  async dispose() {
    this.stop();
    await this.transcriptStore.dispose();
  }

  async detachForReload(): Promise<CodexStdioBridgeReloadState> {
    await this.waitForIdle();
    this.acceptingWork = false;
    clearInterval(this.transcriptInstrumentationTimer);
    await this.transcriptStore.dispose();
    return {
      initializeResult: this.initializeResult,
      pendingResponses: this.pendingResponses,
      pendingUserInputRequests: this.pendingUserInputRequests,
      requestIdAllocator: this.requestIdAllocator,
      upstreamInitialized: this.upstreamInitialized,
    };
  }

  async reloadTranscriptStore() {
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
      this.request(message, { client, clientRequestId });
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
    this.appServer.send(message);
  }

  private request(
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
    const upstreamMessage = {
      ...message,
      id: upstreamRequestId,
    };

    if (internal) {
      const responsePromise = new Promise<JsonRpcResponse>((resolve, reject) => {
        this.pendingResponses.set(upstreamRequestId, {
          internal: true,
          reject,
          resolve,
          upstreamRequest: upstreamMessage,
        });
      });
      void this.captureTranscript("client-request", () => this.transcriptStore.recordClientRequest(upstreamMessage));
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
      method: typeof message.method === "string" ? message.method : null,
      upstreamRequest: upstreamMessage,
    });
    void this.captureTranscript("client-request", () => this.transcriptStore.recordClientRequest(upstreamMessage));
    this.send(upstreamMessage);
    return null;
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
    await Promise.allSettled(Array.from(this.transcriptTasks));
    await this.transcriptQueue.catch(() => undefined);
  }

  private createTranscriptStore({ reload = false }: { reload?: boolean } = {}) {
    const TranscriptStore = loadCodexTranscriptStore({ reload });
    return new TranscriptStore(this.storageRoot, () => (
      Array.from(this.pendingUserInputRequests.values(), (request) => request.threadId)
    ));
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
    try {
      hydratedMessage = await this.transcriptStore.hydrateThreadResponse(pending.upstreamRequest, message);
    } catch (error) {
      logError("codex-transcript", `failed to hydrate thread response: ${error instanceof Error ? error.message : String(error)}`);
    }
    void this.captureTranscript(`upstream-response:${pending.upstreamRequest.method ?? "unknown"}`, async () => {
      await this.transcriptStore.recordUpstreamResponse(pending.upstreamRequest, message);
      if (shouldRecordHydratedThreadSnapshot(pending.upstreamRequest, message, hydratedMessage)) {
        await this.transcriptStore.recordHydratedThreadSnapshot(hydratedMessage);
      }
    });
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
      void this.captureTranscript(`upstream-server-request:${message.method}`, () => this.transcriptStore.recordUpstreamServerRequest(message));
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
      void this.captureTranscript(`upstream-notification:${message.method}`, () => this.transcriptStore.recordUpstreamNotification(message));
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
      || this.transcriptEnqueuedCount !== this.transcriptCompletedCount;
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
      `oldestPendingMs=${oldestPendingAgeMs}`,
      `last=${this.transcriptLastLabel || "none"}`,
      `top=[${topLabels}]`,
    ].join(" "));
  }

  private async captureTranscript(label: string, task: () => Promise<unknown>) {
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
      data: await this.transcriptStore.listQuestionnaireHistory(threadId),
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
    await this.transcriptStore.recordQuestionnaireResolved(historyEntry).catch((error) => {
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
