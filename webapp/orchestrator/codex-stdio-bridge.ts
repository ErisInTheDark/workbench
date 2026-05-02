/*
 * Exports:
 * - CodexStdioBridge: manage the shared Codex app-server stdio child and translate websocket requests and notifications against it. Keywords: codex, stdio, websocket, bridge.
 */
import { spawn, type ChildProcess } from "node:child_process";

import type { ServerRequest } from "../lib/codex/generated/app-server/ServerRequest";
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

type PendingCodexQuestionnaire = {
  itemId: string | null;
  request: WorkbenchUserInputRequest;
  requestKey: string;
  threadId: string;
  turnId: string;
  upstreamRequestId: number | string;
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

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : null;
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
  private readonly pendingQuestionnaires = new Map<string, PendingCodexQuestionnaire>();
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
    this.pendingQuestionnaires.clear();
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
          message: error instanceof Error ? error.message : "Codex questionnaire bridge request failed.",
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
    this.pendingQuestionnaires.clear();
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
      this.pendingQuestionnaires.clear();
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
      if (message.method === "item/tool/requestUserInput") {
        this.handleUpstreamQuestionnaireRequest(message);
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
    const pendingQuestionnaire = this.pendingQuestionnaires.get(requestKey);
    if (!pendingQuestionnaire || pendingQuestionnaire.threadId !== threadId) {
      return;
    }

    this.pendingQuestionnaires.delete(requestKey);
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
    this.pendingQuestionnaires.set(requestKey, {
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

  private listPendingQuestionnaires() {
    return {
      data: Array.from(this.pendingQuestionnaires.values(), (pendingQuestionnaire) => ({
        itemId: pendingQuestionnaire.itemId,
        request: pendingQuestionnaire.request,
        requestKey: pendingQuestionnaire.requestKey,
        threadId: pendingQuestionnaire.threadId,
        turnId: pendingQuestionnaire.turnId,
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
      requestKey,
      response,
      threadId,
    };
  }

  private async respondToQuestionnaire(params: unknown) {
    const resolvedResponse = this.readQuestionnaireResponse(params);
    if (!resolvedResponse) {
      throw new Error("Missing questionnaire/respond params.");
    }

    const pendingQuestionnaire = this.pendingQuestionnaires.get(resolvedResponse.requestKey);
    if (!pendingQuestionnaire || pendingQuestionnaire.threadId !== resolvedResponse.threadId) {
      throw new Error("That questionnaire is no longer pending.");
    }

    const historyEntry: WorkbenchQuestionnaireHistoryEntry = {
      insertAfterItemId: pendingQuestionnaire.itemId,
      itemId: pendingQuestionnaire.itemId,
      request: pendingQuestionnaire.request,
      requestKey: pendingQuestionnaire.requestKey,
      resolvedAt: Date.now(),
      response: resolvedResponse.response,
      threadId: pendingQuestionnaire.threadId,
      turnId: pendingQuestionnaire.turnId,
    };

    await this.questionnaireStore.upsertThreadEntry(historyEntry);

    try {
      this.send({
        id: pendingQuestionnaire.upstreamRequestId,
        result: toToolRequestUserInputResponse(resolvedResponse.response),
      });
    } catch (error) {
      await this.questionnaireStore.removeThreadEntry(historyEntry.threadId, historyEntry.requestKey);
      throw error;
    }

    this.pendingQuestionnaires.delete(pendingQuestionnaire.requestKey);
    this.onNotification({
      method: "questionnaire/resolved",
      params: {
        requestKey: pendingQuestionnaire.requestKey,
        threadId: pendingQuestionnaire.threadId,
      },
    });

    return { ok: true };
  }
}
