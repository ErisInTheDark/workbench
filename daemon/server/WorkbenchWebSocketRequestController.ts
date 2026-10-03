/*
 * Exports:
 * - WorkbenchWebSocketPendingRequestState: transferable browser request timing.
 * - WorkbenchWebSocketDelivery: physical send receipt for the current graph owner.
 * - WorkbenchWebSocketReloadDirtObserverState: reload-dirt subscriber identity.
 * - WorkbenchWebSocketRequestControllerState: request, observer, and stream handoff.
 * - WorkbenchWebSocketRequestControllerOptions: routing, clock, scheduler, and logging ports.
 * - default WorkbenchWebSocketRequestController: route feature requests, own event-stream health, and answer socket spy queries from recorded frames.
 */
import type { WorkbenchHarness } from "workbench-shared/types";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";
import {
  ProjectIdSchema,
  ThreadReferenceSchema,
  TurnReferenceSchema,
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
import type { BridgeClient, JsonRpcRequest } from "./bridge-types";
import { z } from "zod";
import { VoiceAudioSchema, VoiceConfigurationSchema, VoiceStartSchema } from "workbench-shared/workbench/voice/voice-session-contract";
import { REPO_RUNTIME_READ_METHOD } from "workbench-shared/workbench/repo/virtual-repo-contract";
import type { DaemonRuntimeObjects } from "./daemon-runtime-objects";
import {
  mapWorkbenchThreadStateRequest,
} from "./thread-identity-workbench-mapping";
import type { NativeTranscriptIdentityOwners } from "./thread-identity-transcript-mapping";
import { WorkbenchThreadStateRequestSchema } from "workbench-shared/workbench/thread/thread-state";
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
import {
  describeWebSocketEvent, formatWebSocketSendFailure, webSocketMethodLabel as methodLabel,
} from "./websocket-log-format";
import { dimWebSocketDetail, formatWebSocketBytes as formatBytes } from "workbench-shared/process/websocket-traffic-format";
import { transcriptSnapshotForProtocol } from "./database/transcript/transcript-wire-compatibility";
import WorkbenchWorkspaceObservationController, { type DaemonObservationChange } from "./WorkbenchWorkspaceObservationController";
import {
  DaemonWorkspaceObserveSchema, WorkspaceReleaseSchema,
  WORKSPACE_DELTA_METHOD, WORKSPACE_OBSERVE_METHOD, WORKSPACE_RELEASE_METHOD, WORKSPACE_UPDATED_METHOD,
  type DaemonWorkspaceObservation,
} from "workbench-shared/workbench/workspace/workspace-observation";
import { describeObservationDelta } from "workbench-shared/workbench/workspace/observation-patch";
import WebSocketTrafficBuffer, {
  WEBSOCKET_SPY_QUERY_METHOD, WEBSOCKET_SPY_RESULT_METHOD, WebSocketSpyResultNotificationSchema,
  type WebSocketTrafficQuery, type WebSocketTrafficResult,
} from "workbench-shared/process/WebSocketTrafficBuffer";
import { randomUUID } from "node:crypto";

const WORKBENCH_HARNESS_FIELD = "workbenchHarness";
/** A keyed delta for one busy thread is hundreds of bytes; pushes past this name themselves in the log. */
const WORKSPACE_PUSH_WARNING_BYTES = 32 * 1024;
const DEFAULT_PENDING_THRESHOLD_MS = 2_000;
/** Owner: socket spy. A local app answers from memory in milliseconds; past this the CLI reports it unanswered. */
const SPY_ANSWER_DEADLINE_MS = 2_000;
const PENDING_WARNING_INTERVAL_MS = 2_000;
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
}

export interface WorkbenchWebSocketDelivery {
  client: BridgeClient;
  request?: { id: RequestId; identity: object };
  streamEvent: ReturnType<WorkbenchWebSocketStreamController["prepareDelivery"]>;
  eventMethod: string | null;
  eventHarness: WorkbenchHarness | "workbench" | "unknown";
  /** The event inside the envelope, such as a workspace observation kind and its thread. */
  eventDetail?: string | null;
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
  workspaceInterests?: ReturnType<WorkbenchWorkspaceObservationController<BridgeClient>["captureInterests"]>;
}

