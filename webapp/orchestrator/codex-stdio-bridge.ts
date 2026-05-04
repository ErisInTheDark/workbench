/*
 * Exports:
 * - CodexStdioBridge: manage the shared Codex app-server stdio child and translate websocket requests and notifications against it. Keywords: codex, stdio, websocket, bridge.
 */
import { spawn, type ChildProcess } from "node:child_process";

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
import { CodexQuestionnaireStore } from "./codex-questionnaire-store";
import {
    createSpawnOptions,
    getSpawnDescriptor,
    killProcessTree,
    log,
    logError,
    pipeChildStream,
} from "./process-helpers";

type PendingClientResponse = {
  client: BridgeClient;
  clientRequestId: number | string;
  internal: false;
  method: string | null;
};

type PendingInternalResponse = {
  internal: true;
  reject: (reason?: unknown) => void;
  resolve: (value: JsonRpcResponse) => void;
};

type PendingResponse = PendingClientResponse | PendingInternalResponse;

function isPendingInternalResponse(pending: PendingResponse): pending is PendingInternalResponse {
  return pending.internal === true;
}

type CodexStdioBridgeOptions = {
  bridgeUrl: string;
  onFatalExit: (reason: string) => void;
  onNotification: (notification: JsonRpcNotification) => void;
  projectRoot: string;
  sendToClient: (client: BridgeClient, message: unknown) => void;
  storageRoot: string;
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

export class CodexStdioBridge {
  private readonly bridgeUrl: string;
  private readonly onFatalExit: CodexStdioBridgeOptions["onFatalExit"];
  private readonly onNotification: CodexStdioBridgeOptions["onNotification"];
  private readonly projectRoot: string;
  private readonly questionnaireStore: CodexQuestionnaireStore;
  private readonly sendToClient: CodexStdioBridgeOptions["sendToClient"];
  private codexProcess: ChildProcess | null = null;
  private initializeResult: unknown = null;
  private nextRequestId = 1;
  private readonly pendingUserInputRequests = new Map<string, PendingCodexUserInputRequest>();
  private readonly pendingResponses = new Map<number, PendingResponse>();
  private upstreamInitialized = false;
  private upstreamInitializePromise: Promise<void> | null = null;

  constructor({ bridgeUrl, onFatalExit, onNotification, projectRoot, sendToClient, storageRoot }: CodexStdioBridgeOptions) {
    this.bridgeUrl = bridgeUrl;
    this.onFatalExit = onFatalExit;
    this.onNotification = onNotification;
    this.projectRoot = projectRoot;
    this.questionnaireStore = new CodexQuestionnaireStore(storageRoot);
    this.sendToClient = sendToClient;
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
    this.pendingUserInputRequests.clear();
    this.pendingResponses.clear();
    this.upstreamInitialized = false;
    this.upstreamInitializePromise = null;

    if (this.codexProcess && !this.codexProcess.killed) {
      killProcessTree(this.codexProcess.pid);
      this.codexProcess = null;
    }
  }

  async ensureInitialized(initializeMessage: JsonRpcRequest) {
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

  forwardRequest(message: JsonRpcRequest, client: BridgeClient, clientRequestId: number | string) {
    void this.request(message, { client, clientRequestId });
  }

  forwardNotification(message: JsonRpcRequest) {
    this.send(message);
  }

  async handleBridgeRequest(message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
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

  private createStdioChild() {
    const spawnDescriptor = getSpawnDescriptor({
      command: "codex",
      args: ["app-server", "--listen", "stdio://"],
    });

    return spawn(spawnDescriptor.command, spawnDescriptor.args, {
      ...createSpawnOptions(this.projectRoot, {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      }, true),
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  private ensureProcess() {
    if (this.codexProcess && !this.codexProcess.killed) {
      return this.codexProcess;
    }

    this.codexProcess = this.createStdioChild();
    this.initializeResult = null;
    this.nextRequestId = 1;
    this.pendingUserInputRequests.clear();
    this.pendingResponses.clear();
    this.upstreamInitialized = false;
    this.upstreamInitializePromise = null;
    this.bindStdout(this.codexProcess);
    pipeChildStream("codex-stdio", this.codexProcess.stderr, (chunk) => process.stderr.write(chunk));

    this.codexProcess.once("error", (error) => {
      logError("codex-stdio", `failed to start: ${error instanceof Error ? error.message : String(error)}`);
      this.onFatalExit("Codex app-server failed to start.");
    });

    this.codexProcess.once("exit", (code, signal) => {
      log("codex-stdio", `exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
      this.codexProcess = null;
      this.initializeResult = null;
      this.pendingUserInputRequests.clear();
      this.pendingResponses.clear();
      this.upstreamInitialized = false;
      this.upstreamInitializePromise = null;
      this.onFatalExit("Codex app-server exited.");
    });

    log("codex-bridge", "started shared stdio app-server");
    return this.codexProcess;
  }

  private nextUpstreamRequestId() {
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    return requestId;
  }

  private send(message: unknown) {
    this.ensureProcess();
    if (!this.codexProcess?.stdin.writable) {
      throw new Error("Codex app-server bridge is not running.");
    }

    this.codexProcess.stdin.write(`${JSON.stringify(message)}\n`);
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
    this.ensureProcess();

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
        });
      });
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
    });
    this.send(upstreamMessage);
    return null;
  }

  private bindStdout(codexProcess: ChildProcess) {
    let bufferedOutput = "";

    codexProcess.stdout?.on("data", (chunk: Buffer) => {
      bufferedOutput += chunk.toString("utf8");
      const lines = bufferedOutput.split(/\r?\n/u);
      bufferedOutput = lines.pop() ?? "";

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) {
          continue;
        }

        try {
          this.handleUpstreamMessage(JSON.parse(trimmedLine) as unknown);
        } catch (error) {
          logError("codex-bridge", `invalid upstream JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
  }

  private handleUpstreamMessage(message: unknown) {
    if (isJsonRpcResponse(message)) {
      const pending = this.pendingResponses.get(Number(message.id));
      if (!pending) {
        return;
      }

      this.pendingResponses.delete(Number(message.id));
      if (isPendingInternalResponse(pending)) {
        pending.resolve(message);
        return;
      }

      this.sendToClient(pending.client, {
        ...message,
        id: pending.clientRequestId,
      });
      return;
    }

    if (isJsonRpcServerRequest(message)) {
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
      data: await this.questionnaireStore.listThreadHistory(threadId),
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

    await this.questionnaireStore.upsertThreadEntry(historyEntry);

    try {
      this.send({
        id: pendingRequest.upstreamRequestId,
        result: toToolRequestUserInputResponse(resolvedResponse.response),
      });
    } catch (error) {
      await this.questionnaireStore.removeThreadEntry(historyEntry.threadId, historyEntry.requestKey);
      throw error;
    }

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
}
