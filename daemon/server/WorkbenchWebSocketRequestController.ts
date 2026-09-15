/*
 * Exports:
 * - WorkbenchWebSocketPendingRequestState: transferable browser request timing.
 * - WorkbenchWebSocketDelivery: physical send receipt for the current graph owner.
 * - WorkbenchWebSocketReloadDirtObserverState: reload-dirt subscriber identity.
 * - WorkbenchWebSocketRequestControllerState: request, observer, and stream handoff.
 * - WorkbenchWebSocketRequestControllerOptions: routing, clock, scheduler, and logging ports.
 * - default WorkbenchWebSocketRequestController: route feature requests and own event-stream health.
 */
import type { WorkbenchHarness } from "workbench-shared/types";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";
import {
  NativeThreadIdSchema,
  NativeTurnIdSchema,
  ProjectIdSchema,
  ThreadReferenceSchema,
  TurnReferenceSchema,
  type NativeThreadId,
  type NativeTurnId,
} from "workbench-shared/workbench/identity";
import {
  WORKBENCH_RELOAD_DIRT_READ_METHOD,
  WORKBENCH_RELOAD_DIRT_UPDATED_METHOD,
} from "workbench-shared/workbench/daemon-reload";
import {
  decodeWorkbenchTranscriptRequest,
  WORKBENCH_TRANSCRIPT_PROTOCOL_VERSION,
  type WorkbenchTranscriptRequest,
  workbenchTranscriptNotifications,
} from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import type {
  DaemonTranscriptRegistration,
} from "./daemon-runtime-objects";
import {
  WORKBENCH_EVENT_STREAM_ACK_METHOD,
  WorkbenchEventStreamAckSchema,
  type WorkbenchEventStreamHealth,
} from "workbench-shared/workbench/websocket-stream";
import type { BridgeClient, JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type { ServerNotification } from "workbench-shared/codex/generated/app-server/ServerNotification";
import {
  mapNativeProviderResponse, mapNativeThreadStateSnapshot, mapNativeThreadStateResult,
  mapWorkbenchThreadStateRequest,
  type NativeThreadStateIdentityOwners,
} from "./thread-identity-workbench-mapping";
import { mapProviderNotification } from "./thread-identity-provider-mapping";
import type { NativeTranscriptIdentityOwners } from "./thread-identity-transcript-mapping";
import { WorkbenchThreadStateRequestSchema, type WorkbenchThreadStateSnapshot } from "workbench-shared/workbench/thread/thread-state";
import type WorkbenchHarnessController from "./WorkbenchHarnessController";
import type WorkbenchDaemonRequestController from "./WorkbenchDaemonRequestController";
import type WorkbenchDaemonReloadController from "./WorkbenchDaemonReloadController";
import type WorkbenchThreadStateController from "./WorkbenchThreadStateController";
import type WorkbenchStatsController from "./stats/WorkbenchStatsController";
import { WORKBENCH_STATS_IMPORT_UPDATED_METHOD } from "workbench-shared/workbench/stats/workbench-stats-contract";
import WorkbenchWebSocketStreamController, {
  type WorkbenchWebSocketStreamControllerState,
} from "./WorkbenchWebSocketStreamController";
import WorkbenchWebSocketEventLog from "./WorkbenchWebSocketEventLog";
import { dimWebSocketDetail, formatWebSocketBytes as formatBytes, formatWebSocketSendFailure, webSocketMethodLabel as methodLabel } from "./websocket-log-format";
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
  identity?: object;
  client: BridgeClient;
  id: RequestId;
  inBytes: number;
  method: string;
  nextWarningAt: number;
  startedAt: number;
  provider?: { harness: WorkbenchHarness; request: JsonRpcRequest };
}

export interface WorkbenchWebSocketDelivery {
  client: BridgeClient;
  request?: { id: RequestId; identity: object };
  streamEvent: ReturnType<WorkbenchWebSocketStreamController["prepareDelivery"]>;
  eventMethod: string | null;
  eventHarness: WorkbenchHarness | "workbench" | "unknown";
  outcome: CompletionOutcome;
  processMs: number;
  jsonMs: number;
  sendMs: number;
  outBytes: number;
  errorMessage: string | null;
}