export interface WorkbenchWebSocketReloadDirtObserverState {
  client: BridgeClient;
  connectionId: string;
}

interface WorkbenchWebSocketTranscriptSubscriptionState {
  client: BridgeClient;
  connectionId: string;
  protocolVersion?: 1 | 2 | 3 | 4;
  toolPatchPreviews?: boolean;
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
  workspace?: Omit<ConstructorParameters<typeof WorkbenchWorkspaceObservationController<BridgeClient>>[0], "publish" | "warn" | "reload">;
  voice?: DaemonRuntimeObjects["voice"];
  repo?: Pick<DaemonRuntimeObjects["repo"], "readAvailability">;
  reportDelivery: (delivery: WorkbenchWebSocketDelivery) => void;
  clearTimeout?: (timer: Timer) => void;
  daemonRequests?: Pick<WorkbenchDaemonRequestController, "accepts" | "handle">;
  threadActions?: Pick<import("./WorkbenchThreadActionController").default, "materialize">;
  harnesses: Pick<WorkbenchHarnessController, "resolveHarness">
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
  threadState: Pick<WorkbenchThreadStateController, "handleRequest">;
  transcript: Pick<DaemonTranscriptRegistration, "read" | "subscribe" | "unsubscribe">;
  writeLine?: (line: string) => void;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
  private readonly voice: DaemonRuntimeObjects["voice"] | undefined;
  private readonly repo: WorkbenchWebSocketRequestControllerOptions["repo"];
  private lifecycle: "active" | "suspended" | "disposed" = "active";
  private get detached() { return this.lifecycle !== "active"; }
  private generation = new AbortController();
  private readonly reportDelivery: WorkbenchWebSocketRequestControllerOptions["reportDelivery"];
  private readonly eventLog: WorkbenchWebSocketEventLog;
  private readonly harnesses: WorkbenchWebSocketRequestControllerOptions["harnesses"];
  private readonly identities: WorkbenchWebSocketRequestControllerOptions["identities"];
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
  private readonly workspaceOwners: WorkbenchWebSocketRequestControllerOptions["workspace"];
  private workspace: WorkbenchWorkspaceObservationController<BridgeClient> | null = null;
  private workspaceInterests: NonNullable<WorkbenchWebSocketRequestControllerState["workspaceInterests"]> = [];
  private readonly writeLine: NonNullable<WorkbenchWebSocketRequestControllerOptions["writeLine"]>;
  /** Recent frames for `wb socket spy`; memory only and reset with this reloadable owner. */
  private readonly traffic = new WebSocketTrafficBuffer();
  private readonly connectionIds = new Map<BridgeClient, string>();
  private readonly spyQueries = new Map<string, (result: WebSocketTrafficResult) => void>();

  constructor({
    voice,
    repo,
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
    workspace,
    writeLine = (line) => process.stdout.write(`${line}\n`),
  }: WorkbenchWebSocketRequestControllerOptions) {
    this.voice = voice;
    this.repo = repo;
    this.cancel = cancel;
    this.eventLog = new WorkbenchWebSocketEventLog({ clearTimeout: cancel, now, setTimeout: schedule, writeLine });
    this.daemonRequests = daemonRequests;
    this.harnesses = harnesses;
    this.identities = identities;
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
    this.workspaceOwners = workspace;
    this.workspaceInterests = initialState?.workspaceInterests ?? [];
    for (const state of initialState?.pending ?? []) this.restorePending(state);
    for (const observer of initialState?.statsObservers ?? []) this.statsObservers.set(observer.connectionId, observer);
    for (const subscription of initialState?.transcriptSubscriptions ?? []) {
      this.transcriptSubscriptions.set(this.transcriptSubscriptionKey(subscription.connectionId, subscription.subscriptionId), { ...subscription });
    }
    this.observeStats();
  }

