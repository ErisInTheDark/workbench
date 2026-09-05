/*
 * Keywords: websocket, request, reload, stream, handoff, timer, diagnostics.
 * Exports:
 * - WorkbenchWebSocketPendingRequestState: transferable browser request timing.
 * - WorkbenchWebSocketReloadDirtObserverState: reload-dirt subscriber identity.
 * - WorkbenchWebSocketRequestControllerState: request, observer, and stream handoff.
 * - WorkbenchWebSocketRequestControllerOptions: routing, clock, scheduler, and logging ports.
 * - default WorkbenchWebSocketRequestController: route feature requests and own event-stream health.
 */
import type { WorkbenchHarness } from "workbench-shared/types";
import {
  WORKBENCH_RELOAD_DIRT_READ_METHOD,
  WORKBENCH_RELOAD_DIRT_UPDATED_METHOD,
} from "workbench-shared/workbench/orchestrator-reload";
import {
  decodeWorkbenchTranscriptRequest,
  WORKBENCH_TRANSCRIPT_PROTOCOL_VERSION,
  type WorkbenchTranscriptRequest,
  workbenchTranscriptNotifications,
} from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import type {
  OrchestratorTranscriptRegistration,
  OrchestratorTranscriptShadowLog,
} from "./orchestrator-runtime-objects";
import {
  WORKBENCH_EVENT_STREAM_ACK_METHOD,
  WorkbenchEventStreamAckSchema,
  type WorkbenchEventStreamHealth,
} from "workbench-shared/workbench/websocket-stream";
import type { BridgeClient, JsonRpcRequest } from "./bridge-types";
import type WorkbenchHarnessController from "./WorkbenchHarnessController";
import type WorkbenchDaemonRequestController from "./WorkbenchDaemonRequestController";
import type WorkbenchOrchestratorReloadController from "./WorkbenchOrchestratorReloadController";
import type WorkbenchThreadStateController from "./WorkbenchThreadStateController";
import type WorkbenchStatsController from "./stats/WorkbenchStatsController";
import { WORKBENCH_STATS_IMPORT_UPDATED_METHOD } from "workbench-shared/workbench/stats/workbench-stats-contract";
import WorkbenchWebSocketStreamController, {
  type WorkbenchWebSocketStreamControllerState,
} from "./WorkbenchWebSocketStreamController";
import { dimWebSocketDetail } from "./websocket-log-format";
import { transcriptSnapshotForProtocol } from "./database/transcript/transcript-wire-compatibility";

const WORKBENCH_HARNESS_FIELD = "workbenchHarness";
const DEFAULT_PENDING_THRESHOLD_MS = 2_000;
const PENDING_WARNING_INTERVAL_MS = 2_000;
const PENDING_THRESHOLD_OVERRIDES = new Map<string, number>([
  ["initialize", 10_000],
  ["thread/compact/start", 30_000],
]);
const ANSI_GREEN = "\u001b[32m";
const ANSI_RED = "\u001b[31m";
const ANSI_YELLOW = "\u001b[33m";
const ANSI_RESET = "\u001b[0m";

type RequestId = number | string | null;
type Timer = ReturnType<typeof setTimeout>;
type CompletionOutcome = "closed" | "error" | "ok" | "replaced" | "send-error";

export interface WorkbenchWebSocketPendingRequestState {
  client: BridgeClient;
  id: RequestId;
  inBytes: number;
  method: string;
  nextWarningAt: number;
  startedAt: number;
}

export interface WorkbenchWebSocketRequestControllerState {
  pending: WorkbenchWebSocketPendingRequestState[];
  reloadDirtObservers?: WorkbenchWebSocketReloadDirtObserverState[];
  reloadDirtRevision?: number;
  stream?: WorkbenchWebSocketStreamControllerState;
  statsObservers?: Array<{ client: BridgeClient; connectionId: string }>;
}

export interface WorkbenchWebSocketReloadDirtObserverState {
  client: BridgeClient;
  connectionId: string;
}

