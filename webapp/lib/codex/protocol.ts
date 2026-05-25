/*
 * Exports:
 * - CodexClientRequest/CodexClientNotification: generated client-to-server app-server messages. Keywords: codex, json-rpc, request.
 * - CodexServerEvent/CodexRolloutEvent: generated rollout event messages persisted inside thread history. Keywords: codex, EventMsg, raw events.
 * - CodexJsonRpcResponse helpers: typed JSON-RPC success/failure checks. Keywords: json-rpc, response, error.
 * - createCodexClientInfo/createInitializeCapabilities/createInitializeParams: initialize payload builders. Keywords: app-server, handshake.
 * - createInitializeRequest/createInitializedNotification/createBootstrapMessages: app-server bootstrap messages. Keywords: initialize, initialized.
 * - createQuestionnaireDeveloperInstructions/createTextInput/createQuestionnaireCollaborationMode/createThreadStartRequest/createTurnStartRequest: typed Codex instruction and request builders. Keywords: thread, turn, user input, collaboration mode, questionnaire, developer instructions.
 * - createRequestIdGenerator/isCodexEventType: small protocol helpers. Keywords: ids, event type.
 */
import { MODE_STATE_TAG_INSTRUCTIONS } from "../thread-bootstrap";
import { CODEX_CLIENT_INFO } from "./config";
import type { ClientInfo } from "./generated/app-server/ClientInfo";
import type { ClientNotification } from "./generated/app-server/ClientNotification";
import type { ClientRequest } from "./generated/app-server/ClientRequest";
import type { CollaborationMode } from "./generated/app-server/CollaborationMode";
import type { InitializeCapabilities } from "./generated/app-server/InitializeCapabilities";
import type { InitializeParams } from "./generated/app-server/InitializeParams";
import type { InitializeResponse } from "./generated/app-server/InitializeResponse";
import type { ReasoningEffort } from "./generated/app-server/ReasoningEffort";
import type { ThreadStartParams } from "./generated/app-server/v2/ThreadStartParams";
import type { ThreadStartResponse } from "./generated/app-server/v2/ThreadStartResponse";
import type { TurnStartParams } from "./generated/app-server/v2/TurnStartParams";
import type { TurnStartResponse } from "./generated/app-server/v2/TurnStartResponse";
import type { UserInput } from "./generated/app-server/v2/UserInput";

type EventMsg = { type: string } & Record<string, unknown>;

export type CodexClientRequest = ClientRequest;
export type CodexClientNotification = ClientNotification;
export type CodexRolloutEvent = EventMsg;
export type CodexServerEvent = CodexRolloutEvent;

export interface CodexJsonRpcSuccess<TResult> {
  id: number;
  result: TResult;
}

