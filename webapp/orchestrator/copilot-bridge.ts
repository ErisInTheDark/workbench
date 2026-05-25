/*
 * Exports:
 * - CopilotBridge: translate Codex-shaped bridge messages into Copilot SDK sessions and emit Codex-shaped notifications back out. Keywords: copilot sdk, codex adapter, thread bridge.
 */
import { randomUUID } from "node:crypto";

import {
    approveAll,
    CopilotClient,
    defineTool,
    type CopilotSession,
    type GetAuthStatusResponse,
    type SessionEvent,
    type SessionMetadata,
} from "@github/copilot-sdk";

import type { GetAccountRateLimitsResponse } from "../lib/codex/generated/app-server/v2/GetAccountRateLimitsResponse";
import type { RateLimitSnapshot } from "../lib/codex/generated/app-server/v2/RateLimitSnapshot";
import type { Thread } from "../lib/codex/generated/app-server/v2/Thread";
import type { UserInput } from "../lib/codex/generated/app-server/v2/UserInput";
import type {
    WorkbenchModelOption,
    WorkbenchUserInputQuestion,
    WorkbenchUserInputRequest,
    WorkbenchUserInputResponse,
} from "../lib/types";
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type { CopilotThreadState } from "./copilot-thread-state";
import { appendCopilotEventLog, log, logError } from "./process-helpers";
import type { OrchestratorReloadableModules } from "./reloadable-modules";

type CopilotAccountGetQuotaResult = Awaited<ReturnType<CopilotClient["rpc"]["account"]["getQuota"]>>;
type CopilotAccountQuotaSnapshot = NonNullable<CopilotAccountGetQuotaResult["quotaSnapshots"]>[string];

type CopilotBridgeOptions = {
  getReloadableModules: () => OrchestratorReloadableModules;
  onNotification: (notification: JsonRpcNotification) => void;
  projectRoot: string;
};

type CopilotReasoningEffort = "low" | "medium" | "high" | "xhigh";
type PendingQuestionnaireRequest = {
  request: WorkbenchUserInputRequest;
  resolve: (response: WorkbenchUserInputResponse) => void;
  reject: (reason?: unknown) => void;
  sessionId: string;
  threadId: string;
  toolCallId: string;
};

const USER_INPUT_TOOL_NAME = "workbench_request_user_input";
const USER_INPUT_TOOL_SYSTEM_MESSAGE = `
When you need the user to make a bounded choice or provide structured clarification, call the ${USER_INPUT_TOOL_NAME} tool instead of asking in plain chat.
Use short titles, optional context summaries, and one to three concise questions.
Prefer multiple-choice options when they will help the user answer quickly, but keep custom text useful too.
The tool returns the user's answers as arrays of strings keyed by question id.
`.trim();

function toCopilotReasoningEffort(value: string | null): CopilotReasoningEffort | undefined {
  switch (value) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return value;
    default:
      return undefined;
  }
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function asBoolean(value: unknown) {
  return typeof value === "boolean" ? value : false;
}

function normalizeQuestionId(value: string | null, index: number) {
  const sanitized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || `question-${index + 1}`;
}

function normalizeQuestionOptions(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => {
    const record = asRecord(entry);
    const label = truncateText(asString(record?.label) ?? "", 240);
    const description = truncateText(asString(record?.description) ?? "", 1200);
    if (!label) {
      return null;
    }

    return {
      description,
      label,
    };
  }).filter((entry): entry is WorkbenchUserInputQuestion["options"][number] => entry !== null);
}

function normalizeQuestion(
  value: unknown,
  index: number,
): WorkbenchUserInputQuestion | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const header = truncateText(asString(record.header) ?? "", 240);
  const question = truncateText(asString(record.question) ?? "", 4000);
  const options = normalizeQuestionOptions(record.options);

  if (!header && !question && !options.length) {
    return null;
  }

  return {
    allowOther: false,
    header: header || `Question ${index + 1}`,
    id: normalizeQuestionId(asString(record.id), index),
    isSecret: asBoolean(record.isSecret),
    options,
    question: question || header || `Question ${index + 1}`,
  };
}

function createFallbackQuestion(summary: string, title: string): WorkbenchUserInputQuestion {
  const questionText = truncateText(summary, 4000) || truncateText(title, 4000) || "How should I continue?";
  return {
    allowOther: false,
    header: "Question 1",
    id: "question-1",
    isSecret: false,
    options: [],
    question: questionText,
  };
}