  private startWorkspace() {
    if (this.workspace || !this.workspaceOwners) return;
    const workspace = new WorkbenchWorkspaceObservationController<BridgeClient>({
      ...this.workspaceOwners,
      reload: { read: () => this.reload.getReloadDirtSnapshot(), subscribe: listener => this.reload.subscribeReloadDirt(listener) },
      publish: (client, params, change) => this.publishWorkspace(client, params, change),
      warn: message => this.writeLine(`[workspace] ${message}`),
    });
    this.workspace = workspace;
    const interests = this.workspaceInterests;
    this.workspaceInterests = [];
    for (const interest of interests) {
      try {
        const params = workspace.observe(interest.client, interest.connectionId, interest.request, interest.revision + 1);
        void this.sendJsonToClient(interest.client, { method: WORKSPACE_UPDATED_METHOD, params },
          { eventDetail: `${params.kind} reset=restore` })
          .catch(error => this.reportSendFailure({ method: WORKSPACE_UPDATED_METHOD }, error));
      } catch (error) {
        this.reportSendFailure({ method: "workspace/restore" }, error);
        interest.client.close(1012, "Workspace observation needs a new connection.");
      }
    }
  }

  /** Every change after an observation's first value travels as a keyed delta. */
  private publishWorkspace(client: BridgeClient, value: DaemonWorkspaceObservation, change: DaemonObservationChange) {
    const message = change
      ? { method: WORKSPACE_DELTA_METHOD, params: {
        subscriptionId: value.subscriptionId, generation: value.generation, kind: value.kind,
        baseRevision: change.baseRevision, revision: value.revision, delta: change.delta,
      } }
      : { method: WORKSPACE_UPDATED_METHOD, params: value };
    const eventDetail = change ? `${value.kind} ${describeObservationDelta(change.delta)}` : `${value.kind} reset=restore`;
    void this.sendJsonToClient(client, message, { eventDetail, warnAboveBytes: WORKSPACE_PUSH_WARNING_BYTES })
      .catch(error => this.reportSendFailure({ method: message.method }, error));
  }