export interface CodexJsonRpcFailure {
  id: number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type CodexJsonRpcResponse<TResult> = CodexJsonRpcSuccess<TResult> | CodexJsonRpcFailure;

export interface CodexBootstrapMessages {
  initialize: Extract<ClientRequest, { method: "initialize" }>;
  initialized: ClientNotification;
}

const QUESTIONNAIRE_COLLABORATION_INSTRUCTIONS = [
  "# Workbench Tools",
  "`request_user_input` — Use to show a questionnaire to the user, AFTER you have already given the user any required context.",
  "When you use the tool, prefer 1 to 3 concise multiple-choice questions and do not ask multiple-choice questions in plain chat.",
  "Keep the options simple, do not try to stuff context or planning into the questionnaire.",
].join("\n");

function joinInstructionSections(sections: Array<string | null | undefined>) {
  return sections
    .map((section) => section?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n");
}

function normalizeReasoningEffort(value: string | null | undefined): ReasoningEffort | null {
  switch (value) {
    case "none":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return value;
    default:
      return null;
  }
}

export function createCodexClientInfo(overrides: Partial<ClientInfo> = {}): ClientInfo {
  return {
    name: overrides.name ?? CODEX_CLIENT_INFO.name,
    title: overrides.title ?? CODEX_CLIENT_INFO.title,
    version: overrides.version ?? CODEX_CLIENT_INFO.version,
  };
}

export function createInitializeCapabilities(
  overrides: Partial<InitializeCapabilities> = {},
): InitializeCapabilities {
  return {
    experimentalApi: overrides.experimentalApi ?? false,
    optOutNotificationMethods: overrides.optOutNotificationMethods ?? null,
  };
}

export function createInitializeParams(
  overrides: Partial<InitializeParams> = {},
): InitializeParams {
  return {
    clientInfo: overrides.clientInfo ?? createCodexClientInfo(),
    capabilities: overrides.capabilities ?? createInitializeCapabilities(),
  };
}

export function createInitializeRequest(
  id = 0,
  overrides: Partial<InitializeParams> = {},
): Extract<ClientRequest, { method: "initialize" }> {
  return {
    method: "initialize",
    id,
    params: createInitializeParams(overrides),
  };
}

export function createInitializedNotification(): ClientNotification {
  return { method: "initialized" };
}

export function createBootstrapMessages(
  overrides: Partial<InitializeParams> = {},
): CodexBootstrapMessages {
  return {
    initialize: createInitializeRequest(0, overrides),
    initialized: createInitializedNotification(),
  };
}

export function createQuestionnaireDeveloperInstructions(
  additionalInstructions: string | null | undefined = null,
) {
  return joinInstructionSections([
    QUESTIONNAIRE_COLLABORATION_INSTRUCTIONS,
    MODE_STATE_TAG_INSTRUCTIONS,
    additionalInstructions,
  ]);
}

export function createTextInput(text: string): Extract<UserInput, { type: "text" }> {
  return {
    type: "text",
    text,
    text_elements: [],
  };
}

export function createQuestionnaireCollaborationMode(
  model: string,
  reasoningEffort: string | null | undefined = null,
  additionalInstructions: string | null | undefined = null,
): CollaborationMode {
  return {
    mode: "plan",
    settings: {
      developer_instructions: createQuestionnaireDeveloperInstructions(additionalInstructions),
      model,
      reasoning_effort: normalizeReasoningEffort(reasoningEffort),
    },
  };
}

export function createThreadStartRequest(
  id: number,
  overrides: Partial<ThreadStartParams> = {},
): Extract<ClientRequest, { method: "thread/start" }> {
  return {
    method: "thread/start",
    id,
    params: {
      ...overrides,
    },
  };
}

export function createTurnStartRequest(
  id: number,
  threadId: string,
  input: Array<UserInput>,
  overrides: Partial<Omit<TurnStartParams, "input" | "threadId">> = {},
): Extract<ClientRequest, { method: "turn/start" }> {
  return {
    method: "turn/start",
    id,
    params: {
      threadId,
      input,
      ...overrides,
    },
  };
}

export function createRequestIdGenerator(startAt = 1) {
  let currentId = startAt;

  return () => {
    const nextId = currentId;
    currentId += 1;
    return nextId;
  };
}

export function isCodexJsonRpcFailure<TResult>(
  response: CodexJsonRpcResponse<TResult>,
): response is CodexJsonRpcFailure {
  return "error" in response;
}

export function isCodexJsonRpcSuccess<TResult>(
  response: CodexJsonRpcResponse<TResult>,
): response is CodexJsonRpcSuccess<TResult> {
  return "result" in response;
}

export function isCodexEventType<TType extends CodexServerEvent["type"]>(
  event: CodexServerEvent,
  type: TType,
): event is Extract<CodexServerEvent, { type: TType }> {
  return event.type === type;
}

export type CodexInitializeResponse = InitializeResponse;
export type CodexThreadStartResponse = ThreadStartResponse;
export type CodexTurnStartResponse = TurnStartResponse;