interface WorkbenchWebSocketTranscriptSubscriptionState {
  client: BridgeClient;
  connectionId: string;
  protocolVersion?: 1 | 2;
  subscriptionId: string;
  threadId: string;
  turnIds?: string[];
  turnLimit: number;
}

interface PendingRequest extends WorkbenchWebSocketPendingRequestState {
  timer: Timer | null;
}

export interface WorkbenchWebSocketRequestControllerOptions {
  clearTimeout?: (timer: Timer) => void;
  daemonRequests?: Pick<WorkbenchDaemonRequestController, "accepts" | "handle">;
  harnesses: Pick<WorkbenchHarnessController, "handleBrowserMessage" | "request" | "resolveHarness">;
  initialState?: WorkbenchWebSocketRequestControllerState;
  now?: () => number;
  reload: Pick<
    WorkbenchOrchestratorReloadController,
    "getReloadDirtSnapshot" | "subscribeReloadDirt"
  >;
  stats?: Pick<WorkbenchStatsController, "subscribeImportProgress">;
  setTimeout?: (callback: () => void, delayMs: number) => Timer;
  threadState: Pick<WorkbenchThreadStateController, "acceptIntent" | "disconnect" | "handleRequest">;
  transcript: Pick<OrchestratorTranscriptRegistration, "read" | "subscribe" | "unsubscribe">;
  transcriptShadowLog?: OrchestratorTranscriptShadowLog;
  writeLine?: (line: string) => void;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function formatBytes(value: number) {
  if (value < 1_024) return `${Math.max(0, Math.round(value))}B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)}KB`;
  return `${(value / 1_024 / 1_024).toFixed(1)}MB`;
}

function formatDuration(value: number) {
  const duration = Math.max(0, value);
  return duration < 1_000 ? `${Math.round(duration)}ms` : `${(duration / 1_000).toFixed(1)}s`;
}

function completionToken(outcome: CompletionOutcome) {
  const color = outcome === "ok" ? ANSI_GREEN : ANSI_RED;
  return `${color}${outcome}${ANSI_RESET}`;
}

function pendingToken() {
  return `${ANSI_YELLOW}pending${ANSI_RESET}`;
}

function methodLabel(harness: WorkbenchHarness | "unknown" | "workbench", method: string) {
  if (harness !== "workbench") return `${harness}:${method}`;
  return `wb:${method.startsWith("workbench/") ? method.slice("workbench/".length) : method}`;
}

function readResponseId(message: unknown): RequestId | undefined {
  const record = asRecord(message);
  const id = record?.id;
  if (id === null || typeof id === "number" || typeof id === "string") return id as RequestId;
  return undefined;
}

function responseIsError(message: unknown) {
  const record = asRecord(message);
  return Boolean(record && "error" in record && record.error !== undefined);
}

function readResponseErrorMessage(message: unknown) {
  const error = asRecord(asRecord(message)?.error);
  const rawMessage = typeof error?.message === "string" ? error.message : "";
  return rawMessage.trim() ? rawMessage : null;
}

export default class WorkbenchWebSocketRequestController {
  private detached = false;
  private readonly harnesses: WorkbenchWebSocketRequestControllerOptions["harnesses"];
  private readonly daemonRequests: NonNullable<WorkbenchWebSocketRequestControllerOptions["daemonRequests"]>;
  private readonly now: NonNullable<WorkbenchWebSocketRequestControllerOptions["now"]>;
  private readonly pending = new Map<BridgeClient, Map<RequestId, PendingRequest>>();
  private readonly reload: WorkbenchWebSocketRequestControllerOptions["reload"];
  private readonly reloadDirtObservers = new Map<string, WorkbenchWebSocketReloadDirtObserverState>();
  private reloadDirtRevision: number;
  private unsubscribeReloadDirt: (() => void) | null = null;
  private readonly schedule: NonNullable<WorkbenchWebSocketRequestControllerOptions["setTimeout"]>;
  private readonly cancel: NonNullable<WorkbenchWebSocketRequestControllerOptions["clearTimeout"]>;
  private readonly stream: WorkbenchWebSocketStreamController;
  private readonly threadState: WorkbenchWebSocketRequestControllerOptions["threadState"];
  private readonly transcript: WorkbenchWebSocketRequestControllerOptions["transcript"];
  private readonly transcriptShadowLog: WorkbenchWebSocketRequestControllerOptions["transcriptShadowLog"];
  private readonly transcriptSubscriptions = new Map<string, WorkbenchWebSocketTranscriptSubscriptionState>();
  private readonly transcriptCapabilitiesAnnounced = new WeakSet<BridgeClient>();
  private readonly statsObservers = new Map<string, { client: BridgeClient; connectionId: string }>();
  private unsubscribeStats: (() => void) | null = null;
  private readonly writeLine: NonNullable<WorkbenchWebSocketRequestControllerOptions["writeLine"]>;