  /**
   * Provider events about one thread only go to connections observing it (a workspace thread observation or a
   * transcript subscription); thread-less events (account, models) go everywhere.
   */
  private wantsProviderEvent(client: BridgeClient, envelope: Record<string, unknown> | null) {
    if (!envelope || !ProviderKeySchema.safeParse(envelope[WORKBENCH_HARNESS_FIELD]).success) return true;
    const params = asRecord(envelope.params);
    const thread = asRecord(params?.thread);
    const threadId = typeof params?.threadId === "string" ? params.threadId
      : typeof thread?.id === "string" ? thread.id : null;
    if (!threadId) return true;
    for (const subscription of this.transcriptSubscriptions.values()) {
      if (subscription.client === client && subscription.threadId === threadId) return true;
    }
    return this.workspace?.observedThreadIds(client).has(threadId) ?? false;
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
    this.startWorkspace();
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
    const raw = data.toString();
    this.connectionIds.set(client, connectionId);
    try {
      message = JSON.parse(raw) as JsonRpcRequest;
    } catch {
      this.traffic.record({ direction: "in", connection: connectionId, label: "invalid JSON", payload: raw, bytes: data.length });
      client.close(1003, "Invalid JSON.");
      return;
    }
    const method = typeof message.method === "string" && message.method ? message.method : null;
    this.traffic.record({ direction: "in", connection: connectionId,
      label: `wb:${method ?? "missing method"}${"id" in message ? ` #${String(message.id)}` : ""}`, payload: raw, bytes: data.length });
    if (!method) throw new Error("Workbench WebSocket message is missing a method.");
    this.stream.connect(client);

    if (method === WEBSOCKET_SPY_RESULT_METHOD) {
      const answer = WebSocketSpyResultNotificationSchema.safeParse(message);
      if (answer.success) this.spyQueries.get(answer.data.params.requestId)?.(answer.data.params.result);
      else this.writeLine("[socket-spy] rejected an app spy result that did not match its contract");
      return;
    }

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
    const workspaceRequest = method === WORKSPACE_OBSERVE_METHOD || method === WORKSPACE_RELEASE_METHOD;
    const workbenchRequest = daemonRequest || method.startsWith("voice/") || method === REPO_RUNTIME_READ_METHOD
      || method.startsWith("workbench/thread-state/")
      || workspaceRequest
      || method === WORKBENCH_RELOAD_DIRT_READ_METHOD
      || transcriptRequest !== null;
    const harness = workbenchRequest ? "workbench" : "unknown";
    if (isRequest) this.beginRequest(client, requestId, data.length, methodLabel(harness, method), method);
    else this.eventLog.record("in", harness, method, data.length, describeWebSocketEvent(message.params));

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
      if (workspaceRequest) {
        try {
          this.startWorkspace();
          if (!this.workspace) throw new Error("Workspace observation support is unavailable.");
          const result = method === WORKSPACE_OBSERVE_METHOD
            ? this.workspace.observe(client, connectionId, DaemonWorkspaceObserveSchema.parse(message.params))
            : this.workspace.release(connectionId, WorkspaceReleaseSchema.parse(message.params));
          await this.sendJsonToClient(client, { id: requestId, result });
        } catch (error) {
          const invalid = error instanceof z.ZodError;
          const message = invalid ? "Workspace observation request is invalid."
            : (error instanceof Error ? error.message : "Workspace observation failed.")
              .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 512);
          if (!invalid) this.writeLine(`[workspace] ${message}`);
          await this.sendJsonToClient(client, { id: requestId, error: { code: invalid ? -32602 : -32000, message } });
        }
        return;
      }
      if (method.startsWith("voice/")) {
        try {
          if (!this.voice) throw new Error("Voice support is unavailable or reloading.");
          let result: object = { ok: true };
          const params = message.params;
          const session = () => z.object({ sessionId: z.string().uuid() }).strict().parse(params).sessionId;
          switch (method) {
            case "voice/configuration/read": result = await this.voice.settings.read(); break;
            case "voice/configuration/write": {
              const configuration = VoiceConfigurationSchema.parse(params);
              await this.voice.settings.write(configuration);
              if (!configuration.selection) await this.voice.controller.clear();
              break;
            }
            case "voice/agents": result = { data: await this.voice.agents() }; break;
            case "voice/prepare": await this.voice.controller.prepare(); break;
            case "voice/start": await this.voice.controller.start(connectionId, VoiceStartSchema.parse(params), event => {
              void this.sendJsonToClient(client, { method: "voice/event", params: event })
                .catch(error => this.reportSendFailure({ method: "voice/event" }, error));
            }); break;
            case "voice/audio": await this.voice.controller.audio(connectionId, VoiceAudioSchema.parse(params)); break;
            case "voice/finish": await this.voice.controller.finish(connectionId, session()); break;
            case "voice/cancel": await this.voice.controller.cancel(connectionId, session()); break;
            default: throw new Error("Unknown voice request.");
          }
          await this.sendJsonToClient(client, { id: requestId, result });
        } catch (error) {
          await this.sendJsonToClient(client, { id: requestId, error: { code: -32000,
            message: error instanceof z.ZodError ? "Invalid voice request." : error instanceof Error ? error.message.slice(0, 512) : "Voice request failed." } });
        }
        return;
      }
      if (method === REPO_RUNTIME_READ_METHOD) {
        try {
          if (!this.repo) throw new Error("Virtual repository support is unavailable or reloading.");
          await this.sendJsonToClient(client, { id: requestId, result: await this.repo.readAvailability() });
        } catch (error) {
          await this.sendJsonToClient(client, { id: requestId, error: { code: -32000,
            message: error instanceof Error ? error.message.slice(0, 512) : "Repository availability check failed." } });
        }
        return;
      }
      if (daemonRequest) {
        if (method === "stats/import/start") this.statsObservers.set(connectionId, { client, connectionId });
        await this.sendJsonToClient(client, await this.daemonRequests.handle(message, connectionId));
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
      try {
        const input = { method, ...(asRecord(message.params) ?? {}) };
        const parsed = WorkbenchThreadStateRequestSchema.safeParse(input);
        const request = this.identities && parsed.success ? await mapWorkbenchThreadStateRequest(this.identities, parsed.data) : input;
        signal.throwIfAborted();
        const result = await this.threadState.handleRequest(connectionId, request);
        if ("error" in result) {
          await this.sendJsonToClient(client, { id: requestId, error: {
            code: -32000, message: result.error.message, data: { reason: result.error.code },
          } });
        } else {
          await this.sendJsonToClient(client, { id: requestId, result: result.result });
        }
      } catch (error) {
        signal.throwIfAborted();
        await this.sendJsonToClient(client, { id: requestId, error: { code: -32000, message: error instanceof Error ? error.message : "Thread state identity projection failed." } });
      }
      return;
    }

    if (isRequest) {
      await this.sendJsonToClient(client, {
        id: requestId,
        error: { code: -32601, message: "Workbench method not found." },
      });
    }
  }

  /**
   * Answers `wb socket spy` from this daemon's frames and each connected app server's frames. Apps answer over
   * the socket they already hold. A CLI inspection has no use for an answer after SPY_ANSWER_DEADLINE_MS, so a
   * silent connection (a peer, or an app mid-reload) is reported as unanswered rather than awaited.
   */
  async spy(query: WebSocketTrafficQuery, target: "all" | "daemon" | "app", signal: AbortSignal) {
    this.assertActive();
    const daemon = target === "app" ? null : this.traffic.query(query);
    if (target === "daemon") return { daemon, apps: [] };
    const clients = [...this.connectionIds].filter(([client]) => client.readyState === client.OPEN);
    return { daemon, apps: await Promise.all(clients.map(([client, connection]) => this.askAppTraffic(client, connection, query, signal))) };
  }

  private askAppTraffic(client: BridgeClient, connection: string, query: WebSocketTrafficQuery, signal: AbortSignal) {
    type Answer = { connection: string; result: WebSocketTrafficResult | null; failure: string | null };
    const requestId = randomUUID();
    return new Promise<Answer>(resolve => {
      const finish = (answer: Omit<Answer, "connection">) => {
        if (!this.spyQueries.delete(requestId)) return;
        this.cancel(timer);
        signal.removeEventListener("abort", abort);
        resolve({ connection, ...answer });
      };
      const abort = () => finish({ result: null, failure: "cancelled" });
      const timer = this.schedule(() => finish({ result: null,
        failure: `no answer within ${SPY_ANSWER_DEADLINE_MS}ms (not the local app server, or reloading)` }), SPY_ANSWER_DEADLINE_MS);
      this.spyQueries.set(requestId, result => finish({ result, failure: null }));
      signal.addEventListener("abort", abort, { once: true });
      void this.sendJsonToClient(client, { method: WEBSOCKET_SPY_QUERY_METHOD, params: { requestId, query } }).catch(error =>
        finish({ result: null, failure: `send failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}` }));
    });
  }

  reportSendFailure(message: unknown, error: unknown) {
    process.stderr.write(`${formatWebSocketSendFailure(message, error)}\n`);
  }

  completeDelivery(delivery: WorkbenchWebSocketDelivery) {
    this.assertActive();
    if (delivery.outcome === "send-error" && delivery.streamEvent) this.stream.failDelivery(delivery.streamEvent);
    if (delivery.outcome !== "send-error" && delivery.eventMethod) {
      this.eventLog.record("out", delivery.eventHarness, delivery.eventMethod, delivery.outBytes, delivery.eventDetail ?? null);
    }
    const pending = delivery.request ? this.pending.get(delivery.client)?.get(delivery.request.id) : undefined;
    if (pending && pending.identity === delivery.request?.identity) {
      this.complete(pending, delivery.outcome, delivery.processMs, delivery.jsonMs, delivery.sendMs, delivery.outBytes, delivery.errorMessage);
    }
  }

  /**
   * `eventDetail` replaces the generic envelope description in traffic logs; `warnAboveBytes` names any
   * workspace push over budget, the tripwire for an observation regressing to snapshot resends.
   */
  async sendJsonToClient(client: BridgeClient, message: unknown, options: { eventDetail?: string; warnAboveBytes?: number } = {}) {
    this.assertActive();
    const signal = this.generation.signal;
    const envelope = asRecord(message);
    if (!this.wantsProviderEvent(client, envelope)) return;
    const eventMethod = typeof envelope?.method === "string" ? envelope.method : null;
    const eventHarness = envelope?.[WORKBENCH_HARNESS_FIELD];
    const responseId = readResponseId(message);
    const pending = responseId === undefined ? null : this.pending.get(client)?.get(responseId) ?? null;
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
    if (options.warnAboveBytes !== undefined && outBytes > options.warnAboveBytes) {
      this.writeLine(`[workspace] oversized push ${formatBytes(outBytes)}: ${options.eventDetail ?? eventMethod ?? "message"}`);
    }
    if (client.readyState !== client.OPEN) {
      if (streamEvent) this.stream.abandonDelivery(streamEvent);
      if (pending) this.complete(pending, "closed", processMs, jsonMs, 0, outBytes);
      return;
    }
    const trafficHarness = ProviderKeySchema.safeParse(eventHarness).success ? eventHarness as WorkbenchHarness : "workbench";
    this.traffic.record({
      direction: "out", connection: this.connectionIds.get(client) ?? "unknown", payload: serialized, bytes: outBytes,
      label: eventMethod
        ? `${methodLabel(trafficHarness, eventMethod)} ${options.eventDetail ?? describeWebSocketEvent(envelope?.params)}`
        : `wb:response #${String(responseId)}${pending ? ` ${pending.method}` : ""}`,
    });

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
            // The daemon tags provider events with their harness; every other event it sends is its own.
            eventHarness: ProviderKeySchema.safeParse(eventHarness).success ? eventHarness as WorkbenchHarness : "workbench",
            eventDetail: eventMethod ? options.eventDetail ?? describeWebSocketEvent(envelope?.params) : null,
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
    this.connectionIds.delete(client);
    this.stream.disconnect(client);
    this.reloadDirtObservers.delete(connectionId);
    this.statsObservers.delete(connectionId);
    this.unsubscribeTranscriptConnection(connectionId);
    this.workspace?.disconnect(connectionId);
    this.workspaceInterests = this.workspaceInterests.filter(interest => interest.connectionId !== connectionId);
    const cleanup = await Promise.allSettled([
      this.voice?.controller.disconnect(connectionId),
    ]);
    const failures = cleanup.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "WebSocket connection cleanup failed.");
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
      workspaceInterests: [...this.workspaceInterests],
    };
  }

  suspend() {
    if (this.lifecycle !== "active") return;
    this.lifecycle = "suspended";
    if (this.workspace) {
      this.workspaceInterests = this.workspace.captureInterests();
      this.workspace.dispose();
      this.workspace = null;
    }
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
      void this.subscribeTranscript(subscription).catch((error: unknown) => {
        this.writeLine(`[transcript] restore subscription failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`);
      });
    }
    await this.start();
  }

  dispose() {
    if (this.lifecycle === "disposed") return;
    this.suspend();
    this.lifecycle = "disposed";
    this.workspaceInterests = [];
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
      toolPatchPreviews: request.params.toolPatchPreviews,
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
    const signal = this.generation.signal;
    const key = this.transcriptSubscriptionKey(subscription.connectionId, subscription.subscriptionId);
    this.transcriptSubscriptions.set(key, subscription);
    try {
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
        ...(subscription.protocolVersion !== undefined && subscription.protocolVersion >= 3 ? {
          publishStream: (update: import("workbench-shared/workbench/transcript/thread-transcript-stream").TranscriptStreamUpdate) => {
            if (update.kind === "toolPatch" && !subscription.toolPatchPreviews) return;
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
      nextWarningAt: startedAt + DEFAULT_PENDING_THRESHOLD_MS,
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
