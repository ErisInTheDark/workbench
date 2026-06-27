/*
 * Exports:
 * - OpenCodeBridge: translate Workbench bridge requests into typed OpenCode SDK server/session calls and emit Codex-shaped notifications back out. Keywords: opencode, sdk, bridge, session, events.
 */
import fs from "node:fs";

import type {
  Event as OpenCodeEvent,
  OpencodeClient,
  PermissionRequest,
  PermissionV2Request,
  QuestionRequest,
  QuestionV2Request,
  Session,
  SessionStatus,
  V2Event,
} from "@opencode-ai/sdk/v2";

import type { GetAccountRateLimitsResponse } from "../lib/codex/generated/app-server/v2/GetAccountRateLimitsResponse";
import type { Thread } from "../lib/codex/generated/app-server/v2/Thread";
import type { ThreadStatus } from "../lib/codex/generated/app-server/v2/ThreadStatus";
import type { Turn } from "../lib/codex/generated/app-server/v2/Turn";
import type { UserInput } from "../lib/codex/generated/app-server/v2/UserInput";
import type { WorkbenchUserInputResponse } from "../lib/types";
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type { OpenCodeLiveThreadState } from "./opencode-live-thread-state";
import { log, logError } from "./process-helpers";
import type { OrchestratorReloadableModules } from "./reloadable-modules";
import { readWorkbenchPromptContext } from "./workbench-prompt-context";

type OpenCodeBridgeOptions = {
  getReloadableModules: () => OrchestratorReloadableModules;
  initialState?: OpenCodeBridgeState;
  onNotification: (notification: JsonRpcNotification) => void;
  projectRoot: string;
};

type OpenCodeServerHandle = {
  close: () => void;
  url: string;
};

type OpenCodeSessionResponse = {
  model?: string | null;
  modelProvider?: string | null;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  thread: Thread;
};

type OpenCodeStreamEvent = OpenCodeEvent | V2Event;

type PendingPermission = {
  legacy?: PermissionRequest;
  requestKey: string;
  v2?: PermissionV2Request;
};

type PendingQuestion = {
  legacy?: QuestionRequest;
  requestIds: Set<string>;
  requestKey: string;
  v2?: QuestionV2Request;
};

type OpenCodeBridgeState = {
  hadClient: boolean;
  liveThreadState: OpenCodeLiveThreadState;
  pendingPermissions: Map<string, PendingPermission>;
  pendingQuestions: Map<string, PendingQuestion>;
  server: OpenCodeServerHandle | null;
  sessionDirectories: Map<string, string>;
  sessionStatuses: Map<string, SessionStatus>;
};

type OpenCodeSdkModule = typeof import("@opencode-ai/sdk/v2");

const EXTERNAL_OPENCODE_SERVER_URL = process.env.OPENCODE_SERVER_URL?.trim() || null;
const OPENCODE_SERVER_HOSTNAME = process.env.OPENCODE_SERVER_HOSTNAME?.trim() || "127.0.0.1";
const OPENCODE_SERVER_PORT = Number.parseInt(process.env.OPENCODE_SERVER_PORT ?? "4096", 10);
const OPENCODE_SERVER_START_TIMEOUT_MS = Number.parseInt(process.env.OPENCODE_SERVER_START_TIMEOUT_MS ?? "7000", 10);
const OPENCODE_EVENT_SNAPSHOT_REFRESH_DELAY_MS = 150;
const DEFAULT_OPENCODE_THREAD_TITLE = "New OpenCode thread";

let openCodeSdkPromise: Promise<OpenCodeSdkModule> | null = null;