function normalizeQuestionnaireRequest(
  args: unknown,
  sessionId: string,
  toolCallId: string,
): WorkbenchUserInputRequest {
  const record = asRecord(args) ?? {};
  const title = truncateText(asString(record.title) ?? "", 160) || "Choose how to continue";
  const summary = truncateText(asString(record.summary) ?? "", 4000)
    || "The assistant needs a bit of direction before it continues.";
  const submitLabel = truncateText(asString(record.submitLabel) ?? "", 80) || "Submit response";
  const rawQuestions = Array.isArray(record.questions) ? record.questions : [];
  const questions = rawQuestions
    .map((entry, index) => normalizeQuestion(entry, index))
    .filter((entry): entry is WorkbenchUserInputQuestion => entry !== null)
    .slice(0, 3);

  return {
    id: `copilot:${sessionId}:${toolCallId}`,
    questions: questions.length ? questions : [createFallbackQuestion(summary, title)],
    submitLabel,
    summary,
    title,
  };
}

function eventTimestampMs(value: Date | string | number | null | undefined) {
  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  if (typeof value === "number") {
    return value;
  }

  return 0;
}

function replayEventPriority(event: SessionEvent) {
  switch (event.type) {
    case "session.start":
    case "session.resume":
    case "session.model_change":
    case "session.context_changed":
      return 0;
    case "system.message":
      return 1;
    case "user.message":
      return 2;
    case "assistant.turn_start":
      return 3;
    case "assistant.reasoning_delta":
    case "assistant.reasoning":
    case "assistant.message_delta":
    case "assistant.message":
      return 4;
    case "tool.execution_start":
      return 5;
    case "tool.execution_partial_result":
    case "tool.execution_complete":
      return 6;
    case "assistant.turn_end":
    case "abort":
    case "session.idle":
    case "session.error":
    case "session.shutdown":
      return 7;
    default:
      return 8;
  }
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number) {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function userInputText(input: UserInput[]) {
  return normalizeWhitespace(input
    .filter((entry): entry is Extract<UserInput, { type: "text" }> => entry.type === "text")
    .map((entry) => entry.text)
    .join(" "));
}

function firstPendingUserMessageText(pendingUserInputs: UserInput[][]) {
  for (const input of pendingUserInputs) {
    const text = userInputText(input);
    if (text) {
      return text;
    }
  }

  return null;
}

function firstUserMessageText(thread: Thread) {
  for (const turn of thread.turns) {
    for (const item of turn.items) {
      if (item.type !== "userMessage") {
        continue;
      }

      const text = userInputText(item.content);
      if (text) {
        return text;
      }
    }
  }

  return null;
}

function firstUserMessageTextForTitle(state: { pendingUserInputs: UserInput[][]; thread: Thread }) {
  return firstUserMessageText(state.thread) ?? firstPendingUserMessageText(state.pendingUserInputs);
}

function isRawFirstUserThreadTitle(state: { pendingUserInputs: UserInput[][]; thread: Thread }, candidate: string | null) {
  if (!candidate) {
    return false;
  }

  const firstUser = firstUserMessageTextForTitle(state);
  if (!firstUser) {
    return false;
  }

  const normalizedCandidate = normalizeWhitespace(candidate).toLowerCase().replace(/\.\.\.$/u, "");
  const normalizedFirstUser = normalizeWhitespace(firstUser).toLowerCase();
  return normalizedCandidate === normalizedFirstUser
    || normalizedFirstUser.startsWith(normalizedCandidate)
    || normalizedCandidate.startsWith(normalizedFirstUser);
}

function previewForLog(value: string | null | undefined, maxLength = 120) {
  if (!value) {
    return "<empty>";
  }

  return truncateText(value, maxLength);
}

export class CopilotBridge {
  private readonly getReloadableModules: CopilotBridgeOptions["getReloadableModules"];
  private readonly onNotification: CopilotBridgeOptions["onNotification"];
  private readonly projectRoot: string;
  private client: CopilotClient | null = null;
  private cachedRateLimits: RateLimitSnapshot | null = null;
  private readonly sessionNameMisses = new Set<string>();
  private readonly sessionNames = new Map<string, string>();
  private readonly sessions = new Map<string, CopilotSession>();
  private readonly threadStates = new Map<string, CopilotThreadState>();
  private readonly unsubscribers = new Map<string, () => void>();
  private readonly pendingQuestionnaires = new Map<string, PendingQuestionnaireRequest>();

  constructor({ getReloadableModules, onNotification, projectRoot }: CopilotBridgeOptions) {
    this.getReloadableModules = getReloadableModules;
    this.onNotification = onNotification;
    this.projectRoot = projectRoot;
  }

  getInitializeResult() {
    return this.getReloadableModules().copilotThreadState.INITIALIZE_RESULT;
  }

  async stop() {
    for (const pending of this.pendingQuestionnaires.values()) {
      pending.reject(new Error("Copilot bridge stopped before the questionnaire was answered."));
    }
    this.pendingQuestionnaires.clear();
    for (const unsubscribe of this.unsubscribers.values()) {
      unsubscribe();
    }
    this.unsubscribers.clear();
    this.sessionNames.clear();
    this.sessionNameMisses.clear();
    this.sessions.clear();

    if (this.client) {
      await this.client.stop();
      this.client = null;
    }
  }

  async handleRequest(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    const requestId = message.id ?? null;
    const method = typeof message.method === "string" ? message.method : null;
    if (!method) {
      return this.errorResponse(requestId, -32600, "Invalid JSON-RPC request.");
    }
    try {
      switch (method) {
        case "thread/list":
          return {
            id: requestId,
            result: await this.listThreads(),
          };
        case "thread/read":
        case "thread/resume": {
          const agentPath = this.readAgentPath(message.params);
          const threadId = this.readThreadId(message.params);
          const effort = this.readReasoningEffort(message.params);
          const model = this.readModel(message.params);
          const projectId = this.readProjectId(message.params);
          const workbenchOrigin = this.readWorkbenchOrigin(message.params);
          if (!threadId) {
            return this.errorResponse(requestId, -32602, "Missing thread id.");
          }

          return {
            id: requestId,
            result: await this.readThread(threadId, model, effort, agentPath, workbenchOrigin, projectId),
          };
        }
        case "thread/start": {
          const thread = await this.startThread(
            this.readModel(message.params),
            this.readReasoningEffort(message.params),
            this.readAgentPath(message.params),
            this.readWorkbenchOrigin(message.params),
            this.readProjectId(message.params),
            this.readCwd(message.params),
          );
          this.onNotification({
            method: "thread/started",
            params: { thread: this.getReloadableModules().copilotThreadState.cloneThread(thread.thread) },
          });
          return {
            id: requestId,
            result: thread,
          };
        }
        case "thread/name/set": {
          const threadId = this.readThreadId(message.params);
          const name = this.readThreadName(message.params);
          if (!threadId || !name) {
            return this.errorResponse(requestId, -32602, "Missing thread/name/set params.");
          }

          return {
            id: requestId,
            result: await this.setThreadName(threadId, name),
          };
        }
        case "turn/start": {
          const agentPath = this.readAgentPath(message.params);
          const threadId = this.readThreadId(message.params);
          const effort = this.readReasoningEffort(message.params);
          const input = this.readInput(message.params);
          const model = this.readModel(message.params);
          const projectId = this.readProjectId(message.params);
          const workbenchOrigin = this.readWorkbenchOrigin(message.params);
          if (!threadId || !input.length) {
            return this.errorResponse(requestId, -32602, "Missing turn/start params.");
          }

          await this.sendToSession(threadId, input, "enqueue", model, effort, agentPath, workbenchOrigin, projectId, this.readCwd(message.params));
          return { id: requestId, result: { ok: true } };
        }
        case "turn/steer": {
          const agentPath = this.readAgentPath(message.params);
          const threadId = this.readThreadId(message.params);
          const effort = this.readReasoningEffort(message.params);
          const input = this.readInput(message.params);
          const model = this.readModel(message.params);
          const projectId = this.readProjectId(message.params);
          const workbenchOrigin = this.readWorkbenchOrigin(message.params);
          if (!threadId || !input.length) {
            return this.errorResponse(requestId, -32602, "Missing turn/steer params.");
          }

          await this.sendToSession(threadId, input, "immediate", model, effort, agentPath, workbenchOrigin, projectId, this.readCwd(message.params));
          return { id: requestId, result: { ok: true } };
        }
        case "turn/interrupt": {
          const threadId = this.readThreadId(message.params);
          const turnId = this.readTurnId(message.params);
          if (!threadId) {
            return this.errorResponse(requestId, -32602, "Missing turn/interrupt params.");
          }

          await this.abortTurn(threadId, turnId);
          return { id: requestId, result: { ok: true } };
        }
        case "model/list":
          return {
            id: requestId,
            result: await this.listModels(),
          };
        case "account/rateLimits/read":
          return {
            id: requestId,
            result: await this.readRateLimits(),
          };
        case "questionnaire/list":
          return {
            id: requestId,
            result: this.listPendingQuestionnaires(),
          };
        case "questionnaire/respond":
          return {
            id: requestId,
            result: await this.respondToQuestionnaire(message.params),
          };
        default:
          return this.errorResponse(requestId, -32601, `Unsupported Copilot bridge method: ${method}`);
      }
    } catch (error) {
      return this.errorResponse(
        requestId,
        -32000,
        error instanceof Error ? error.message : "Copilot bridge request failed.",
      );
    }
  }

  private async ensureClient() {
    if (this.client) {
      return this.client;
    }

    this.client = new CopilotClient();
    await this.client.start();
    return this.client;
  }

  private async listThreads() {
    const client = await this.ensureClient();
    const sessions = await client.listSessions();
    await this.hydrateListedThreadNames(sessions);
    const { cloneThread, metadataToThread } = this.getReloadableModules().copilotThreadState;
    return {
      data: sessions
        .map((metadata) => {
          const existingThread = this.threadStates.get(metadata.sessionId)?.thread ?? null;
          const thread = metadataToThread(metadata, existingThread ? cloneThread(existingThread) : null, this.projectRoot);
          const cachedName = this.readCachedSessionName(metadata.sessionId);
          if (cachedName) {
            thread.name = cachedName;
          }
          return thread;
        })
        .sort((left, right) => {
          if (right.updatedAt !== left.updatedAt) {
            return right.updatedAt - left.updatedAt;
          }

          return left.id.localeCompare(right.id);
        }),
    };
  }

  private selectPremiumQuota(quotaResult: CopilotAccountGetQuotaResult): CopilotAccountQuotaSnapshot | null {
    const snapshots = quotaResult.quotaSnapshots ?? {};
    if (snapshots.premium_interactions) {
      return snapshots.premium_interactions;
    }

    for (const [key, value] of Object.entries(snapshots)) {
      if (key.toLowerCase().includes("premium")) {
        return value;
      }
    }

    const firstSnapshot = Object.values(snapshots)[0];
    if (firstSnapshot) {
      return firstSnapshot;
    }

    return null;
  }

  private toRateLimitSnapshot(quota: CopilotAccountQuotaSnapshot | null): RateLimitSnapshot | null {
    if (!quota) {
      return null;
    }

    const resetsAt = quota.resetDate ? Math.floor(Date.parse(quota.resetDate) / 1000) : null;

    return {
      credits: null,
      limitId: "copilot:premium_interactions",
      limitName: "Monthly",
      planType: null,
      primary: {
        resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
        usedPercent: quota.isUnlimitedEntitlement ? 100 : 100 - quota.remainingPercentage,
        windowDurationMins: null,
      },
      rateLimitReachedType: null,
      secondary: null,
    };
  }

  private createAuthStatusRateLimits(authStatus: GetAuthStatusResponse | null): RateLimitSnapshot {
    return {
      credits: null,
      limitId: "copilot:auth",
      limitName: authStatus?.statusMessage?.trim() || "Sign in to Copilot to load premium quota",
      planType: null,
      primary: null,
      rateLimitReachedType: null,
      secondary: null,
    };
  }

  private async readRateLimits(): Promise<GetAccountRateLimitsResponse> {
    const client = await this.ensureClient();
    try {
      const quotaResult = await client.rpc.account.getQuota();
      const rateLimits = this.toRateLimitSnapshot(this.selectPremiumQuota(quotaResult));
      this.cachedRateLimits = rateLimits;
      return {
        rateLimits,
        rateLimitsByLimitId: null,
      };
    } catch (error) {
      logError("copilot-bridge", error instanceof Error ? error.message : String(error));
      if (error instanceof Error && /not authenticated/i.test(error.message)) {
        const authStatus = await client.getAuthStatus().catch(() => null);
        const rateLimits = this.createAuthStatusRateLimits(authStatus);
        this.cachedRateLimits = rateLimits;
        return {
          rateLimits,
          rateLimitsByLimitId: null,
        };
      }

      return {
        rateLimits: null,
        rateLimitsByLimitId: null,
      };
    }
  }

  private createUserInputTool(threadId: string) {
    return defineTool(USER_INPUT_TOOL_NAME, {
      description: "Pause for structured user input. Provide a short title, optional summary, and one to three questions with optional choices. Returns the user's answers as arrays of strings keyed by question id.",
      parameters: {
        additionalProperties: false,
        properties: {
          questions: {
            items: {
              additionalProperties: false,
              properties: {
                header: { type: "string" },
                id: { type: "string" },
                isSecret: { type: "boolean" },
                options: {
                  items: {
                    additionalProperties: false,
                    properties: {
                      description: { type: "string" },
                      label: { type: "string" },
                    },
                    required: ["label"],
                    type: "object",
                  },
                  type: "array",
                },
                question: { type: "string" },
              },
              required: ["id"],
              type: "object",
            },
            maxItems: 3,
            minItems: 1,
            type: "array",
          },
          submitLabel: { type: "string" },
          summary: { type: "string" },
          title: { type: "string" },
        },
        required: ["questions"],
        type: "object",
      },
      handler: async (args, invocation) => {
        const request = normalizeQuestionnaireRequest(args, invocation.sessionId, invocation.toolCallId);
        return await this.requestUserInput(threadId, invocation, request);
      },
      skipPermission: true,
    });
  }

  private createSessionTools(threadId: string) {
    return [
      this.createUserInputTool(threadId),
    ];
  }

  private async createSessionSystemMessage(threadId: string, workbenchOrigin: string | null) {
    const { buildThreadTitleBootstrapInstructions, buildThreadTitleRouteUrl } = this.getReloadableModules().threadBootstrap;
    const { buildWorkbenchLibraryBootstrapInstructions } = this.getReloadableModules().workbenchLibrary;
    const routeUrl = workbenchOrigin?.trim()
      ? buildThreadTitleRouteUrl(workbenchOrigin)
      : null;
    const workbenchLibraryInstructions = await buildWorkbenchLibraryBootstrapInstructions();
    const content = [
      USER_INPUT_TOOL_SYSTEM_MESSAGE,
      workbenchLibraryInstructions,
      routeUrl
        ? buildThreadTitleBootstrapInstructions({
          harness: "copilot",
          routeUrl,
          threadId,
        })
        : null,
    ].filter(Boolean).join("\n\n");

    return {
      content,
    };
  }

  private listPendingQuestionnaires() {
    return {
      data: Array.from(this.pendingQuestionnaires.values(), (pending) => ({
        itemId: null,
        request: pending.request,
        requestKey: pending.toolCallId,
        threadId: pending.threadId,
        turnId: null,
      })),
    };
  }

  private async requestUserInput(
    threadId: string,
    invocation: { sessionId: string; toolCallId: string },
    request: WorkbenchUserInputRequest,
  ) {
    return await new Promise<WorkbenchUserInputResponse>((resolve, reject) => {
      this.pendingQuestionnaires.set(invocation.toolCallId, {
        request,
        reject,
        resolve,
        sessionId: invocation.sessionId,
        threadId,
        toolCallId: invocation.toolCallId,
      });
      this.onNotification({
        method: "questionnaire/requested",
        params: {
          itemId: null,
          request,
          requestKey: invocation.toolCallId,
          threadId,
          turnId: null,
        },
      });
    });
  }

  private readQuestionnaireResponse(params: unknown) {
    const record = asRecord(params);
    const threadId = asString(record?.threadId);
    const toolCallId = asString(record?.requestKey) ?? asString(record?.toolCallId);
    const responseRecord = asRecord(record?.response);
    const answersRecord = asRecord(responseRecord?.answers);
    if (!threadId || !toolCallId || !answersRecord) {
      return null;
    }

    const answers = Object.fromEntries(Object.entries(answersRecord).map(([questionId, value]) => {
      const answerRecord = asRecord(value);
      const answerValues = Array.isArray(answerRecord?.answers)
        ? answerRecord.answers.filter((entry): entry is string => typeof entry === "string")
        : [];
      return [questionId, { answers: answerValues }];
    }));

    return {
      response: {
        answers,
      } satisfies WorkbenchUserInputResponse,
      threadId,
      toolCallId,
    };
  }

  private async respondToQuestionnaire(params: unknown) {
    const resolvedResponse = this.readQuestionnaireResponse(params);
    if (!resolvedResponse) {
      throw new Error("Missing questionnaire/respond params.");
    }

    const pending = this.pendingQuestionnaires.get(resolvedResponse.toolCallId);
    if (!pending || pending.threadId !== resolvedResponse.threadId) {
      throw new Error("That questionnaire is no longer pending.");
    }

    this.pendingQuestionnaires.delete(resolvedResponse.toolCallId);
    pending.resolve(resolvedResponse.response);
    this.onNotification({
      method: "questionnaire/resolved",
      params: {
        requestKey: pending.toolCallId,
        threadId: pending.threadId,
      },
    });
    return { ok: true };
  }

  private async startThread(
    model: string | null,
    reasoningEffort: string | null,
    agentPath: string | null,
    workbenchOrigin: string | null,
    projectId: string | null,
    cwd: string | null,
  ) {
    const client = await this.ensureClient();
    const sessionId = randomUUID();
    const normalizedReasoningEffort = toCopilotReasoningEffort(reasoningEffort);
    const selectedCwd = await this.resolveSelectedCwd(projectId, cwd);
    const selectedAgent = await this.resolveAgentSelection(agentPath, projectId);
    const session = await client.createSession({
      ...(selectedAgent ? { agent: selectedAgent.name, customAgents: [selectedAgent] } : {}),
      includeSubAgentStreamingEvents: true,
      ...(model ? { model } : {}),
      ...(normalizedReasoningEffort ? { reasoningEffort: normalizedReasoningEffort } : {}),
      onPermissionRequest: approveAll,
      sessionId,
      streaming: true,
      systemMessage: await this.createSessionSystemMessage(sessionId, workbenchOrigin),
      tools: this.createSessionTools(sessionId),
      workingDirectory: selectedCwd,
    });

    const { createThreadState } = this.getReloadableModules().copilotThreadState;
    const state = createThreadState(sessionId, null, selectedCwd);
    this.threadStates.set(sessionId, state);
    this.sessions.set(sessionId, session);
    this.bindSessionEvents(sessionId, session, state);
    await this.syncThreadNameFromSession(state, session, false);
    return {
      model: await this.readSessionModel(session, model),
      modelProvider: "copilot",
      reasoningEffort,
      thread: state.thread,
    };
  }

  private async listModels() {
    const client = await this.ensureClient();
    const models = await client.listModels();
    const data: WorkbenchModelOption[] = models.map((model) => ({
      id: model.id,
      displayName: model.name,
      description: "",
      hidden: false,
      isDefault: false,
      supportsPersonality: false,
      supportsReasoningEffort: Boolean(model.capabilities.supports.reasoningEffort),
      supportedReasoningEfforts: model.supportedReasoningEfforts ? [...model.supportedReasoningEfforts] : [],
      defaultReasoningEffort: model.defaultReasoningEffort ?? null,
      supportsVision: Boolean(model.capabilities.supports.vision),
      supportsFastMode: false,
      inputModalities: model.capabilities.supports.vision ? ["text", "image"] : ["text"],
      maxContextWindowTokens: model.capabilities.limits.max_context_window_tokens ?? null,
      additionalSpeedTiers: [],
      policyState: model.policy?.state ?? null,
      billingMultiplier: model.billing?.multiplier ?? null,
    }));
    return { data };
  }

  private async readThread(
    threadId: string,
    model: string | null,
    reasoningEffort: string | null,
    agentPath: string | null,
    workbenchOrigin: string | null,
    projectId: string | null,
  ) {
    const { session, state } = await this.ensureThreadState(threadId, model, reasoningEffort, agentPath, workbenchOrigin, projectId);
    const { cloneThread } = this.getReloadableModules().copilotThreadState;
    return {
      model: await this.readSessionModel(session, model),
      modelProvider: "copilot",
      reasoningEffort,
      thread: cloneThread(state.thread),
    };
  }

  private async ensureThreadState(
    threadId: string,
    model: string | null = null,
    reasoningEffort: string | null = null,
    agentPath: string | null = null,
    workbenchOrigin: string | null = null,
    projectId: string | null = null,
    cwd: string | null = null,
  ) {
    const normalizedReasoningEffort = toCopilotReasoningEffort(reasoningEffort);
    const selectedAgent = await this.resolveAgentSelection(agentPath, projectId);
    const existingState = this.threadStates.get(threadId);
    const existingSession = this.sessions.get(threadId);
    if (existingState && existingSession) {
      if (selectedAgent) {
        await existingSession.rpc.agent.select({ name: selectedAgent.name });
      }
      if (model) {
        await existingSession.setModel(model, normalizedReasoningEffort ? { reasoningEffort: normalizedReasoningEffort } : undefined);
      }
      return { session: existingSession, state: existingState };
    }

    const client = await this.ensureClient();
    const metadata = await client.getSessionMetadata(threadId);
    const { applyCopilotEvent, createThreadState, metadataToThread } = this.getReloadableModules().copilotThreadState;
    const state = existingState ?? createThreadState(threadId, metadata ?? null, this.projectRoot);
    state.metadata = metadata ?? null;
    state.thread = metadataToThread(metadata ?? null, state.thread, this.projectRoot);

    const selectedCwd = metadata?.context?.cwd ?? await this.resolveSelectedCwd(projectId, cwd);
    const session = await client.resumeSession(threadId, {
      ...(selectedAgent ? { agent: selectedAgent.name, customAgents: [selectedAgent] } : {}),
      includeSubAgentStreamingEvents: true,
      ...(model ? { model } : {}),
      ...(normalizedReasoningEffort ? { reasoningEffort: normalizedReasoningEffort } : {}),
      onPermissionRequest: approveAll,
      streaming: true,
      systemMessage: await this.createSessionSystemMessage(threadId, workbenchOrigin),
      tools: this.createSessionTools(threadId),
      workingDirectory: selectedCwd,
    });

    this.threadStates.set(threadId, state);
    this.sessions.set(threadId, session);
    this.bindSessionEvents(threadId, session, state);

    const history = (await session.getMessages())
      .map((event, index) => ({ event, index }))
      .sort((left, right) => {
        const timestampDifference = eventTimestampMs(left.event.timestamp) - eventTimestampMs(right.event.timestamp);
        if (timestampDifference !== 0) {
          return timestampDifference;
        }

        const priorityDifference = replayEventPriority(left.event) - replayEventPriority(right.event);
        if (priorityDifference !== 0) {
          return priorityDifference;
        }

        return left.index - right.index;
      })
      .map(({ event }) => event);
    state.toolCallItems.clear();
    state.currentTurnId = null;
    state.pendingUserInputs = [];
    state.thread = createThreadState(threadId, metadata ?? null, this.projectRoot).thread;
    state.thread = metadataToThread(metadata ?? null, state.thread, this.projectRoot);
    for (const event of history) {
      void appendCopilotEventLog(this.projectRoot, threadId, "history", event);
      applyCopilotEvent(state, event, false, this.onNotification);
    }
    await this.syncThreadNameFromSession(state, session, false);
    return { session, state };
  }

  private bindSessionEvents(threadId: string, session: CopilotSession, state: CopilotThreadState) {
    this.unsubscribers.get(threadId)?.();
    const unsubscribe = session.on((event: SessionEvent) => {
      void appendCopilotEventLog(this.projectRoot, threadId, "live", event);
      this.getReloadableModules().copilotThreadState.applyCopilotEvent(state, event, true, this.onNotification);
      if (event.type === "user.message" || event.type === "assistant.turn_end" || event.type === "session.idle") {
        void this.syncThreadNameFromSession(state, session, true);
      }
    });
    this.unsubscribers.set(threadId, unsubscribe);
  }

  private async sendToSession(
    threadId: string,
    input: UserInput[],
    mode: "enqueue" | "immediate",
    model: string | null,
    reasoningEffort: string | null,
    agentPath: string | null,
    workbenchOrigin: string | null,
    projectId: string | null,
    cwd: string | null,
  ) {
    const { session } = await this.ensureThreadState(threadId, model, reasoningEffort, agentPath, workbenchOrigin, projectId, cwd);

    const prompt = this.getReloadableModules().copilotThreadState.formatPromptFromInput(input);
    if (!prompt) {
      throw new Error("Message input cannot be empty.");
    }

    await session.send({ mode, prompt });
  }

  private async abortTurn(threadId: string, turnId: string | null) {
    const { session, state } = await this.ensureThreadState(threadId);
    const candidateTurn = state.currentTurnId
      ? state.thread.turns.find((entry) => entry.id === state.currentTurnId) ?? null
      : state.thread.turns.at(-1) ?? null;
    const activeTurn = candidateTurn?.status === "inProgress"
      ? candidateTurn
      : state.thread.turns.at(-1)?.status === "inProgress"
        ? state.thread.turns.at(-1) ?? null
        : null;

    if (!activeTurn || activeTurn.status !== "inProgress") {
      return;
    }

    if (turnId && activeTurn.id !== turnId) {
      throw new Error("That turn is no longer active.");
    }

    await session.abort();
  }

  private async readSessionModel(session: CopilotSession, fallback: string | null) {
    try {
      const response = await session.rpc.model.getCurrent();
      return response.modelId ?? fallback;
    } catch {
      return fallback;
    }
  }

  private async readSessionName(session: CopilotSession, fallback: string | null) {
    try {
      const response = await session.rpc.name.get();
      const name = response.name?.trim();
      return name || fallback;
    } catch {
      return fallback;
    }
  }

  private async syncThreadNameFromSession(
    state: CopilotThreadState,
    session: CopilotSession,
    emitNotifications: boolean,
  ) {
    let nextName = await this.readSessionName(session, state.thread.name);
    if (isRawFirstUserThreadTitle(state, nextName)) {
      log("copilot-bridge", `thread ${state.thread.id} rpc.name.get matched the raw first user message; ignoring it for title purposes`);
      nextName = null;
    }
    log("copilot-bridge", `thread ${state.thread.id} rpc.name.get => ${previewForLog(nextName)}`);

    if (!nextName || nextName === state.thread.name) {
      log("copilot-bridge", `thread ${state.thread.id} title unchanged => ${previewForLog(state.thread.name)}`);
      this.cacheSessionName(state.thread.id, nextName ?? null);
      return;
    }

    state.thread.name = nextName;
    this.cacheSessionName(state.thread.id, nextName);
    log("copilot-bridge", `thread ${state.thread.id} title updated => ${previewForLog(nextName)}`);
    if (emitNotifications) {
      this.onNotification({
        method: "thread/name/updated",
        params: {
          threadId: state.thread.id,
          threadName: nextName,
        },
      });
    }
  }

  private cacheSessionName(sessionId: string, name: string | null) {
    if (name) {
      this.sessionNames.set(sessionId, name);
      this.sessionNameMisses.delete(sessionId);
      return;
    }

    if (!this.sessionNames.has(sessionId)) {
      this.sessionNameMisses.add(sessionId);
    }
  }

  private readCachedSessionName(sessionId: string) {
    return this.threadStates.get(sessionId)?.thread.name
      ?? this.sessionNames.get(sessionId)
      ?? null;
  }

  private async setThreadName(threadId: string, name: string) {
    const { normalizeThreadTitle } = this.getReloadableModules().threadBootstrap;
    const normalizedTitle = normalizeThreadTitle(name);
    if (!normalizedTitle) {
      throw new Error("A non-empty thread title is required.");
    }

    const { session, state } = await this.ensureThreadState(threadId);
    await session.rpc.name.set({ name: normalizedTitle });
    state.thread.name = normalizedTitle;
    state.thread.updatedAt = Math.floor(Date.now() / 1000);
    this.cacheSessionName(threadId, normalizedTitle);
    this.onNotification({
      method: "thread/name/updated",
      params: {
        threadId,
        threadName: normalizedTitle,
      },
    });

    return {};
  }

  private async hydrateListedThreadNames(sessions: SessionMetadata[]) {
    const missingNameCandidates = [...sessions]
      .sort((left, right) => eventTimestampMs(right.modifiedTime) - eventTimestampMs(left.modifiedTime))
      .filter((metadata) => !metadata.summary
        && !this.readCachedSessionName(metadata.sessionId)
        && !this.sessionNameMisses.has(metadata.sessionId))
      .slice(0, 8);

    await Promise.all(missingNameCandidates.map(async (metadata) => {
      const name = await this.readDetachedSessionName(metadata);
      this.cacheSessionName(metadata.sessionId, name);
    }));
  }

  private async readDetachedSessionName(metadata: SessionMetadata) {
    const client = await this.ensureClient();
    const session = await client.resumeSession(metadata.sessionId, {
      disableResume: true,
      onPermissionRequest: approveAll,
      streaming: false,
      workingDirectory: metadata.context?.cwd ?? this.projectRoot,
    });

    try {
      const name = await this.readSessionName(session, null);
      log("copilot-bridge", `cold thread ${metadata.sessionId} rpc.name.get => ${previewForLog(name)}`);
      return name;
    } finally {
      await session.disconnect().catch((error) => {
        logError("copilot-bridge", `cold thread disconnect failed for ${metadata.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  private readThreadId(params: unknown) {
    const record = params && typeof params === "object" && !Array.isArray(params)
      ? params as Record<string, unknown>
      : null;
    return record && typeof record.threadId === "string" ? record.threadId : null;
  }

  private readInput(params: unknown) {
    const record = params && typeof params === "object" && !Array.isArray(params)
      ? params as Record<string, unknown>
      : null;
    return record && Array.isArray(record.input) ? record.input as UserInput[] : [];
  }

  private readTurnId(params: unknown) {
    const record = params && typeof params === "object" && !Array.isArray(params)
      ? params as Record<string, unknown>
      : null;
    return record && typeof record.turnId === "string" ? record.turnId : null;
  }

  private readModel(params: unknown) {
    const record = params && typeof params === "object" && !Array.isArray(params)
      ? params as Record<string, unknown>
      : null;
    return record && typeof record.model === "string" && record.model.trim() ? record.model : null;
  }

  private readReasoningEffort(params: unknown) {
    const record = params && typeof params === "object" && !Array.isArray(params)
      ? params as Record<string, unknown>
      : null;
    return record && typeof record.effort === "string" && record.effort.trim() ? record.effort : null;
  }

  private readAgentPath(params: unknown) {
    const record = params && typeof params === "object" && !Array.isArray(params)
      ? params as Record<string, unknown>
      : null;
    return record && typeof record.agentPath === "string" && record.agentPath.trim() ? record.agentPath : null;
  }

  private readProjectId(params: unknown) {
    const record = params && typeof params === "object" && !Array.isArray(params)
      ? params as Record<string, unknown>
      : null;
    return record && typeof record.projectId === "string" && record.projectId.trim() ? record.projectId : null;
  }

  private readCwd(params: unknown) {
    const record = params && typeof params === "object" && !Array.isArray(params)
      ? params as Record<string, unknown>
      : null;
    return record && typeof record.cwd === "string" && record.cwd.trim() ? record.cwd : null;
  }

  private readThreadName(params: unknown) {
    const record = params && typeof params === "object" && !Array.isArray(params)
      ? params as Record<string, unknown>
      : null;
    return record && typeof record.name === "string" && record.name.trim() ? record.name : null;
  }

  private readWorkbenchOrigin(params: unknown) {
    const record = params && typeof params === "object" && !Array.isArray(params)
      ? params as Record<string, unknown>
      : null;
    return record && typeof record.workbenchOrigin === "string" && record.workbenchOrigin.trim()
      ? record.workbenchOrigin
      : null;
  }

  private async resolveSelectedCwd(projectId: string | null, cwd: string | null) {
    if (!projectId) {
      return this.projectRoot;
    }

    const { isPathWithinRoot, resolveProjectRoot } = this.getReloadableModules().project;
    const resolvedProject = await resolveProjectRoot(projectId);
    if (cwd && !isPathWithinRoot(cwd, resolvedProject.root)) {
      throw new Error("Requested working directory is outside the selected project.");
    }

    return cwd || resolvedProject.root;
  }

  private async resolveAgentSelection(agentPath: string | null, projectId: string | null) {
    if (!agentPath) {
      return null;
    }

    const { readUserInvocableAgentDefinition } = this.getReloadableModules().project;
    const definition = await readUserInvocableAgentDefinition(agentPath, projectId);
    return {
      description: definition.description || undefined,
      displayName: definition.name,
      name: definition.name,
      prompt: definition.prompt,
    };
  }

  private errorResponse(id: JsonRpcResponse["id"], code: number, message: string, data?: unknown): JsonRpcResponse {
    return {
      error: {
        code,
        data,
        message,
      },
      id,
    };
  }
}