export interface WorkbenchWebSocketRequestControllerState {
  pending: WorkbenchWebSocketPendingRequestState[];
  reloadDirtObservers?: WorkbenchWebSocketReloadDirtObserverState[];
  reloadDirtRevision?: number;
  stream?: WorkbenchWebSocketStreamControllerState;
  statsObservers?: Array<{ client: BridgeClient; connectionId: string }>;
  transcriptSubscriptions?: WorkbenchWebSocketTranscriptSubscriptionState[];
}

export interface WorkbenchWebSocketReloadDirtObserverState {
  client: BridgeClient;
  connectionId: string;
}

interface WorkbenchWebSocketTranscriptSubscriptionState {
  client: BridgeClient;
  connectionId: string;
  protocolVersion?: 1 | 2 | 3;
  subscriptionId: string;
  threadId: string;
  turnIds?: string[];
  turnLimit: number;
}

interface PendingRequest extends WorkbenchWebSocketPendingRequestState {
  identity: object;
  timer: Timer | null;
}

export interface WorkbenchWebSocketRequestControllerOptions {
  acceptProviderIntent?: (input: {
    harness: WorkbenchHarness;
    nativeThreadId: NativeThreadId;
    nativeTurnId: NativeTurnId;
  }) => Promise<void>;
  reportDelivery: (delivery: WorkbenchWebSocketDelivery) => void;
  clearTimeout?: (timer: Timer) => void;
  daemonRequests?: Pick<WorkbenchDaemonRequestController, "accepts" | "handle">;
  harnesses: Pick<WorkbenchHarnessController, "handleNativeBrowserMessage" | "resolvePublicRequest" | "request" | "resolveHarness">
    & Partial<Pick<WorkbenchHarnessController, "resolveThreadIdentity" | "resolveTurnIdentity">>;
  identities?: NativeTranscriptIdentityOwners;
  initialState?: WorkbenchWebSocketRequestControllerState;
  now?: () => number;
  reload: Pick<
    WorkbenchDaemonReloadController,
    "getReloadDirtSnapshot" | "subscribeReloadDirt"
  >;
  stats?: Pick<WorkbenchStatsController, "subscribeImportProgress">;
  setTimeout?: (callback: () => void, delayMs: number) => Timer;
  threadState: Pick<WorkbenchThreadStateController, "acceptIntent" | "disconnect" | "handleRequest">;
  transcript: Pick<DaemonTranscriptRegistration, "read" | "subscribe" | "unsubscribe">;
  writeLine?: (line: string) => void;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readAcceptedProviderIntent(
  pending: PendingRequest,
  response: unknown,
): Parameters<NonNullable<WorkbenchWebSocketRequestControllerOptions["acceptProviderIntent"]>>[0] | null {
  const provider = pending.provider;
  const envelope = asRecord(response);
  if (!provider || !envelope || responseIsError(response)) return null;
  const params = asRecord(provider.request.params);
  const result = asRecord(envelope.result);
  if (!params || !result || typeof params.threadId !== "string") return null;
  let nativeTurnId: string | null = null;
  if (provider.request.method === "turn/start") {
    const turn = asRecord(result.turn);
    nativeTurnId = typeof turn?.id === "string" ? turn.id : null;
  } else if (provider.request.method === "turn/steer") {
    nativeTurnId = typeof result.turnId === "string"
      ? result.turnId
      : typeof params.expectedTurnId === "string" ? params.expectedTurnId : null;
  } else if (provider.request.method === "workbench/codex/message/admit") {
    if (result.kind === "started") {
      const turn = asRecord(result.turn);
      nativeTurnId = typeof turn?.id === "string" ? turn.id : null;
    } else if (result.kind === "steered") {
      nativeTurnId = typeof result.turnId === "string" ? result.turnId : null;
    }
  }
  if (!nativeTurnId) return null;
  return {
    harness: provider.harness,
    nativeThreadId: NativeThreadIdSchema.parse(params.threadId),
    nativeTurnId: NativeTurnIdSchema.parse(nativeTurnId),
  };
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
  private readonly acceptProviderIntent: NonNullable<WorkbenchWebSocketRequestControllerOptions["acceptProviderIntent"]>;
  private lifecycle: "active" | "suspended" | "disposed" = "active";
  private get detached() { return this.lifecycle !== "active"; }
  private generation = new AbortController();
  private readonly reportDelivery: WorkbenchWebSocketRequestControllerOptions["reportDelivery"];
  private readonly eventLog: WorkbenchWebSocketEventLog;
  private readonly harnesses: WorkbenchWebSocketRequestControllerOptions["harnesses"];
  private readonly identities: WorkbenchWebSocketRequestControllerOptions["identities"];
  private readonly threadStateIdentities: NativeThreadStateIdentityOwners | undefined;
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
  private readonly transcriptSubscriptions = new Map<string, WorkbenchWebSocketTranscriptSubscriptionState>();
  private readonly transcriptCapabilitiesAnnounced = new WeakSet<BridgeClient>();
  private readonly statsObservers = new Map<string, { client: BridgeClient; connectionId: string }>();
  private unsubscribeStats: (() => void) | null = null;
  private readonly stats: WorkbenchWebSocketRequestControllerOptions["stats"];
  private readonly writeLine: NonNullable<WorkbenchWebSocketRequestControllerOptions["writeLine"]>;

  constructor({
    acceptProviderIntent = async () => {},
    clearTimeout: cancel = clearTimeout,
    daemonRequests = {
      accepts: () => false,
      handle: async (request) => ({ id: request.id ?? null, error: { code: -32601, message: "Daemon method not found." } }),
    },
    harnesses,
    identities,
    initialState,
    now = Date.now,
    reload,
    reportDelivery,
    setTimeout: schedule = setTimeout,
    stats,
    threadState,
    transcript,
    writeLine = (line) => process.stdout.write(`${line}\n`),
  }: WorkbenchWebSocketRequestControllerOptions) {
    this.acceptProviderIntent = acceptProviderIntent;
    this.cancel = cancel;
    this.eventLog = new WorkbenchWebSocketEventLog({ clearTimeout: cancel, now, setTimeout: schedule, writeLine });
    this.daemonRequests = daemonRequests;
    this.harnesses = harnesses;
    this.identities = identities;
    this.threadStateIdentities = identities ? {
      ...identities,
      ...(harnesses.resolveThreadIdentity ? { resolveThreadIdentity: harnesses.resolveThreadIdentity.bind(harnesses) } : {}),
      ...(harnesses.resolveTurnIdentity ? { resolveTurnIdentity: harnesses.resolveTurnIdentity.bind(harnesses) } : {}),
    } : undefined;
    this.now = now;
    this.reload = reload;
    this.reportDelivery = reportDelivery;
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
    this.writeLine = writeLine;
    this.stats = stats;
    for (const state of initialState?.pending ?? []) this.restorePending(state);
    for (const observer of initialState?.statsObservers ?? []) this.statsObservers.set(observer.connectionId, observer);
    for (const subscription of initialState?.transcriptSubscriptions ?? []) {
      this.transcriptSubscriptions.set(this.transcriptSubscriptionKey(subscription.connectionId, subscription.subscriptionId), { ...subscription });
    }
    this.observeStats();
  }

  private observeStats() {
    if (this.unsubscribeStats || !this.stats) return;
    const signal = this.generation.signal;
    this.unsubscribeStats = this.stats.subscribeImportProgress((progress) => {
      if (signal.aborted) return;
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
    this.assertActive();
    if (this.unsubscribeReloadDirt) return;
    const signal = this.generation.signal;
    this.unsubscribeReloadDirt = this.reload.subscribeReloadDirt(() => {
      if (!signal.aborted) this.publishReloadDirt();
    });
    this.observeStats();
    if (this.reloadDirtObservers.size) this.publishReloadDirt();
  }

  async handleMessage(client: BridgeClient, connectionId: string, data: Buffer, hardReloadPending: boolean) {
    this.assertActive();
    const signal = this.generation.signal;
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
      this.eventLog.record("in", "workbench", method, data.length);
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
    else this.eventLog.record("in", harness, method, data.length);

    if (hardReloadPending) {
      if (isRequest) {
        await this.sendJsonToClient(client, {
          id: requestId,
          error: { code: -32000, message: "The daemon is hard reloading; reconnect shortly." },
        });
      }
      return;
    }

    await this.announceTranscriptCapabilities(client);
    signal.throwIfAborted();

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
          if (!this.identities) throw new Error("Accepted-intent identity resolution is unavailable.");
          const thread = await this.identities.threads.resolve({
            harness: acceptedHarness, projectId: ProjectIdSchema.parse(projectId),
            threadId: ThreadReferenceSchema.parse(threadId),
          });
          if (!thread) throw new Error("Accepted-intent thread does not belong to the requested project.");
          const turn = await this.identities.threads.resolveTurn({
            threadId: thread.threadId, turnId: TurnReferenceSchema.parse(turnId),
          });
          if (!turn) throw new Error("Accepted-intent turn does not belong to the requested thread.");
          signal.throwIfAborted();
          const result = await this.threadState.acceptIntent(connectionId, {
            harness: acceptedHarness, projectId: thread.projectId,
            threadId: thread.threadId, turnId: turn.turnId,
          });
          await this.sendJsonToClient(client, { id: requestId, result });
        } catch (error) {
          signal.throwIfAborted();
          await this.sendJsonToClient(client, { id: requestId, error: { code: -32000, message: error instanceof Error ? error.message : "Accepted-intent publication failed." } });
        }
        return;
      }
      try {
        const input = { method, ...(asRecord(message.params) ?? {}) };
        const parsed = WorkbenchThreadStateRequestSchema.safeParse(input);
        const request = this.identities && parsed.success ? await mapWorkbenchThreadStateRequest(this.identities, parsed.data) : input;
        signal.throwIfAborted();
        const result = await this.threadState.handleRequest(connectionId, request);
        await this.sendJsonToClient(client, { id: requestId, ...result,
          ...("result" in result && this.threadStateIdentities ? { result: await mapNativeThreadStateResult(this.threadStateIdentities, result.result) } : {}),
        });
      } catch (error) {
        signal.throwIfAborted();
        await this.sendJsonToClient(client, { id: requestId, error: { code: -32000, message: error instanceof Error ? error.message : "Thread state identity projection failed." } });
      }
      return;
    }

    const strippedMessage = { ...message };
    delete strippedMessage[WORKBENCH_HARNESS_FIELD];
    try {
      const resolved = await this.harnesses.resolvePublicRequest(harness, strippedMessage);
      signal.throwIfAborted();
      const pending = isRequest ? this.pending.get(client)?.get(requestId) : undefined;
      if (pending) pending.provider = resolved;
      await this.harnesses.handleNativeBrowserMessage(resolved.harness, resolved.request, client);
    } catch (error) {
      signal.throwIfAborted();
      if (!isRequest) throw error;
      await this.sendJsonToClient(client, { id: requestId, error: { code: -32000, message: error instanceof Error ? error.message : "Harness bridge request failed." } });
    }
  }