function loadOpenCodeSdk() {
  openCodeSdkPromise ??= import("@opencode-ai/sdk/v2");
  return openCodeSdkPromise;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function normalizeOpenCodeBaseUrl(value: string) {
  const parsedUrl = new URL(value);
  parsedUrl.pathname = "";
  parsedUrl.search = "";
  parsedUrl.hash = "";
  return parsedUrl.toString().replace(/\/$/, "");
}

function normalizeDirectoryForComparison(value: string) {
  const normalized = value
    .trim()
    .replace(/^\\\\\?\\UNC\\/iu, "//")
    .replace(/^\\\\\?\\/iu, "")
    .replace(/\\/g, "/")
    .replace(/\/+$/u, "");

  return /^[a-z]:/iu.test(normalized)
    ? normalized.toLowerCase()
    : normalized;
}

function normalizeDirectoryForOpenCodeSdk(value: string) {
  const trimmed = value.trim();
  const canonicalPath = (() => {
    try {
      return fs.realpathSync.native(trimmed);
    } catch {
      return trimmed;
    }
  })();

  if (/^[a-z]:[\\/]/iu.test(canonicalPath)) {
    return `${canonicalPath.slice(0, 1).toUpperCase()}${canonicalPath.slice(1).replace(/\\/gu, "/")}`;
  }

  if (canonicalPath.startsWith("\\\\")) {
    return `//${canonicalPath.slice(2).replace(/\\/gu, "/")}`;
  }

  return canonicalPath;
}

function isSameDirectory(left: string, right: string) {
  const normalizedLeft = normalizeDirectoryForComparison(left);
  const normalizedRight = normalizeDirectoryForComparison(right);
  return !!normalizedLeft && normalizedLeft === normalizedRight;
}

function modelParts(model: string | null | undefined) {
  const [providerID, ...rest] = (model ?? "").split("/");
  const modelID = rest.join("/");
  return providerID && modelID ? { modelID, providerID } : null;
}

function okResponse(id: JsonRpcResponse["id"], result: unknown): JsonRpcResponse {
  return { id, result };
}

function errorResponse(id: JsonRpcResponse["id"], code: number, message: string): JsonRpcResponse {
  return {
    error: {
      code,
      message,
    },
    id,
  };
}

function unwrapResponse<TValue>(response: { data: TValue; error: undefined } | { data: undefined; error: unknown }) {
  if (response.error !== undefined) {
    throw new Error(readSdkErrorMessage(response.error));
  }

  return response.data;
}

function readSdkErrorMessage(error: unknown) {
  const record = asRecord(error);
  const data = asRecord(record?.data);
  return asString(data?.message)
    ?? asString(record?.message)
    ?? "OpenCode SDK request failed.";
}

function requestDirectory(params: unknown, fallback: string) {
  const record = asRecord(params);
  return normalizeDirectoryForOpenCodeSdk(asString(record?.cwd) ?? asString(record?.directory) ?? fallback);
}

function requestDirectories(params: unknown, fallback: string) {
  const record = asRecord(params);
  const rawDirectories = asStringArray(record?.cwd).length
    ? asStringArray(record?.cwd)
    : asStringArray(record?.directory).length
      ? asStringArray(record?.directory)
      : [asString(record?.cwd) ?? asString(record?.directory) ?? fallback];

  return Array.from(new Set(rawDirectories.map(normalizeDirectoryForOpenCodeSdk).filter(Boolean)));
}

function requestThreadId(params: unknown) {
  return asString(asRecord(params)?.threadId);
}

function requestInput(params: unknown) {
  const input = asRecord(params)?.input;
  return Array.isArray(input) ? input.filter((entry): entry is UserInput => asRecord(entry) !== null && typeof asRecord(entry)?.type === "string") : [];
}

function requestModel(params: unknown) {
  return asString(asRecord(params)?.model);
}

function requestAgent(params: unknown) {
  return asString(asRecord(params)?.agentPath) ?? asString(asRecord(params)?.agent);
}

function requestName(params: unknown) {
  return asString(asRecord(params)?.name);
}

function isDefaultOpenCodeThreadTitle(title: string | null | undefined) {
  const normalizedTitle = title?.trim();
  return !normalizedTitle || normalizedTitle === DEFAULT_OPENCODE_THREAD_TITLE;
}

function statusToThreadStatus(status: SessionStatus | null | undefined): ThreadStatus {
  if (status?.type === "busy" || status?.type === "retry") {
    return { activeFlags: [], type: "active" };
  }

  return { type: "idle" };
}

function normalizeOpenCodeStreamEvent(event: OpenCodeStreamEvent): V2Event {
  if ("data" in event) {
    return event;
  }

  return {
    data: event.properties,
    type: event.type,
  } as V2Event;
}

function eventThreadId(event: V2Event) {
  switch (event.type) {
    case "message.updated":
      return event.data.sessionID;
    case "message.part.delta":
      return event.data.sessionID;
    case "message.part.updated":
      return event.data.sessionID;
    case "message.part.removed":
      return event.data.sessionID;
    case "message.removed":
      return event.data.sessionID;
    case "session.error":
      return event.data.sessionID ?? null;
    default:
      return null;
  }
}

function openCodeQuestionRequestKey(question: QuestionRequest | QuestionV2Request) {
  return question.tool
    ? `opencode:${question.sessionID}:question-tool:${question.tool.messageID}:${question.tool.callID}`
    : `opencode:${question.sessionID}:question:${question.id}`;
}

function openCodeQuestionDisplayRequest(question: PendingQuestion) {
  return question.v2 ?? question.legacy;
}

function createSyntheticTurn(threadId: string, input: UserInput[]): Turn {
  const now = Math.floor(Date.now() / 1000);
  return {
    completedAt: null,
    durationMs: null,
    error: null,
    id: `opencode:turn:${threadId}:pending:${now}`,
    items: [{
      content: input,
      id: `opencode:user:pending:${now}`,
      type: "userMessage",
    }],
    itemsView: "full",
    startedAt: now,
    status: "inProgress",
  };
}

export class OpenCodeBridge {
  private readonly getReloadableModules: OpenCodeBridgeOptions["getReloadableModules"];
  private readonly onNotification: OpenCodeBridgeOptions["onNotification"];
  private readonly projectRoot: string;
  private client: OpencodeClient | null = null;
  private eventAbortController: AbortController | null = null;
  private eventPumpPromise: Promise<void> | null = null;
  private liveThreadState: OpenCodeLiveThreadState;
  private pendingPermissions = new Map<string, PendingPermission>();
  private pendingQuestions = new Map<string, PendingQuestion>();
  private server: OpenCodeServerHandle | null = null;
  private sessionDirectories = new Map<string, string>();
  private startPromise: Promise<OpencodeClient> | null = null;
  private snapshotRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private sessionStatuses = new Map<string, SessionStatus>();

  constructor({ getReloadableModules, initialState, onNotification, projectRoot }: OpenCodeBridgeOptions) {
    this.getReloadableModules = getReloadableModules;
    this.onNotification = onNotification;
    this.projectRoot = projectRoot;
    this.client = null;
    this.liveThreadState = initialState?.liveThreadState
      ?? getReloadableModules().opencodeLiveThreadState.createOpenCodeLiveThreadState();
    this.pendingPermissions = initialState?.pendingPermissions ?? new Map();
    this.pendingQuestions = initialState?.pendingQuestions ?? new Map();
    this.server = initialState?.server ?? null;
    this.sessionDirectories = initialState?.sessionDirectories ?? new Map();
    this.sessionStatuses = initialState?.sessionStatuses ?? new Map();
    if (initialState?.hadClient || this.server) {
      void this.ensureClient().catch((error) => {
        logError("opencode-bridge", error instanceof Error ? error.message : String(error));
      });
    }
  }

  getInitializeResult() {
    return this.getReloadableModules().opencodeThreadState.OPENCODE_INITIALIZE_RESULT;
  }

  async stop() {
    this.eventAbortController?.abort();
    this.eventAbortController = null;
    await this.eventPumpPromise?.catch(() => undefined);
    this.eventPumpPromise = null;
    this.pendingPermissions.clear();
    this.pendingQuestions.clear();
    this.liveThreadState = this.getReloadableModules().opencodeLiveThreadState.createOpenCodeLiveThreadState();
    for (const timer of this.snapshotRefreshTimers.values()) {
      clearTimeout(timer);
    }
    this.snapshotRefreshTimers.clear();
    this.sessionDirectories.clear();
    this.sessionStatuses.clear();
    this.client = null;
    this.server?.close();
    this.server = null;
  }

  async detachForReload(): Promise<OpenCodeBridgeState> {
    await this.startPromise?.catch(() => undefined);
    this.startPromise = null;
    this.eventAbortController?.abort();
    this.eventAbortController = null;
    await this.eventPumpPromise?.catch(() => undefined);
    this.eventPumpPromise = null;
    for (const timer of this.snapshotRefreshTimers.values()) {
      clearTimeout(timer);
    }
    this.snapshotRefreshTimers.clear();

    const state: OpenCodeBridgeState = {
      hadClient: Boolean(this.client),
      liveThreadState: this.liveThreadState,
      pendingPermissions: this.pendingPermissions,
      pendingQuestions: this.pendingQuestions,
      server: this.server,
      sessionDirectories: this.sessionDirectories,
      sessionStatuses: this.sessionStatuses,
    };

    this.client = null;
    this.liveThreadState = this.getReloadableModules().opencodeLiveThreadState.createOpenCodeLiveThreadState();
    this.pendingPermissions = new Map();
    this.pendingQuestions = new Map();
    this.server = null;
    this.sessionDirectories = new Map();
    this.sessionStatuses = new Map();

    return state;
  }

  async handleRequest(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    const requestId = message.id ?? null;
    const method = typeof message.method === "string" ? message.method : null;
    if (!method) {
      return errorResponse(requestId, -32600, "Invalid JSON-RPC request.");
    }

    try {
      switch (method) {
        case "thread/list":
          return okResponse(requestId, await this.listThreads(requestDirectories(message.params, this.projectRoot)));
        case "thread/read":
        case "thread/resume": {
          const threadId = requestThreadId(message.params);
          if (!threadId) {
            return errorResponse(requestId, -32602, "Missing thread id.");
          }
          return okResponse(requestId, await this.readThread(threadId, requestDirectory(message.params, this.projectRoot)));
        }
        case "thread/start":
          return okResponse(requestId, await this.startThread(message.params));
        case "thread/name/set": {
          const threadId = requestThreadId(message.params);
          const name = requestName(message.params);
          if (!threadId || !name) {
            return errorResponse(requestId, -32602, "Missing thread/name/set params.");
          }
          return okResponse(requestId, await this.setThreadName(threadId, name, requestDirectory(message.params, this.projectRoot)));
        }
        case "turn/start":
        case "turn/steer":
          return okResponse(requestId, await this.startTurn(message));
        case "turn/interrupt": {
          const threadId = requestThreadId(message.params);
          if (!threadId) {
            return errorResponse(requestId, -32602, "Missing turn/interrupt params.");
          }
          return okResponse(requestId, await this.abortThread(threadId, requestDirectory(message.params, this.projectRoot)));
        }
        case "model/list":
          return okResponse(requestId, await this.listModels(requestDirectory(message.params, this.projectRoot)));
        case "account/rateLimits/read":
          return okResponse(requestId, this.readRateLimits());
        case "questionnaire/list":
          return okResponse(requestId, await this.listPendingPermissions());
        case "questionnaire/respond":
          return okResponse(requestId, await this.respondToPermission(message.params));
        default:
          return errorResponse(requestId, -32601, `Unsupported OpenCode bridge method: ${method}`);
      }
    } catch (error) {
      return errorResponse(
        requestId,
        -32000,
        error instanceof Error ? error.message : "OpenCode bridge request failed.",
      );
    }
  }

  private async ensureClient(_directory = this.projectRoot) {
    if (this.client) {
      return this.client;
    }

    if (this.startPromise) {
      return await this.startPromise;
    }

    this.startPromise = (async () => {
      const { createOpencodeClient } = await loadOpenCodeSdk();
      const baseUrl = EXTERNAL_OPENCODE_SERVER_URL
        ? normalizeOpenCodeBaseUrl(EXTERNAL_OPENCODE_SERVER_URL)
        : this.server
          ? normalizeOpenCodeBaseUrl(this.server.url)
        : await this.startManagedServer();
      const headers: Record<string, string> = {};
      if (process.env.OPENCODE_SERVER_USERNAME || process.env.OPENCODE_SERVER_PASSWORD) {
        const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
        const password = process.env.OPENCODE_SERVER_PASSWORD || "";
        headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
      }
      this.client = createOpencodeClient({
        baseUrl,
        headers,
      });
      this.startEventPump(this.client);
      log("opencode-bridge", `connected to ${baseUrl}`);
      return this.client;
    })();

    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async startManagedServer() {
    const { createOpencodeServer } = await loadOpenCodeSdk();
    const previousConfigDirectory = process.env.OPENCODE_CONFIG_DIR;
    const workbenchConfig = await this.getReloadableModules().opencodeWorkbenchInstructions.ensureOpenCodeWorkbenchConfigDirectory({
      baseConfigDirectory: previousConfigDirectory,
    });
    process.env.OPENCODE_CONFIG_DIR = workbenchConfig.configDirectory;
    log(
      "opencode-bridge",
      workbenchConfig.copiedBaseConfig
        ? `using Workbench OpenCode config overlay from ${workbenchConfig.baseConfigDirectory}`
        : `using Workbench OpenCode config without base config; ${workbenchConfig.baseConfigDirectory} was unavailable (${workbenchConfig.unavailableBaseConfigReason ?? "unknown"})`,
    );

    let server: OpenCodeServerHandle;
    try {
      server = await createOpencodeServer({
        hostname: OPENCODE_SERVER_HOSTNAME,
        port: Number.isFinite(OPENCODE_SERVER_PORT) ? OPENCODE_SERVER_PORT : 4096,
        timeout: Number.isFinite(OPENCODE_SERVER_START_TIMEOUT_MS) ? OPENCODE_SERVER_START_TIMEOUT_MS : 7000,
      });
    } finally {
      if (previousConfigDirectory === undefined) {
        delete process.env.OPENCODE_CONFIG_DIR;
      } else {
        process.env.OPENCODE_CONFIG_DIR = previousConfigDirectory;
      }
    }

    this.server = server;
    return normalizeOpenCodeBaseUrl(server.url);
  }

  private startEventPump(client: OpencodeClient) {
    if (this.eventPumpPromise) {
      return;
    }

    const abortController = new AbortController();
    this.eventAbortController = abortController;
    this.eventPumpPromise = (async () => {
      try {
        const events = await client.event.subscribe({ directory: this.projectRoot }, { signal: abortController.signal });
        for await (const event of events.stream) {
          this.handleEvent(event);
        }
      } catch (error) {
        if (!abortController.signal.aborted) {
          logError("opencode-bridge", error instanceof Error ? error.message : String(error));
        }
      }
    })();
  }

  private handleEvent(streamEvent: OpenCodeStreamEvent) {
    const event = normalizeOpenCodeStreamEvent(streamEvent);
    switch (event.type) {
      case "session.created":
      case "session.updated":
        this.rememberSessionDirectory(event.data.sessionID, event.data.info.directory);
        this.onNotification({
          method: event.type === "session.created" ? "thread/started" : "thread/name/updated",
          params: event.type === "session.created"
            ? { thread: this.getReloadableModules().opencodeThreadState.opencodeSessionToThread({
              messages: [],
              session: event.data.info,
              status: this.sessionStatuses.get(event.data.sessionID),
            }) }
            : { threadId: event.data.sessionID, threadName: event.data.info.title },
        });
        break;
      case "session.status":
        this.sessionStatuses.set(event.data.sessionID, event.data.status);
        this.onNotification({
          method: "thread/status/changed",
          params: {
            status: statusToThreadStatus(event.data.status),
            threadId: event.data.sessionID,
          },
        });
        break;
      case "session.idle":
        this.sessionStatuses.set(event.data.sessionID, { type: "idle" });
        this.getReloadableModules().opencodeLiveThreadState.applyOpenCodeLiveEvent(this.liveThreadState, event, this.onNotification);
        this.onNotification({
          method: "thread/status/changed",
          params: {
            status: { type: "idle" },
            threadId: event.data.sessionID,
          },
        });
        this.scheduleThreadSnapshotRefresh(event.data.sessionID);
        break;
      case "permission.v2.asked":
        this.upsertPermission("v2", event.data);
        break;
      case "permission.v2.replied":
        this.resolvePermission(event.data.sessionID, event.data.requestID);
        break;
      case "permission.asked":
        this.upsertPermission("legacy", event.data);
        break;
      case "permission.replied":
        this.resolvePermission(event.data.sessionID, event.data.requestID);
        break;
      case "question.asked":
        this.upsertQuestion("legacy", event.data);
        break;
      case "question.replied":
      case "question.rejected":
        this.resolveQuestion(event.data.sessionID, event.data.requestID);
        break;
      case "question.v2.asked":
        this.upsertQuestion("v2", event.data);
        break;
      case "question.v2.replied":
      case "question.v2.rejected":
        this.resolveQuestion(event.data.sessionID, event.data.requestID);
        break;
      case "session.next.prompted":
      case "session.next.prompt.admitted":
      case "session.next.text.started":
      case "session.next.text.delta":
      case "session.next.text.ended":
      case "session.next.reasoning.started":
      case "session.next.reasoning.delta":
      case "session.next.reasoning.ended":
      case "session.next.tool.input.started":
      case "session.next.tool.input.delta":
      case "session.next.tool.input.ended":
      case "session.next.tool.called":
      case "session.next.tool.progress":
      case "session.next.tool.success":
      case "session.next.tool.failed":
      case "message.part.delta":
        this.getReloadableModules().opencodeLiveThreadState.applyOpenCodeLiveEvent(this.liveThreadState, event, this.onNotification);
        break;
      case "message.updated":
      case "message.part.updated":
      case "message.part.removed":
      case "message.removed":
      case "session.error": {
        const threadId = eventThreadId(event);
        if (!threadId) {
          break;
        }
        if (event.type === "session.error") {
          this.clearPendingUserInputForThread(threadId);
        }
        if (event.type === "message.updated" || event.type === "message.part.updated") {
          this.getReloadableModules().opencodeLiveThreadState.applyOpenCodeLiveEvent(this.liveThreadState, event, this.onNotification);
        }
        this.onNotification({
          method: "thread/status/changed",
          params: {
            status: event.type === "session.error" ? { type: "systemError" } : { activeFlags: [], type: "active" },
            threadId,
          },
        });
        if (event.type !== "session.error") {
          this.scheduleThreadSnapshotRefresh(threadId, 500);
        }
        break;
      }
    }
  }

  private rememberSessionDirectory(threadId: string | null | undefined, directory: string | null | undefined) {
    if (threadId && directory) {
      this.sessionDirectories.set(threadId, directory);
    }
  }

  private scheduleThreadSnapshotRefresh(threadId: string, delayMs = OPENCODE_EVENT_SNAPSHOT_REFRESH_DELAY_MS) {
    const existingTimer = this.snapshotRefreshTimers.get(threadId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.snapshotRefreshTimers.delete(threadId);
      void this.emitThreadSnapshot(threadId).catch((error) => {
        logError("opencode-bridge", error instanceof Error ? error.message : String(error));
      });
    }, delayMs);
    this.snapshotRefreshTimers.set(threadId, timer);
  }

  private async emitThreadSnapshot(threadId: string) {
    const directory = this.sessionDirectories.get(threadId) ?? this.projectRoot;
    const { thread } = await this.readThread(threadId, directory);
    const latestTurn = thread.turns.at(-1);
    this.onNotification({
      method: "thread/status/changed",
      params: {
        status: thread.status,
        threadId,
      },
    });
    if (thread.name) {
      this.onNotification({
        method: "thread/name/updated",
        params: {
          threadId,
          threadName: thread.name,
        },
      });
    }
    if (!latestTurn) {
      return;
    }
    this.onNotification({
      method: latestTurn.status === "inProgress" ? "turn/started" : "turn/completed",
      params: {
        threadId,
        turn: latestTurn,
      },
    });
  }

  private async listThreads(directories: string[]) {
    const [primaryDirectory = this.projectRoot] = directories;
    const client = await this.ensureClient(primaryDirectory);
    const sessionsById = new Map<string, Session>();
    for (const directory of directories) {
      const sessions = unwrapResponse(await client.session.list({ directory }));
      for (const session of sessions) {
        sessionsById.set(session.id, session);
      }
    }
    const sessions = Array.from(sessionsById.values());
    const visibleSessions = sessions.filter((session) => (
      directories.some((directory) => isSameDirectory(session.directory, directory))
    ));
    for (const session of visibleSessions) {
      this.rememberSessionDirectory(session.id, session.directory);
    }
    return {
      data: visibleSessions.map((session) => this.getReloadableModules().opencodeThreadState.opencodeSessionToThread({
        messages: [],
        session,
        status: this.sessionStatuses.get(session.id),
      })),
    };
  }

  private async readThread(threadId: string, directory: string): Promise<OpenCodeSessionResponse> {
    const client = await this.ensureClient(directory);
    const [session, messages, statuses] = await Promise.all([
      client.session.get({ directory, sessionID: threadId }).then(unwrapResponse),
      client.session.messages({ directory, limit: 100, sessionID: threadId }).then(unwrapResponse),
      client.session.status({ directory }).then(unwrapResponse).catch(() => ({} as Record<string, SessionStatus>)),
    ]);
    const status = statuses[threadId] ?? this.sessionStatuses.get(threadId) ?? null;
    if (status) {
      this.sessionStatuses.set(threadId, status);
    }
    this.rememberSessionDirectory(session.id, session.directory);
    const thread = this.getReloadableModules().opencodeThreadState.opencodeSessionToThread({ messages, session, status });
    return {
      model: (thread as Thread & { model?: string | null }).model ?? null,
      modelProvider: thread.modelProvider,
      reasoningEffort: null,
      serviceTier: null,
      thread,
    };
  }

  private async startThread(params: unknown): Promise<OpenCodeSessionResponse> {
    const directory = requestDirectory(params, this.projectRoot);
    const client = await this.ensureClient(directory);
    const session = unwrapResponse(await client.session.create({
      directory,
      title: DEFAULT_OPENCODE_THREAD_TITLE,
    }));
    this.rememberSessionDirectory(session.id, session.directory);
    const thread = this.getReloadableModules().opencodeThreadState.opencodeSessionToThread({
      messages: [],
      session,
      status: this.sessionStatuses.get(session.id),
    });
    return {
      model: requestModel(params),
      modelProvider: requestModel(params)?.split("/")[0] ?? "opencode",
      reasoningEffort: null,
      serviceTier: null,
      thread,
    };
  }

  private async setThreadName(threadId: string, name: string, directory: string) {
    const client = await this.ensureClient(directory);
    const session = unwrapResponse(await client.session.update({
      directory,
      sessionID: threadId,
      title: name,
    }));
    this.onNotification({
      method: "thread/name/updated",
      params: {
        threadId: session.id,
        threadName: session.title,
      },
    });
    return {};
  }

  private async updateDefaultThreadTitleFromPrompt(client: OpencodeClient, threadId: string, directory: string, prompt: string) {
    const title = this.getReloadableModules().threadBootstrap.normalizeThreadTitle(prompt);
    if (!title) {
      return;
    }

    try {
      const session = unwrapResponse(await client.session.get({ directory, sessionID: threadId }));
      if (!isDefaultOpenCodeThreadTitle(session.title)) {
        return;
      }

      const updatedSession = unwrapResponse(await client.session.update({
        directory,
        sessionID: threadId,
        title,
      }));
      this.onNotification({
        method: "thread/name/updated",
        params: {
          threadId: updatedSession.id,
          threadName: updatedSession.title,
        },
      });
    } catch (error) {
      logError("opencode-bridge", `failed to set default thread title: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async buildTurnSystemPrompt(message: JsonRpcRequest, threadId: string, params: unknown) {
    const promptContext = readWorkbenchPromptContext(message);
    if (promptContext) {
      const instructions = await this.getReloadableModules().workbenchPromptFiles.buildWorkbenchPromptInstructions({
        ...promptContext,
        harness: "opencode",
        threadId: promptContext.threadId ?? threadId,
      });
      return this.getReloadableModules().opencodeWorkbenchInstructions.buildOpenCodeWorkbenchSystemPrompt(instructions);
    }

    const workbenchOrigin = asString(asRecord(params)?.workbenchOrigin);
    return workbenchOrigin
      ? this.getReloadableModules().threadBootstrap.buildThreadTitleBootstrapInstructions({
        harness: "opencode",
        routeUrl: this.getReloadableModules().threadBootstrap.buildThreadTitleRouteUrl(workbenchOrigin),
        threadId,
      })
      : null;
  }

  private async startTurn(message: JsonRpcRequest) {
    const params = message.params;
    const threadId = requestThreadId(params);
    const input = requestInput(params);
    if (!threadId || !input.length) {
      throw new Error("Missing OpenCode turn params.");
    }

    const directory = requestDirectory(params, this.projectRoot);
    const prompt = this.getReloadableModules().opencodeThreadState.formatPromptFromInput(input);
    if (!prompt) {
      throw new Error("OpenCode prompt cannot be empty.");
    }

    const client = await this.ensureClient(directory);
    const model = modelParts(requestModel(params));
    const agent = requestAgent(params);
    const system = await this.buildTurnSystemPrompt(message, threadId, params);
    await this.updateDefaultThreadTitleFromPrompt(client, threadId, directory, prompt);
    this.rememberSessionDirectory(threadId, directory);
    const turn = createSyntheticTurn(threadId, input);
    this.onNotification({
      method: "turn/started",
      params: {
        threadId,
        turn,
      },
    });

    try {
      await client.session.promptAsync({
      ...(agent ? { agent } : {}),
      directory,
      ...(model ? { model } : {}),
      parts: [{ text: prompt, type: "text" }],
      sessionID: threadId,
      ...(system ? { system } : {}),
      });
      this.scheduleThreadSnapshotRefresh(threadId);
    } catch (error) {
      logError("opencode-bridge", error instanceof Error ? error.message : String(error));
      this.onNotification({
        method: "thread/status/changed",
        params: {
          status: { type: "systemError" },
          threadId,
        },
      });
      throw error;
    }
    return { turn };
  }

  private async abortThread(threadId: string, directory: string) {
    const client = await this.ensureClient(directory);
    await client.session.abort({ directory, sessionID: threadId });
    this.clearPendingUserInputForThread(threadId);
    return { ok: true };
  }

  private async listModels(directory: string) {
    const client = await this.ensureClient(directory);
    const [models, providers] = await Promise.all([
      client.v2.model.list({ location: { directory } }).then(unwrapResponse),
      client.v2.provider.list({ location: { directory } }).then(unwrapResponse).catch(() => ({ data: [] })),
    ]);
    return {
      data: this.getReloadableModules().opencodeThreadState.mapOpenCodeModelsToWorkbenchOptions(
        models.data,
        providers.data,
      ),
    };
  }

  private readRateLimits(): GetAccountRateLimitsResponse {
    const rateLimits = this.getReloadableModules().opencodeThreadState.EMPTY_OPENCODE_RATE_LIMITS;
    return {
      rateLimits,
      rateLimitsByLimitId: null,
    };
  }

  private permissionRequestKey(permission: PermissionRequest | PermissionV2Request) {
    return `opencode:${permission.sessionID}:${permission.id}`;
  }

  private upsertPermission(
    kind: "legacy" | "v2",
    permission: PermissionRequest | PermissionV2Request,
  ) {
    const requestKey = this.permissionRequestKey(permission);
    const existing = this.pendingPermissions.get(requestKey);
    this.pendingPermissions.set(requestKey, {
      legacy: kind === "legacy" ? permission as PermissionRequest : existing?.legacy,
      requestKey,
      v2: kind === "v2" ? permission as PermissionV2Request : existing?.v2,
    });
    if (existing) {
      return;
    }

    this.onNotification({
      method: "questionnaire/requested",
      params: {
        itemId: null,
        request: kind === "v2"
          ? this.getReloadableModules().opencodeThreadState.createOpenCodePermissionRequest(permission as PermissionV2Request)
          : this.getReloadableModules().opencodeThreadState.createOpenCodeLegacyPermissionRequest(permission as PermissionRequest),
        requestKey,
        threadId: permission.sessionID,
        turnId: null,
      },
    });
  }

  private resolvePermission(threadId: string, permissionId: string) {
    const requestKey = `opencode:${threadId}:${permissionId}`;
    this.pendingPermissions.delete(requestKey);
    this.onNotification({
      method: "questionnaire/resolved",
      params: {
        requestKey,
        threadId,
        turnId: null,
      },
    });
  }

  private clearPendingUserInputForThread(threadId: string) {
    for (const [requestKey, pendingPermission] of this.pendingPermissions) {
      if (pendingPermission.legacy?.sessionID !== threadId && pendingPermission.v2?.sessionID !== threadId) {
        continue;
      }

      this.pendingPermissions.delete(requestKey);
      this.onNotification({
        method: "questionnaire/resolved",
        params: {
          requestKey,
          threadId,
          turnId: null,
        },
      });
    }

    for (const [requestKey, pendingQuestion] of this.pendingQuestions) {
      if (pendingQuestion.legacy?.sessionID !== threadId && pendingQuestion.v2?.sessionID !== threadId) {
        continue;
      }

      this.pendingQuestions.delete(requestKey);
      this.onNotification({
        method: "questionnaire/resolved",
        params: {
          requestKey,
          threadId,
          turnId: null,
        },
      });
    }
  }

  private upsertQuestion(
    kind: "legacy" | "v2",
    question: QuestionRequest | QuestionV2Request,
    { notify = true }: { notify?: boolean } = {},
  ) {
    const requestKey = openCodeQuestionRequestKey(question);
    const existing = this.pendingQuestions.get(requestKey);
    const nextQuestion: PendingQuestion = {
      legacy: kind === "legacy" ? question : existing?.legacy,
      requestIds: new Set([...(existing?.requestIds ?? []), question.id]),
      requestKey,
      v2: kind === "v2" ? question : existing?.v2,
    };
    this.pendingQuestions.set(requestKey, nextQuestion);
    if (existing || !notify) {
      return;
    }

    const displayQuestion = openCodeQuestionDisplayRequest(nextQuestion);
    if (!displayQuestion) {
      return;
    }

    this.onNotification({
      method: "questionnaire/requested",
      params: {
        itemId: null,
        request: this.getReloadableModules().opencodeThreadState.createOpenCodeQuestionRequest(displayQuestion),
        requestKey,
        threadId: displayQuestion.sessionID,
        turnId: null,
      },
    });
  }

  private resolveQuestion(threadId: string, questionId: string) {
    const requestKey = Array.from(this.pendingQuestions.values()).find((question) => (
      question.requestIds.has(questionId)
      && (question.legacy?.sessionID === threadId || question.v2?.sessionID === threadId)
    ))?.requestKey ?? `opencode:${threadId}:question:${questionId}`;
    this.pendingQuestions.delete(requestKey);
    this.onNotification({
      method: "questionnaire/resolved",
      params: {
        requestKey,
        threadId,
        turnId: null,
      },
    });
  }

  private async hydratePendingQuestions() {
    const client = await this.ensureClient(this.projectRoot);
    const questions = unwrapResponse(await client.question.list({ directory: this.projectRoot }));
    for (const question of questions) {
      this.upsertQuestion("legacy", question, { notify: false });
    }
  }

  private async listPendingPermissions() {
    await this.hydratePendingQuestions().catch((error) => {
      logError("opencode-bridge", error instanceof Error ? error.message : String(error));
    });

    return {
      data: [
        ...Array.from(this.pendingPermissions.values()).flatMap((permission) => {
          const displayPermission = permission.v2 ?? permission.legacy;
          if (!displayPermission) {
            return [];
          }

          return [{
            itemId: null,
            request: permission.v2
              ? this.getReloadableModules().opencodeThreadState.createOpenCodePermissionRequest(permission.v2)
              : this.getReloadableModules().opencodeThreadState.createOpenCodeLegacyPermissionRequest(displayPermission as PermissionRequest),
            requestKey: permission.requestKey,
            threadId: displayPermission.sessionID,
            turnId: null,
          }];
        }),
        ...Array.from(this.pendingQuestions.values()).flatMap((question) => {
          const displayQuestion = openCodeQuestionDisplayRequest(question);
          return displayQuestion
            ? [{
              itemId: null,
              request: this.getReloadableModules().opencodeThreadState.createOpenCodeQuestionRequest(displayQuestion),
              requestKey: question.requestKey,
              threadId: displayQuestion.sessionID,
              turnId: null,
            }]
            : [];
        }),
      ],
    };
  }

  private async respondToPermission(params: unknown) {
    const record = asRecord(params);
    const requestKey = asString(record?.requestKey);
    const pendingPermission = requestKey ? this.pendingPermissions.get(requestKey) : null;
    if (pendingPermission) {
      const response = this.readPermissionResponse(record?.response);
      const client = await this.ensureClient(this.projectRoot);
      if (pendingPermission.v2) {
        await client.v2.session.permission.reply({
          reply: response,
          requestID: pendingPermission.v2.id,
          sessionID: pendingPermission.v2.sessionID,
        });
        this.resolvePermission(pendingPermission.v2.sessionID, pendingPermission.v2.id);
      } else if (pendingPermission.legacy) {
        await client.permission.reply({
          directory: this.sessionDirectories.get(pendingPermission.legacy.sessionID) ?? this.projectRoot,
          reply: response,
          requestID: pendingPermission.legacy.id,
        });
        this.resolvePermission(pendingPermission.legacy.sessionID, pendingPermission.legacy.id);
      }
      return { ok: true };
    }

    const pendingQuestion = requestKey ? this.pendingQuestions.get(requestKey) : null;
    if (!pendingQuestion) {
      throw new Error("OpenCode questionnaire request is no longer pending.");
    }

    const replyQuestion = pendingQuestion.v2 ?? pendingQuestion.legacy;
    if (!replyQuestion) {
      throw new Error("OpenCode questionnaire request is missing its question payload.");
    }

    const response = this.readQuestionResponse(replyQuestion, record?.response);
    const client = await this.ensureClient(this.projectRoot);
    if (pendingQuestion.v2) {
      await client.v2.session.question.reply({
        questionV2Reply: response,
        requestID: pendingQuestion.v2.id,
        sessionID: pendingQuestion.v2.sessionID,
      });
    } else {
      await client.question.reply({
        answers: response.answers,
        directory: this.sessionDirectories.get(replyQuestion.sessionID) ?? this.projectRoot,
        requestID: replyQuestion.id,
      });
    }
    this.resolveQuestion(replyQuestion.sessionID, replyQuestion.id);
    return { ok: true };
  }

  private readPermissionResponse(response: unknown): "once" | "always" | "reject" {
    const answers = asRecord(response)?.answers;
    const permissionAnswer = asRecord(answers)?.permission;
    const selected = asStringArray(asRecord(permissionAnswer)?.answers)[0]?.toLowerCase() ?? "";
    if (selected.includes("always")) {
      return "always";
    }
    if (selected.includes("reject")) {
      return "reject";
    }
    return "once";
  }

  private readQuestionResponse(question: QuestionRequest | QuestionV2Request, response: unknown) {
    const answersRecord = asRecord(asRecord(response)?.answers);
    return {
      answers: question.questions.map((_, index) => {
        const answer = asRecord(answersRecord?.[`question-${index + 1}`]);
        return asStringArray(answer?.answers).filter((value) => value.trim());
      }),
    };
  }
}
