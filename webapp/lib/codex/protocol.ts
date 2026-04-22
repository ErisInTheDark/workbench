import type { ClientInfo } from "./generated/app-server/ClientInfo";
import type { ClientNotification } from "./generated/app-server/ClientNotification";
import type { ClientRequest } from "./generated/app-server/ClientRequest";
import type { EventMsg } from "./generated/app-server/EventMsg";
import type { InitializeCapabilities } from "./generated/app-server/InitializeCapabilities";
import type { InitializeParams } from "./generated/app-server/InitializeParams";
import type { InitializeResponse } from "./generated/app-server/InitializeResponse";
import type { ThreadStartParams } from "./generated/app-server/v2/ThreadStartParams";
import type { ThreadStartResponse } from "./generated/app-server/v2/ThreadStartResponse";
import type { TurnStartParams } from "./generated/app-server/v2/TurnStartParams";
import type { TurnStartResponse } from "./generated/app-server/v2/TurnStartResponse";
import type { UserInput } from "./generated/app-server/v2/UserInput";
import { CODEX_CLIENT_INFO } from "./config";

export type CodexClientRequest = ClientRequest;
export type CodexClientNotification = ClientNotification;
export type CodexServerEvent = EventMsg;

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

export function createTextInput(text: string): Extract<UserInput, { type: "text" }> {
  return {
    type: "text",
    text,
    text_elements: [],
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
      experimentalRawEvents: overrides.experimentalRawEvents ?? false,
      persistExtendedHistory: overrides.persistExtendedHistory ?? true,
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