  reportSendFailure(message: unknown, error: unknown) {
    process.stderr.write(`${formatWebSocketSendFailure(message, error)}\n`);
  }

  completeDelivery(delivery: WorkbenchWebSocketDelivery) {
    this.assertActive();
    if (delivery.outcome === "send-error" && delivery.streamEvent) this.stream.failDelivery(delivery.streamEvent);
    if (delivery.outcome !== "send-error" && delivery.eventMethod) {
      this.eventLog.record("out", delivery.eventHarness, delivery.eventMethod, delivery.outBytes);
    }
    const pending = delivery.request ? this.pending.get(delivery.client)?.get(delivery.request.id) : undefined;
    if (pending && pending.identity === delivery.request?.identity) {
      this.complete(pending, delivery.outcome, delivery.processMs, delivery.jsonMs, delivery.sendMs, delivery.outBytes, delivery.errorMessage);
    }
  }

  async sendJsonToClient(client: BridgeClient, message: unknown) {
    this.assertActive();
    const signal = this.generation.signal;
    const envelope = asRecord(message);
    const eventMethod = typeof envelope?.method === "string" ? envelope.method : null;
    const eventHarness = envelope?.[WORKBENCH_HARNESS_FIELD];
    const responseId = readResponseId(message);
    const pending = responseId === undefined ? null : this.pending.get(client)?.get(responseId) ?? null;
    const acceptedProviderIntent = pending ? readAcceptedProviderIntent(pending, message) : null;
    if (this.identities) {
      if (pending?.provider) {
        try {
          message = await mapNativeProviderResponse(this.identities, pending.provider.harness, pending.provider.request, message as JsonRpcResponse);
          signal.throwIfAborted();
        } catch (error) {
          signal.throwIfAborted();
          const detail = (error instanceof Error ? error.message : "Public transcript identity projection failed.").slice(0, 500);
          this.writeLine(`[workbench-identity] ${detail}`);
          message = { id: pending.id, error: { code: -32000, message: detail } };
        }
      } else {
        if (envelope?.method === "workbench/thread-state/updated") {
          const source = envelope.params as WorkbenchThreadStateSnapshot;
          const params = await mapNativeThreadStateSnapshot(this.threadStateIdentities!, source);
          signal.throwIfAborted();
          message = { ...envelope, params };
        } else if (envelope?.[WORKBENCH_HARNESS_FIELD]) {
          const harness = this.harnesses.resolveHarness(envelope[WORKBENCH_HARNESS_FIELD]);
          const params = asRecord(envelope.params);
          const thread = asRecord(params?.thread);
          const threadId = typeof params?.threadId === "string" ? params.threadId : thread?.id;
          if (typeof threadId === "string") {
            const native = this.identities.threads.knownNativeBinding(harness, NativeThreadIdSchema.parse(threadId));
            message = mapProviderNotification(this.identities, native, message as ServerNotification);
          }
        }
      }
    }
    if (acceptedProviderIntent && !responseIsError(message)) {
      try {
        await this.acceptProviderIntent(acceptedProviderIntent);
      } catch (error) {
        const detail = (error instanceof Error ? error.message : "Provider intent lifecycle publication failed.").slice(0, 500);
        this.writeLine(`[thread-state] Provider accepted user input, but working lifecycle publication failed: ${detail}`);
      }
    }
    const streamEvent = this.stream.prepareDelivery(client, message);
    const deliveryMessage = streamEvent?.message ?? message;
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
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        try {
          this.reportDelivery({
            client,
            request: pending ? { id: pending.id, identity: pending.identity } : undefined,
            streamEvent,
            eventMethod,
            eventHarness: ProviderKeySchema.safeParse(eventHarness).success
              ? eventHarness as WorkbenchHarness : eventMethod?.startsWith("workbench/") ? "workbench" : "unknown",
            outcome: error ? "send-error" : responseIsError(message) ? "error" : "ok",
            processMs,
            jsonMs,
            sendMs: this.now() - sentAt,
            outBytes,
            errorMessage: error ? null : responseErrorMessage,
          });
        } catch (receiptError) {
          this.reportSendFailure({ method: "WebSocket delivery receipt" }, receiptError);
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
    this.suspend();
    const pending = [...this.pending.values()].flatMap((requests) => [...requests.values()].map((request) => {
      const { timer: _timer, ...state } = request;
      return state;
    }));
    return {
      pending,
      reloadDirtObservers: [...this.reloadDirtObservers.values()],
      reloadDirtRevision: this.reloadDirtRevision,
      stream: this.stream.detachForReload(),
      statsObservers: [...this.statsObservers.values()],
      transcriptSubscriptions: [...this.transcriptSubscriptions.values()].map((subscription) => ({ ...subscription })),
    };
  }

  suspend() {
    if (this.lifecycle !== "active") return;
    this.lifecycle = "suspended";
    this.generation.abort(new Error("Workbench WebSocket request generation retired."));
    this.eventLog.suspend();
    this.stream.suspend();
    for (const requests of this.pending.values()) for (const request of requests.values()) {
      if (request.timer) this.cancel(request.timer);
      request.timer = null;
    }
    for (const { connectionId, subscriptionId } of this.transcriptSubscriptions.values()) {
      this.transcript.unsubscribe(this.transcriptSubscriptionKey(connectionId, subscriptionId));
    }
    this.unsubscribeReloadDirt?.();
    this.unsubscribeReloadDirt = null;
    this.unsubscribeStats?.();
    this.unsubscribeStats = null;
  }

  async resumeAfterFailedReload() {
    if (this.lifecycle === "disposed") throw new Error("Workbench WebSocket request controller is disposed.");
    if (this.lifecycle === "active") return;
    this.lifecycle = "active";
    this.generation = new AbortController();
    this.eventLog.resumeAfterFailedReload();
    this.stream.resumeAfterFailedReload();
    for (const requests of this.pending.values()) for (const request of requests.values()) this.scheduleWarning(request);
    for (const subscription of this.transcriptSubscriptions.values()) {
      void this.subscribeTranscript(subscription, false).catch((error: unknown) => {
        this.writeLine(`[transcript] restore subscription failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`);
      });
    }
    await this.start();
  }

  dispose() {
    if (this.lifecycle === "disposed") return;
    this.suspend();
    this.lifecycle = "disposed";
    this.eventLog.dispose();
    for (const requests of this.pending.values()) {
      for (const request of requests.values()) if (request.timer) this.cancel(request.timer);
    }
    this.pending.clear();
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
      this.writeLine(`[workbench-transcript-conformance] ${JSON.stringify(request.params)}`);
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

  private async subscribeTranscript(subscription: WorkbenchWebSocketTranscriptSubscriptionState, materialise = true) {
    const signal = this.generation.signal;
    const key = this.transcriptSubscriptionKey(subscription.connectionId, subscription.subscriptionId);
    this.transcriptSubscriptions.set(key, subscription);
    try {
      if (materialise && subscription.turnIds) {
        const requests: JsonRpcRequest[] = [];
        if (this.identities) {
          const thread = await this.identities.threads.resolve({ threadId: ThreadReferenceSchema.parse(subscription.threadId) });
          signal.throwIfAborted();
          if (!thread) throw new Error("Transcript thread identity has not been admitted.");
          const groups = new Map<string, { threadId: string; turnIds: string[] }>();
          for (const turnId of subscription.turnIds) {
            const turn = await this.identities.threads.resolveTurn({ threadId: thread.threadId, turnId: TurnReferenceSchema.parse(turnId) });
            signal.throwIfAborted();
            if (!turn?.native.nativeTurnId || turn.native.harness !== "codex") throw new Error("Transcript turn has no Codex materialisation source.");
            const native = turn.native;
            const group = groups.get(native.nativeThreadId) ?? { threadId: native.nativeThreadId, turnIds: [] };
            group.turnIds.push(native.nativeTurnId);
            groups.set(native.nativeThreadId, group);
          }
          for (const params of groups.values()) requests.push({
            id: `workbench:transcript:materialize:${key}`,
            method: "workbench/transcript/materialize", params,
          });
        } else requests.push({
          id: `workbench:transcript:materialize:${key}`,
          method: "workbench/transcript/materialize",
          params: {
            threadId: subscription.threadId,
            turnIds: subscription.turnIds,
          },
        });
        for (const request of requests) {
          signal.throwIfAborted();
          const response = await this.harnesses.request("codex", request);
          signal.throwIfAborted();
          if (response.error) throw new Error(response.error.message);
          if (this.detached || this.transcriptSubscriptions.get(key) !== subscription) return;
        }
        if (this.detached || this.transcriptSubscriptions.get(key) !== subscription) return;
      }
      signal.throwIfAborted();
      await this.transcript.subscribe({
        id: key,
        request: {
          threadId: subscription.threadId,
          turnIds: subscription.turnIds,
          turnLimit: subscription.turnLimit,
        },
        publish: async (snapshot) => {
          if (signal.aborted || this.detached || this.transcriptSubscriptions.get(key) !== subscription) return;
          await this.sendJsonToClient(subscription.client, {
            method: workbenchTranscriptNotifications.updated.method,
            params: {
              stream: "workbench:transcript",
              subscriptionId: subscription.subscriptionId,
              snapshot: transcriptSnapshotForProtocol(snapshot, subscription.protocolVersion),
            },
          });
        },
        ...(subscription.protocolVersion === 3 ? {
          publishStream: (update: import("workbench-shared/workbench/transcript/thread-transcript-stream").TranscriptStreamUpdate) => {
            if (signal.aborted || this.detached || this.transcriptSubscriptions.get(key) !== subscription) return;
            void this.sendJsonToClient(subscription.client, {
              method: workbenchTranscriptNotifications.streamed.method,
              params: { subscriptionId: subscription.subscriptionId, update },
            }).catch(error => this.writeLine(`[transcript] stream publication failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`));
          },
        } : {}),
      });
    } catch (error) {
      if (!signal.aborted && this.transcriptSubscriptions.get(key) === subscription) {
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
        this.writeLine(`[daemon-reload-dirt] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
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
      identity: {},
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
    const request = { ...state, identity: state.identity ?? {}, timer: null } satisfies PendingRequest;
    requests.set(state.id, request);
    this.scheduleWarning(request);
  }

  private scheduleWarning(request: PendingRequest) {
    const timer = this.schedule(() => {
      if (request.timer !== timer) return;
      request.timer = null;
      if (this.detached || this.pending.get(request.client)?.get(request.id) !== request) return;
      const now = this.now();
      this.writeLine(` WS ${request.method} ${pendingToken()} after ${formatDuration(now - request.startedAt)}`);
      request.nextWarningAt = now + PENDING_WARNING_INTERVAL_MS;
      this.scheduleWarning(request);
    }, Math.max(0, request.nextWarningAt - this.now()));
    request.timer = timer;
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