  constructor({
    clearTimeout: cancel = clearTimeout,
    daemonRequests = {
      accepts: () => false,
      handle: async (request) => ({ id: request.id ?? null, error: { code: -32601, message: "Daemon method not found." } }),
    },
    harnesses,
    initialState,
    now = Date.now,
    reload,
    setTimeout: schedule = setTimeout,
    stats,
    threadState,
    transcript,
    transcriptShadowLog,
    writeLine = (line) => process.stdout.write(`${line}\n`),
  }: WorkbenchWebSocketRequestControllerOptions) {
    this.cancel = cancel;
    this.daemonRequests = daemonRequests;
    this.harnesses = harnesses;
    this.now = now;
    this.reload = reload;
    this.reloadDirtRevision = initialState?.reloadDirtRevision ?? 0;
    for (const observer of initialState?.reloadDirtObservers ?? []) {
      this.reloadDirtObservers.set(observer.connectionId, observer);
    }
    this.schedule = schedule;
    this.stream = new WorkbenchWebSocketStreamController({
      clearTimeout: cancel,
      initialState: initialState?.stream,
      now,
      setTimeout: schedule,
      writeLine,
    });
    this.threadState = threadState;
    this.transcript = transcript;
    this.transcriptShadowLog = transcriptShadowLog;
    this.writeLine = writeLine;
    for (const state of initialState?.pending ?? []) this.restorePending(state);
    for (const observer of initialState?.statsObservers ?? []) this.statsObservers.set(observer.connectionId, observer);
    if (stats) this.unsubscribeStats = stats.subscribeImportProgress((progress) => {
      for (const observer of this.statsObservers.values()) {
        void this.sendJsonToClient(observer.client, {
          method: WORKBENCH_STATS_IMPORT_UPDATED_METHOD,
          params: progress,
        }).catch((error: unknown) => {
          this.writeLine(`[stats-import] ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    });
  }

  async start() {
    this.unsubscribeReloadDirt = this.reload.subscribeReloadDirt(() => this.publishReloadDirt());
    if (this.reloadDirtObservers.size) this.publishReloadDirt();
  }

  async handleMessage(client: BridgeClient, connectionId: string, data: Buffer, hardReloadPending: boolean) {
    this.assertActive();
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(data.toString()) as JsonRpcRequest;
    } catch {
      client.close(1003, "Invalid JSON.");
      return;
    }
    const method = typeof message.method === "string" && message.method ? message.method : null;
    if (!method) throw new Error("Workbench WebSocket message is missing a method.");
    this.stream.connect(client);

    if (method === WORKBENCH_EVENT_STREAM_ACK_METHOD) {
      const acknowledgement = WorkbenchEventStreamAckSchema.safeParse(message);
      if (acknowledgement.success) this.stream.acknowledge(client, acknowledgement.data.params.sequence);
      else this.stream.reportInvalidAcknowledgement();
      return;
    }

    const requestId = "id" in message ? message.id : undefined;
    const isRequest = requestId === null || typeof requestId === "number" || typeof requestId === "string";
    const transcriptRequest = decodeWorkbenchTranscriptRequest(method, message.params);
    const daemonRequest = this.daemonRequests.accepts(method);
    const workbenchRequest = daemonRequest || method.startsWith("workbench/thread-state/")
      || method === WORKBENCH_RELOAD_DIRT_READ_METHOD
      || transcriptRequest !== null;
    let harness: WorkbenchHarness | "unknown" | "workbench" = workbenchRequest ? "workbench" : "unknown";
    if (!workbenchRequest) {
      try {
        harness = this.harnesses.resolveHarness(message[WORKBENCH_HARNESS_FIELD], { defaultToCodex: true });
      } catch (error) {
        if (!isRequest) throw error;
        this.beginRequest(client, requestId, data.length, methodLabel("unknown", method), method);
        await this.sendJsonToClient(client, {
          id: requestId,
          error: { code: -32000, message: error instanceof Error ? error.message : "Harness bridge request failed." },
        });
        return;
      }
    }
    if (isRequest) this.beginRequest(client, requestId, data.length, methodLabel(harness, method), method);

    if (hardReloadPending) {
      if (isRequest) {
        await this.sendJsonToClient(client, {
          id: requestId,
          error: { code: -32000, message: "The orchestrator is hard reloading; reconnect shortly." },
        });
      }
      return;
    }

    await this.announceTranscriptCapabilities(client);

    if (workbenchRequest && isRequest) {
      if (daemonRequest) {
        if (method === "stats/import/start") this.statsObservers.set(connectionId, { client, connectionId });
        await this.sendJsonToClient(client, await this.daemonRequests.handle(message));
        return;
      }
      if (method === WORKBENCH_RELOAD_DIRT_READ_METHOD) {
        const params = asRecord(message.params);
        if (params === null || Object.keys(params).length !== 0) {
          await this.sendJsonToClient(client, { id: requestId, error: { code: -32000, message: "Invalid Workbench reload dirt request." } });
          return;
        }
        this.reloadDirtObservers.set(connectionId, { client, connectionId });
        await this.sendJsonToClient(client, {
          id: requestId,
          result: {
            revision: this.reloadDirtRevision,
            snapshot: this.reload.getReloadDirtSnapshot(),
          },
        });
        return;
      }
      if (transcriptRequest) {
        try {
          if ("message" in transcriptRequest) throw new Error(transcriptRequest.message);
          const result = await this.handleTranscriptRequest(client, connectionId, transcriptRequest.data);
          await this.sendJsonToClient(client, { id: requestId, result });
        } catch (error) {
          await this.sendJsonToClient(client, {
            id: requestId,
            error: {
              code: -32000,
              message: error instanceof Error ? error.message : "Transcript request failed.",
            },
          });
        }
        return;
      }
      if (method === "workbench/thread-state/accepted") {
        const params = asRecord(message.params) ?? {};
        try {
          const acceptedHarness = this.harnesses.resolveHarness(params.harness);
          const projectId = typeof params.projectId === "string" ? params.projectId.trim() : "";
          const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
          const turnId = typeof params.turnId === "string" ? params.turnId.trim() : "";
          if (!projectId || !threadId || !turnId) throw new Error("Invalid accepted-intent lifecycle evidence.");
          const result = await this.threadState.acceptIntent(connectionId, { harness: acceptedHarness, projectId, threadId, turnId });
          await this.sendJsonToClient(client, { id: requestId, result });
        } catch (error) {
          await this.sendJsonToClient(client, { id: requestId, error: { code: -32000, message: error instanceof Error ? error.message : "Accepted-intent publication failed." } });
        }
        return;
      }
      const result = await this.threadState.handleRequest(connectionId, { method, ...(asRecord(message.params) ?? {}) });
      await this.sendJsonToClient(client, { id: requestId, ...result });
      return;
    }

    const strippedMessage = { ...message };
    delete strippedMessage[WORKBENCH_HARNESS_FIELD];
    try {
      await this.harnesses.handleBrowserMessage(harness, strippedMessage, client);
    } catch (error) {
      if (!isRequest) throw error;
      await this.sendJsonToClient(client, { id: requestId, error: { code: -32000, message: error instanceof Error ? error.message : "Harness bridge request failed." } });
    }
  }

  async sendJsonToClient(client: BridgeClient, message: unknown) {
    this.assertActive();
    const streamEvent = this.stream.prepareDelivery(client, message);
    const deliveryMessage = streamEvent?.message ?? message;
    const responseId = readResponseId(message);
    const pending = responseId === undefined ? null : this.pending.get(client)?.get(responseId) ?? null;
    const responseErrorMessage = readResponseErrorMessage(message);
    const serializeStartedAt = this.now();
    let serialized: string;
    try {
      const value = JSON.stringify(deliveryMessage);
      if (typeof value !== "string") throw new Error("Workbench WebSocket message did not serialize to JSON.");
      serialized = value;
    } catch (error) {
      if (streamEvent) this.stream.abandonDelivery(streamEvent);
      if (pending) this.complete(pending, "error", serializeStartedAt - pending.startedAt, this.now() - serializeStartedAt, 0, 0);
      throw error;
    }
    const serializedAt = this.now();
    const processMs = pending ? serializeStartedAt - pending.startedAt : 0;
    const jsonMs = serializedAt - serializeStartedAt;
    const outBytes = Buffer.byteLength(serialized);
    if (client.readyState !== client.OPEN) {
      if (streamEvent) this.stream.abandonDelivery(streamEvent);
      if (pending) this.complete(pending, "closed", processMs, jsonMs, 0, outBytes);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const sentAt = this.now();
      const finish = (error?: Error) => {
        if (error && streamEvent) this.stream.failDelivery(streamEvent);
        if (pending) {
          this.complete(
            pending,
            error ? "send-error" : responseIsError(message) ? "error" : "ok",
            processMs,
            jsonMs,
            this.now() - sentAt,
            outBytes,
            error ? null : responseErrorMessage,
          );
        }
        if (error) reject(error);
        else resolve();
      };
      try {
        if (streamEvent) this.stream.commitDelivery(streamEvent, outBytes);
        client.send(serialized, finish);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async disconnect(client: BridgeClient, connectionId: string) {
    this.assertActive();
    const requests = [...(this.pending.get(client)?.values() ?? [])];
    for (const request of requests) this.complete(request, "closed", this.now() - request.startedAt, 0, 0, 0);
    this.stream.disconnect(client);
    this.reloadDirtObservers.delete(connectionId);
    this.statsObservers.delete(connectionId);
    this.unsubscribeTranscriptConnection(connectionId);
    await this.threadState.disconnect(connectionId);
  }

  readEventStreamHealth(): WorkbenchEventStreamHealth {
    this.assertActive();
    return this.stream.readEventStreamHealth();
  }

  detachForReload(): WorkbenchWebSocketRequestControllerState {
    this.assertActive();
    this.detached = true;
    const pending = [...this.pending.values()].flatMap((requests) => [...requests.values()].map((request) => {
      if (request.timer) this.cancel(request.timer);
      const { timer: _timer, ...state } = request;
      return state;
    }));
    this.pending.clear();
    for (const { connectionId, subscriptionId } of this.transcriptSubscriptions.values()) {
      this.transcript.unsubscribe(this.transcriptSubscriptionKey(connectionId, subscriptionId));
    }
    this.transcriptSubscriptions.clear();
    this.unsubscribeReloadDirt?.();
    this.unsubscribeReloadDirt = null;
    this.unsubscribeStats?.();
    this.unsubscribeStats = null;
    return {
      pending,
      reloadDirtObservers: [...this.reloadDirtObservers.values()],
      reloadDirtRevision: this.reloadDirtRevision,
      stream: this.stream.detachForReload(),
      statsObservers: [...this.statsObservers.values()],
    };
  }

  dispose() {
    if (this.detached) return;
    this.detached = true;
    for (const requests of this.pending.values()) {
      for (const request of requests.values()) if (request.timer) this.cancel(request.timer);
    }
    this.pending.clear();
    for (const { connectionId, subscriptionId } of this.transcriptSubscriptions.values()) {
      this.transcript.unsubscribe(this.transcriptSubscriptionKey(connectionId, subscriptionId));
    }
    this.transcriptSubscriptions.clear();
    this.unsubscribeReloadDirt?.();
    this.unsubscribeReloadDirt = null;
    this.reloadDirtObservers.clear();
    this.statsObservers.clear();
    this.unsubscribeStats?.();
    this.unsubscribeStats = null;
    this.stream.dispose();
  }

  private async handleTranscriptRequest(
    client: BridgeClient,
    connectionId: string,
    request: WorkbenchTranscriptRequest,
  ) {
    if (request.kind === "read") {
      return {
        snapshot: transcriptSnapshotForProtocol(await this.transcript.read(request.params), request.params.protocolVersion),
      };
    }
    if (request.kind === "reportConformance") {
      this.transcriptShadowLog?.write({
        event: "conformance-mismatch",
        fields: {
          issues: request.params.issues.map((issue) => ({
            code: issue.code,
            path: [...issue.path],
          })),
          method: request.params.method,
          repairedPaths: request.params.repairedPaths.map((path) => [...path]),
        },
        level: "warning",
        source: "workbench-transcript-conformance",
      });
      return { reported: true };
    }
    if (request.kind === "reportParity") {
      this.transcriptShadowLog?.write({
        event: "parity-mismatch",
        fields: {
          jsonContext: request.params.jsonContext.map((entry) => ({ ...entry })),
          mismatch: request.params.mismatch,
          scope: request.params.scope,
          sqliteContext: request.params.sqliteContext.map((entry) => ({ ...entry })),
        },
        level: "warning",
        source: "workbench-transcript-parity",
        threadId: request.params.threadId,
      });
      return { reported: true };
    }
    const { subscriptionId } = request.params;
    const key = this.transcriptSubscriptionKey(connectionId, subscriptionId);
    if (request.kind === "unsubscribe") {
      this.transcript.unsubscribe(key);
      this.transcriptSubscriptions.delete(key);
      return { unsubscribed: true };
    }
    await this.subscribeTranscript({
      client,
      connectionId,
      protocolVersion: request.params.protocolVersion,
      subscriptionId,
      threadId: request.params.threadId,
      turnIds: request.params.turnIds,
      turnLimit: request.params.turnLimit,
    });
    return { subscribed: true };
  }

  private async announceTranscriptCapabilities(client: BridgeClient) {
    if (this.transcriptCapabilitiesAnnounced.has(client)) return;
    await this.sendJsonToClient(client, {
      method: workbenchTranscriptNotifications.capabilities.method,
      params: { protocolVersion: WORKBENCH_TRANSCRIPT_PROTOCOL_VERSION },
    });
    this.transcriptCapabilitiesAnnounced.add(client);
  }

  private async subscribeTranscript(subscription: WorkbenchWebSocketTranscriptSubscriptionState) {
    const key = this.transcriptSubscriptionKey(subscription.connectionId, subscription.subscriptionId);
    this.transcriptSubscriptions.set(key, subscription);
    try {
      if (subscription.turnIds) {
        const response = await this.harnesses.request("codex", {
          id: `workbench:transcript:materialize:${key}`,
          method: "workbench/transcript/materialize",
          params: {
            threadId: subscription.threadId,
            turnIds: subscription.turnIds,
          },
        });
        if (response.error) {
          throw new Error(response.error.message);
        }
        if (this.detached || this.transcriptSubscriptions.get(key) !== subscription) return;
      }
      await this.transcript.subscribe({
        id: key,
        request: {
          threadId: subscription.threadId,
          turnIds: subscription.turnIds,
          turnLimit: subscription.turnLimit,
        },
        publish: async (snapshot) => {
          if (this.detached || this.transcriptSubscriptions.get(key) !== subscription) return;
          await this.sendJsonToClient(subscription.client, {
            method: workbenchTranscriptNotifications.updated.method,
            params: {
              stream: "workbench:transcript",
              subscriptionId: subscription.subscriptionId,
              snapshot: transcriptSnapshotForProtocol(snapshot, subscription.protocolVersion),
            },
          });
        },
      });
    } catch (error) {
      if (this.transcriptSubscriptions.get(key) === subscription) {
        this.transcriptSubscriptions.delete(key);
        this.transcript.unsubscribe(key);
      }
      throw error;
    }
  }

  private unsubscribeTranscriptConnection(connectionId: string) {
    for (const [key, subscription] of this.transcriptSubscriptions) {
      if (subscription.connectionId !== connectionId) continue;
      this.transcript.unsubscribe(key);
      this.transcriptSubscriptions.delete(key);
    }
  }

  private transcriptSubscriptionKey(connectionId: string, subscriptionId: string) {
    return `${connectionId}\0${subscriptionId}`;
  }

  private publishReloadDirt() {
    this.reloadDirtRevision += 1;
    const envelope = {
      revision: this.reloadDirtRevision,
      snapshot: this.reload.getReloadDirtSnapshot(),
    };
    for (const observer of this.reloadDirtObservers.values()) {
      void this.sendJsonToClient(observer.client, {
        method: WORKBENCH_RELOAD_DIRT_UPDATED_METHOD,
        params: envelope,
      }).catch((error: unknown) => {
        this.writeLine(`[orchestrator-reload-dirt] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      });
    }
  }

  private beginRequest(client: BridgeClient, id: RequestId, inBytes: number, label: string, method: string) {
    let requests = this.pending.get(client);
    if (!requests) {
      requests = new Map();
      this.pending.set(client, requests);
    }
    const existing = requests.get(id);
    if (existing) this.complete(existing, "replaced", this.now() - existing.startedAt, 0, 0, 0);
    const startedAt = this.now();
    const request: PendingRequest = {
      client,
      id,
      inBytes,
      method: label,
      nextWarningAt: startedAt + (PENDING_THRESHOLD_OVERRIDES.get(method) ?? DEFAULT_PENDING_THRESHOLD_MS),
      startedAt,
      timer: null,
    };
    requests.set(id, request);
    this.scheduleWarning(request);
  }

  private restorePending(state: WorkbenchWebSocketPendingRequestState) {
    let requests = this.pending.get(state.client);
    if (!requests) {
      requests = new Map();
      this.pending.set(state.client, requests);
    }
    const request = { ...state, timer: null } satisfies PendingRequest;
    requests.set(state.id, request);
    this.scheduleWarning(request);
  }

  private scheduleWarning(request: PendingRequest) {
    request.timer = this.schedule(() => {
      request.timer = null;
      if (this.detached || this.pending.get(request.client)?.get(request.id) !== request) return;
      const now = this.now();
      this.writeLine(` WS ${request.method} ${pendingToken()} after ${formatDuration(now - request.startedAt)}`);
      request.nextWarningAt = now + PENDING_WARNING_INTERVAL_MS;
      this.scheduleWarning(request);
    }, Math.max(0, request.nextWarningAt - this.now()));
  }

  private complete(
    request: PendingRequest,
    outcome: CompletionOutcome,
    processMs: number,
    jsonMs: number,
    sendMs: number,
    outBytes: number,
    errorMessage: string | null = null,
  ) {
    if (request.timer) this.cancel(request.timer);
    const requests = this.pending.get(request.client);
    if (requests?.get(request.id) === request) requests.delete(request.id);
    if (requests?.size === 0) this.pending.delete(request.client);
    const totalMs = this.now() - request.startedAt;
    const detail = dimWebSocketDetail(`(process: ${formatDuration(processMs)}, json: ${formatDuration(jsonMs)}, send: ${formatDuration(sendMs)}, in: ${formatBytes(request.inBytes)}, out: ${formatBytes(outBytes)})`);
    this.writeLine(` WS ${request.method} ${completionToken(outcome)} in ${formatDuration(totalMs)} ${detail}`);
    if (errorMessage) this.writeLine(` WS ${request.method} ${ANSI_RED}${errorMessage}${ANSI_RESET}`);
  }

  private assertActive() {
    if (this.detached) throw new Error("Workbench WebSocket request controller is detached.");
  }
}
