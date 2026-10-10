/*
 * Exports:
 * - WorkbenchDaemonSourceDescriptor: verified endpoint and access facts for one durable daemon.
 * - WorkbenchDaemonObservationFact: received data with connection-aware freshness.
 * - WorkbenchDaemonTranscriptEvent: source-owned transcript baseline, stream and freshness delivery.
 * - default WorkbenchDaemonSource: own one daemon connection, shared read interests, operation retention and socket spy answers.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DaemonId } from "workbench-shared/workbench/identity";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import WorkbenchSocketClient from "workbench-shared/workbench/WorkbenchSocketClient";
import { WorkbenchRpcRequestInterruptedError } from "workbench-shared/workbench/WorkbenchRpcSocketClient";
import WorkbenchDaemonClient, { WorkbenchDaemonRequestError } from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";
import {
  WEBSOCKET_SPY_QUERY_METHOD, WEBSOCKET_SPY_RESULT_METHOD, WebSocketSpyQueryNotificationSchema,
  type WebSocketTrafficQuery, type WebSocketTrafficResult,
} from "workbench-shared/process/WebSocketTrafficBuffer";
import {
  DaemonWorkspaceQuerySchema, DaemonWorkspaceObservationSchema, WorkspaceObservationDeltaSchema,
  daemonObservationShape, type WorkspaceObservationDelta,
  WORKSPACE_DELTA_METHOD, WORKSPACE_OBSERVE_METHOD, WORKSPACE_RELEASE_METHOD, WORKSPACE_RETARGET_METHOD, WORKSPACE_UPDATED_METHOD,
  type DaemonWorkspaceQuery, type DaemonWorkspaceObservation,
  type WorkspaceDaemonFact, type WorkspaceSourcePhase, type WorkspaceTranscriptState,
} from "workbench-shared/workbench/workspace/workspace-observation";
import { applyObservationDelta } from "workbench-shared/workbench/workspace/observation-patch";
import {
  conformWorkbenchTranscriptUpdated, conformWorkbenchTranscriptStreamed, workbenchTranscriptOperations,
  type WorkbenchTranscriptSubscribeParams, type WorkbenchTranscriptUpdatedParams, type WorkbenchTranscriptStreamedParams,
} from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";

export type WorkbenchDaemonTranscriptEvent =
  | { kind: "transcriptSnapshot"; data: WorkbenchTranscriptUpdatedParams }
  | { kind: "transcriptStream"; data: WorkbenchTranscriptStreamedParams }
  | { kind: "transcriptState"; data: WorkspaceTranscriptState };

interface TranscriptInterest {
  id: string;
  request: Omit<WorkbenchTranscriptSubscribeParams, "subscriptionId">;
  cancellation: AbortController;
  work: Promise<void> | null;
  baseline: number;
  failure: string | null;
  listeners: Map<object, {
    publish(event: WorkbenchDaemonTranscriptEvent): void;
    generation: number | null;
    state: WorkspaceTranscriptState | null;
  }>;
}

export interface WorkbenchDaemonSourceDescriptor {
  daemonId: DaemonId;
  hostname: string;
  state: "sleeping" | "starting" | "ready" | "failed";
  endpoint: string | null;
  access: boolean;
  failure: string | null;
}

export interface WorkbenchDaemonObservationFact {
  phase: WorkspaceSourcePhase;
  failure: string | null;
  value: DaemonWorkspaceObservation | null;
}

interface Interest {
  cancellation: AbortController;
  subscriptionId: string;
  query: DaemonWorkspaceQuery;
  listeners: Map<object, () => void>;
  /** Exactly what the daemon holds; deltas apply only onto this revision. */
  raw: DaemonWorkspaceObservation | null;
  /** `raw` with lean rows and pending data retained, as observers read it. */
  value: DaemonWorkspaceObservation | null;
  /** Deltas that arrived before the first value they build on. */
  early: WorkspaceObservationDelta[];
  failure: string | null;
}

const rpcError = z.object({ code: z.number().int(), message: z.string(), data: z.json().optional() });
const MAX_EARLY_DELTAS = 32;

const observationAddress = z.object({ subscriptionId: z.uuid(), generation: z.number().int().nonnegative() });
function bounded(error: unknown) {
  return (error instanceof Error ? error.message : "Daemon request failed.")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 512);
}

export default class WorkbenchDaemonSource {
  readonly socket: WorkbenchSocketClient;
  readonly daemon: WorkbenchDaemonClient;
  private readonly interests = new Map<string, Interest>();
  private readonly transcripts = new Map<string, TranscriptInterest>();
  private readonly leases = new Set<object>();
  private readonly listeners = new Set<() => void>();
  private readonly endpointListeners = new Set<() => void>();
  private readonly unsubscribe: Array<() => void>;
  private disposed = false;

  constructor(
    private descriptor: WorkbenchDaemonSourceDescriptor,
    private readonly options: {
      warn(message: string): void;
      createSocket?: (url: string) => WebSocket;
      /** Answers `wb socket spy` for this daemon; null withholds browser traffic (e.g. from peer daemons). */
      answerSpy?: (query: WebSocketTrafficQuery) => WebSocketTrafficResult | null;
    },
  ) {
    this.socket = new WorkbenchSocketClient({
      resolveUrl: signal => this.resolveEndpoint(signal),
      createSocket: options.createSocket,
    });
    this.socket.setSuspended(true);
    this.daemon = new WorkbenchDaemonClient({
      request: (method, params) => this.request(method, params),
      onNotification: listener => this.socket.onWorkbenchNotification(listener),
      onReconnect: listener => this.socket.onReconnect(listener),
      onDisconnect: listener => this.socket.onConnectionClose(listener),
    });
    this.unsubscribe = [
      this.socket.subscribeConnection(() => {
        this.publish();
        for (const interest of this.interests.values()) this.publishInterest(interest);
      }),
      this.socket.onConnectionOpen(() => {
        for (const interest of this.interests.values()) this.openInterest(interest);
        for (const interest of this.transcripts.values()) {
          interest.failure = null;
          this.openTranscript(interest);
        }
      }),
      this.socket.onWorkbenchNotification(notification => {
        if (notification.method === WORKSPACE_DELTA_METHOD) this.receiveDelta(notification.params);
      }),
      this.socket.onWorkbenchNotification(notification => {
        if (notification.method !== WEBSOCKET_SPY_QUERY_METHOD) return;
        const query = WebSocketSpyQueryNotificationSchema.safeParse(notification);
        if (!query.success) {
          reportClientSchemaError("Rejected daemon socket spy query", query.error);
          return;
        }
        const result = this.options.answerSpy?.(query.data.params.query);
        if (result) this.socket.send({ method: WEBSOCKET_SPY_RESULT_METHOD, params: { requestId: query.data.params.requestId, result } });
      }),
      this.socket.onWorkbenchNotification(notification => {
        if (notification.method === "workbench/transcript/updated" || notification.method === "workbench/transcript/streamed") {
          this.receiveTranscript(notification);
          return;
        }
        if (notification.method !== WORKSPACE_UPDATED_METHOD) return;
        const parsed = DaemonWorkspaceObservationSchema.safeParse(notification.params);
        if (!parsed.success) {
          reportClientSchemaError("Rejected daemon workspace observation", parsed.error);
          this.options.warn("Daemon workspace observation did not match its contract.");
          const address = observationAddress.safeParse(notification.params);
          const interest = address.success ? this.interests.get(address.data.subscriptionId) : null;
          if (interest && address.success && address.data.generation === this.socket.getSnapshot().generation) {
            interest.failure = "The daemon published invalid observation data.";
            this.publishInterest(interest);
          }
          return;
        }
        this.accept(parsed.data);
      }),
    ];
  }

  get id() { return this.descriptor.daemonId; }
  get available() { return this.descriptor.access && this.socket.isOpen && !this.disposed; }
  get hasDemand() { return this.interests.size > 0 || this.transcripts.size > 0 || this.leases.size > 0; }
  private get hasActiveDemand() {
    return this.leases.size > 0 || this.transcripts.size > 0 || [...this.interests.values()].some(interest =>
      interest.query.kind !== "catalogue" && interest.query.kind !== "summaries"
      && interest.query.kind !== "runtime" && interest.query.kind !== "update");
  }
  get httpOrigin() {
    if (!this.available || !this.socket.url) return null;
    const url = new URL(this.socket.url);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    return url.origin;
  }

  getSnapshot = (): WorkspaceDaemonFact => {
    const connection = this.socket.getSnapshot();
    return {
      daemonId: this.id,
      hostname: this.descriptor.hostname,
      generation: connection.generation,
      connection: !this.descriptor.access ? "revoked"
        : this.available ? "current"
        : this.descriptor.state === "sleeping" ? "sleeping"
        : this.descriptor.state === "failed" ? "failed"
        : !this.hasDemand ? "idle"
        : connection.phase === "reconnecting" ? "reconnecting" : "connecting",
      failure: this.descriptor.failure ?? connection.failure,
    };
  };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  update(descriptor: WorkbenchDaemonSourceDescriptor) {
    if (descriptor.daemonId !== this.id) throw new Error("A daemon source cannot change identity.");
    if (this.disposed || areDeeplyEqual(this.descriptor, descriptor)) return;
    const changedEndpoint = descriptor.endpoint !== null && this.socket.url !== null
      && new URL(descriptor.endpoint).href !== new URL(this.socket.url).href;
    this.descriptor = descriptor;
    if (!descriptor.access) {
      for (const interest of this.interests.values()) {
        interest.raw = null;
        interest.value = null;
        interest.failure = "This app no longer has access to the daemon.";
      }
    }
    if (changedEndpoint) this.socket.setSuspended(true);
    for (const listener of [...this.endpointListeners]) listener();
    this.updateDemand();
    this.publish();
    for (const interest of this.interests.values()) this.publishInterest(interest);
  }

  observe(input: DaemonWorkspaceQuery, listener: () => void) {
    if (this.disposed) throw new Error("Daemon source is closed.");
    const parsed = DaemonWorkspaceQuerySchema.parse(input);
    const query: DaemonWorkspaceQuery = parsed.kind === "projectThreads"
      ? { ...parsed, projectIds: [...new Set(parsed.projectIds)].sort() } : parsed;
    let interest = [...this.interests.values()].find(current => areDeeplyEqual(current.query, query));
    const created = !interest;
    if (!interest) {
      interest = { subscriptionId: randomUUID(), query, listeners: new Map(), raw: null, value: null, early: [], failure: null,
        cancellation: new AbortController() };
      this.interests.set(interest.subscriptionId, interest);
    }
    const owner = {};
    interest.listeners.set(owner, listener);
    const retained = interest;
    this.updateDemand();
    if (created && this.available) this.openInterest(retained);
    return {
      getSnapshot: () => this.readInterest(retained),
      /**
       * Swaps a sole owner's batch arguments in place; the daemon answers with a delta against the current value.
       * A daemon without retargeting gets a fresh subscription for the new arguments instead.
       */
      retarget: (next: DaemonWorkspaceQuery) => {
        if (retained.listeners.size !== 1 || !retained.listeners.has(owner)) throw new Error("Only a sole observer can retarget a daemon observation.");
        const target = DaemonWorkspaceQuerySchema.parse(next);
        if (areDeeplyEqual(target, retained.query)) return;
        retained.query = target;
        if (!this.available) return;
        const generation = this.socket.getSnapshot().generation;
        void this.request(WORKSPACE_RETARGET_METHOD, { subscriptionId: retained.subscriptionId, generation, query: target },
          {}, { signal: retained.cancellation.signal }).catch(error => {
          if (error instanceof WorkbenchRpcRequestInterruptedError || this.interests.get(retained.subscriptionId) !== retained
            || generation !== this.socket.getSnapshot().generation) return;
          if (!(error instanceof WorkbenchDaemonRequestError)) {
            retained.failure = bounded(error);
            this.options.warn(`Daemon observation retarget failed: ${retained.failure}`);
            this.publishInterest(retained);
            return;
          }
          this.resubscribe(retained);
        });
      },
      release: () => {
        if (!retained.listeners.delete(owner) || retained.listeners.size) return;
        this.interests.delete(retained.subscriptionId);
        retained.cancellation.abort();
        if (this.hasDemand && this.available) {
          void this.request(WORKSPACE_RELEASE_METHOD, {
            subscriptionId: retained.subscriptionId, generation: this.socket.getSnapshot().generation,
          }).catch(error => {
            if (!(error instanceof WorkbenchRpcRequestInterruptedError)) {
              this.options.warn(`Daemon observation release failed: ${bounded(error)}`);
            }
          });
        }
        this.updateDemand();
      },
    };
  }

  retain() {
    if (this.disposed) throw new Error("Daemon source is closed.");
    const lease = {};
    this.leases.add(lease);
    this.updateDemand();
    return () => {
      if (!this.leases.delete(lease)) return;
      this.updateDemand();
    };
  }

  observeTranscript(input: Omit<WorkbenchTranscriptSubscribeParams, "subscriptionId">,
    publish: (event: WorkbenchDaemonTranscriptEvent) => void) {
    if (this.disposed) throw new Error("Daemon source is closed.");
    const request = { ...input, protocolVersion: input.protocolVersion === 2 ? 2 as const : 4 as const,
      toolPatchPreviews: input.toolPatchPreviews === true,
      ...(input.turnIds ? { turnIds: [...new Set(input.turnIds)].sort() } : {}) };
    let interest = [...this.transcripts.values()].find(item => areDeeplyEqual(item.request, request));
    if (!interest) {
      interest = { id: randomUUID(), request, cancellation: new AbortController(),
        work: null, baseline: 0, failure: null, listeners: new Map() };
      this.transcripts.set(interest.id, interest);
    }
    const token = {};
    const listener = { publish, generation: null, state: null };
    interest.listeners.set(token, listener);
    const retained = interest;
    this.publishTranscriptState(retained);
    this.updateDemand();
    if (this.available) {
      retained.failure = null;
      this.openTranscript(retained);
    }
    return { release: () => {
      if (!retained.listeners.delete(token) || retained.listeners.size) return;
      this.transcripts.delete(retained.id);
      retained.cancellation.abort();
      if (this.available) void this.request(workbenchTranscriptOperations.unsubscribe.method, {
        subscriptionId: retained.id,
      }).catch(error => {
        if (!(error instanceof WorkbenchRpcRequestInterruptedError)) this.options.warn(`Transcript release failed: ${bounded(error)}`);
      });
      this.updateDemand();
    } };
  }

  async request<Result>(
    method: string, params: object = {}, fields: object = {}, options: { signal?: AbortSignal } = {},
  ): Promise<Result> {
    if (!this.available) throw new WorkbenchRpcRequestInterruptedError("The daemon is not connected; request was not sent.", false);
    // Observation plumbing never creates demand of its own; only observers and leases do.
    const release = method === WORKSPACE_OBSERVE_METHOD || method === WORKSPACE_RELEASE_METHOD || method === WORKSPACE_RETARGET_METHOD
      ? () => {} : this.retain();
    try {
      const response = await this.socket.sendRequest<Result>({ ...fields, method, params }, {
        requireOpen: true, signal: options.signal,
      });
      if ("error" in response) {
        const parsed = rpcError.safeParse(response.error);
        if (!parsed.success) {
          reportClientSchemaError("Rejected daemon RPC failure", parsed.error);
          throw new Error("The daemon returned an invalid failure.");
        }
        const data = parsed.data.data;
        throw new WorkbenchDaemonRequestError(bounded(new Error(parsed.data.message)), parsed.data.code,
          data && typeof data === "object" && !Array.isArray(data) ? data : null);
      }
      return response.result;
    } finally { release(); }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.socket.dispose();
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    for (const interest of this.interests.values()) {
      interest.cancellation.abort();
      interest.listeners.clear();
    }
    this.interests.clear();
    for (const interest of this.transcripts.values()) {
      interest.cancellation.abort();
      interest.listeners.clear();
    }
    this.transcripts.clear();
    this.leases.clear();
    this.listeners.clear();
    this.endpointListeners.clear();
  }

  private readInterest(interest: Interest): WorkbenchDaemonObservationFact {
    const current = this.available && interest.value?.generation === this.socket.getSnapshot().generation;
    return {
      phase: !this.descriptor.access ? "unavailable"
        : interest.failure ? interest.value ? "stale" : "failed"
        : !current ? interest.value ? "stale" : "pending"
        : interest.value!.phase,
      failure: !this.descriptor.access ? "This app no longer has access to the daemon."
        : interest.failure ?? (this.descriptor.state === "failed" ? this.descriptor.failure
          : current ? interest.value?.failure ?? null : null),
      value: this.descriptor.access ? interest.value : null,
    };
  }

  private openTranscript(interest: TranscriptInterest) {
    if (interest.work || !this.available || this.transcripts.get(interest.id) !== interest) return;
    const generation = this.socket.getSnapshot().generation;
    const baseline = interest.baseline;
    const work = this.request(workbenchTranscriptOperations.subscribe.method, {
      ...interest.request, subscriptionId: interest.id,
    }, {}, { signal: interest.cancellation.signal }).then(result => {
      if (this.transcripts.get(interest.id) !== interest || generation !== this.socket.getSnapshot().generation) return;
      const decoded = workbenchTranscriptOperations.subscribe.conformResult(result);
      if (!decoded.success) throw new Error("The daemon returned an invalid transcript subscription acknowledgement.");
      if (interest.baseline === baseline) {
        throw new Error("The daemon acknowledged a transcript subscription without its baseline.");
      }
    }).catch(error => {
      if (this.disposed || this.transcripts.get(interest.id) !== interest
        || generation !== this.socket.getSnapshot().generation) return;
      if (!(error instanceof WorkbenchRpcRequestInterruptedError)) {
        interest.failure = bounded(error);
        this.options.warn(`Transcript observation failed: ${interest.failure}`);
      }
      this.publishTranscriptState(interest);
    });
    interest.work = work;
    void work.then(() => {
      if (interest.work === work) interest.work = null;
      if (!interest.failure && this.available && this.transcripts.get(interest.id) === interest
        && [...interest.listeners.values()].some(listener => listener.generation !== this.socket.getSnapshot().generation)) {
        this.openTranscript(interest);
      }
    });
  }

  private receiveTranscript(notification: { method: string; params: unknown }) {
    const address = z.object({ subscriptionId: z.uuid() }).safeParse(notification.params);
    if (!address.success) {
      reportClientSchemaError("Rejected daemon transcript address", address.error);
      return;
    }
    const interest = address.success ? this.transcripts.get(address.data.subscriptionId) : null;
    if (!interest || !this.available) return;
    let event: WorkbenchDaemonTranscriptEvent;
    let baseline: boolean;
    if (notification.method === "workbench/transcript/updated") {
      const parsed = conformWorkbenchTranscriptUpdated(notification.params);
      if (!parsed.success) {
        this.failTranscript(interest, "The daemon published an invalid transcript snapshot.");
        return;
      }
      if (parsed.repairedPaths.length) this.options.warn(`Daemon transcript snapshot required ${parsed.repairedPaths.length} schema repairs.`);
      event = { kind: "transcriptSnapshot", data: parsed.data };
      baseline = true;
    } else {
      const parsed = conformWorkbenchTranscriptStreamed(notification.params);
      if (!parsed.success) {
        this.failTranscript(interest, "The daemon published an invalid transcript stream.");
        return;
      }
      if (parsed.repairedPaths.length) this.options.warn(`Daemon transcript stream required ${parsed.repairedPaths.length} schema repairs.`);
      event = { kind: "transcriptStream", data: parsed.data };
      baseline = parsed.data.update.kind === "absent"
        || parsed.data.update.kind === "structure" && parsed.data.update.reset;
    }
    const generation = this.socket.getSnapshot().generation;
    if (baseline) {
      interest.baseline++;
      interest.failure = null;
      for (const listener of interest.listeners.values()) listener.generation = generation;
      this.publishTranscriptState(interest);
    }
    if (interest.failure) return;
    for (const listener of interest.listeners.values()) {
      if (listener.generation === generation) this.deliver(() => listener.publish(event));
    }
  }

  private failTranscript(interest: TranscriptInterest, message: string) {
    if (interest.failure !== message) this.options.warn(message);
    interest.failure = message;
    this.publishTranscriptState(interest);
  }

  private publishTranscriptState(interest: TranscriptInterest) {
    for (const listener of interest.listeners.values()) {
      const current = this.available && listener.generation === this.socket.getSnapshot().generation;
      const state: WorkspaceTranscriptState = {
        subscriptionId: interest.id,
        phase: !this.descriptor.access ? "unavailable"
          : interest.failure ? "failed" : current ? "current" : listener.generation === null ? "pending" : "stale",
        failure: !this.descriptor.access ? "This app no longer has access to the daemon."
          : interest.failure ?? (this.descriptor.state === "failed" ? this.descriptor.failure : null),
      };
      if (areDeeplyEqual(listener.state, state)) continue;
      listener.state = state;
      this.deliver(() => listener.publish({ kind: "transcriptState", data: state }));
    }
  }

  /** Replaces an interest's daemon subscription with a fresh one for its current arguments. */
  private resubscribe(interest: Interest) {
    const previous = interest.subscriptionId;
    void this.request(WORKSPACE_RELEASE_METHOD, { subscriptionId: previous, generation: this.socket.getSnapshot().generation })
      .catch(error => {
        if (!(error instanceof WorkbenchRpcRequestInterruptedError)) this.options.warn(`Daemon observation release failed: ${bounded(error)}`);
      });
    this.interests.delete(previous);
    interest.subscriptionId = randomUUID();
    interest.raw = null;
    interest.early = [];
    this.interests.set(interest.subscriptionId, interest);
    this.openInterest(interest);
  }

  private openInterest(interest: Interest) {
    const generation = this.socket.getSnapshot().generation;
    interest.failure = null;
    void this.request<DaemonWorkspaceObservation>(WORKSPACE_OBSERVE_METHOD, {
      subscriptionId: interest.subscriptionId, generation, query: interest.query,
    }, {}, { signal: interest.cancellation.signal }).then(value => {
      const parsed = DaemonWorkspaceObservationSchema.safeParse(value);
      if (!parsed.success) {
        reportClientSchemaError("Rejected daemon observation response", parsed.error);
        throw new Error("The daemon returned an invalid observation.");
      }
      this.accept(parsed.data);
    }).catch(error => {
      if (this.disposed || this.interests.get(interest.subscriptionId) !== interest
        || generation !== this.socket.getSnapshot().generation) return;
      if (error instanceof WorkbenchRpcRequestInterruptedError) {
        this.publishInterest(interest);
        return;
      }
      interest.failure = bounded(error);
      this.options.warn(`Daemon observation failed: ${interest.failure}`);
      this.publishInterest(interest);
    });
  }

  private accept(value: DaemonWorkspaceObservation) {
    const interest = this.interests.get(value.subscriptionId);
    if (!interest || !this.available || value.generation !== this.socket.getSnapshot().generation) return;
    if (value.kind !== interest.query.kind) {
      interest.failure = "The daemon returned a different observation kind.";
      this.options.warn(interest.failure);
      this.publishInterest(interest);
      return;
    }
    if (interest.raw?.generation === value.generation && interest.raw.revision >= value.revision) return;
    interest.raw = value;
    interest.value = this.retainPendingData(interest.value, value);
    interest.failure = null;
    for (const delta of interest.early.splice(0)) this.applyDelta(interest, delta);
    // A replayed delta already published its newer value through `accept`.
    if (interest.raw === value || !interest.raw) this.publishInterest(interest);
  }

  private receiveDelta(params: unknown) {
    const parsed = WorkspaceObservationDeltaSchema.safeParse(params);
    if (!parsed.success) {
      reportClientSchemaError("Rejected daemon workspace delta", parsed.error);
      const address = observationAddress.safeParse(params);
      const interest = address.success ? this.interests.get(address.data.subscriptionId) : null;
      if (interest) this.resync(interest, "the daemon published an invalid delta");
      return;
    }
    const delta = parsed.data;
    const interest = this.interests.get(delta.subscriptionId);
    if (!interest || !this.available || delta.generation !== this.socket.getSnapshot().generation) return;
    this.applyDelta(interest, delta);
  }

  private applyDelta(interest: Interest, delta: WorkspaceObservationDelta) {
    const raw = interest.raw;
    // A delta can overtake the observe response that carries its base; hold a few until that value lands.
    if (!raw) {
      if (interest.early.length < MAX_EARLY_DELTAS) interest.early.push(delta);
      else this.resync(interest, "too many deltas arrived before the first value");
      return;
    }
    if (delta.generation === raw.generation && delta.revision <= raw.revision) return;
    if (raw.generation !== delta.generation || raw.kind !== delta.kind || raw.revision !== delta.baseRevision) {
      this.resync(interest, `delta for revision ${delta.baseRevision} does not follow revision ${raw?.revision ?? "none"}`);
      return;
    }
    let next: DaemonWorkspaceObservation;
    try {
      next = { ...applyObservationDelta(raw, delta.delta, daemonObservationShape(raw.kind)), revision: delta.revision };
    } catch (error) {
      this.resync(interest, bounded(error));
      return;
    }
    this.accept(next);
  }

  /** A delta that cannot apply means this copy diverged; re-observing returns the daemon's current full value. */
  private resync(interest: Interest, reason: string) {
    this.options.warn(`Daemon ${interest.query.kind} observation resync: ${reason}`);
    interest.raw = null;
    if (this.available) this.openInterest(interest);
  }

  private retainPendingData(previous: DaemonWorkspaceObservation | null, value: DaemonWorkspaceObservation): DaemonWorkspaceObservation {
    if (!previous || previous.kind !== value.kind || value.phase === "current") return value;
    if (value.kind === "catalogue" && previous.kind === "catalogue") {
      return { ...value, catalogue: value.catalogue ?? previous.catalogue, locations: value.locations ?? previous.locations };
    }
    if (value.kind === "projectTree" && previous.kind === "projectTree") return { ...value, project: value.project ?? previous.project };
    if (value.kind === "threadIdentity" && previous.kind === "threadIdentity") return { ...value, identity: value.identity ?? previous.identity };
    if (value.kind === "thread" && previous.kind === "thread") return { ...value, data: value.data ?? previous.data };
    if (value.kind === "projectThreads" && previous.kind === "projectThreads") {
      return { ...value, projects: value.projects.map(project => {
        const sidebar = previous.projects.find(prior => prior.projectId === project.projectId)?.sidebar;
        return !project.sidebar && sidebar ? { ...project, phase: "stale" as const, sidebar } : project;
      }) };
    }
    if (value.kind === "summaries" && previous.kind === "summaries") {
      const current = new Set(value.projects.map(project => project.projectId));
      const pending = new Set(value.pendingProjectIds);
      return { ...value, projects: [...value.projects, ...previous.projects.filter(project =>
        !current.has(project.projectId) && pending.has(project.projectId))] };
    }
    return value;
  }

  private updateDemand() {
    const suspended = this.disposed || !this.hasDemand || !this.descriptor.access
      || this.descriptor.state === "sleeping" && !this.hasActiveDemand || this.descriptor.state === "failed";
    this.socket.setSuspended(suspended);
  }

  private resolveEndpoint(signal: AbortSignal): Promise<string> {
    const current = () => this.descriptor.access
      && (this.descriptor.state === "ready" || this.descriptor.state === "sleeping" && this.hasActiveDemand)
      ? this.descriptor.endpoint : null;
    signal.throwIfAborted();
    const endpoint = current();
    if (endpoint) return Promise.resolve(endpoint);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.endpointListeners.delete(changed);
        signal.removeEventListener("abort", cancelled);
      };
      const changed = () => {
        const endpoint = current();
        if (!endpoint) return;
        cleanup();
        resolve(endpoint);
      };
      const cancelled = () => { cleanup(); reject(signal.reason); };
      this.endpointListeners.add(changed);
      signal.addEventListener("abort", cancelled, { once: true });
      if (signal.aborted) cancelled();
      else changed();
    });
  }

  private publish() {
    for (const listener of this.listeners) this.deliver(listener);
    for (const interest of this.transcripts.values()) this.publishTranscriptState(interest);
  }

  private publishInterest(interest: Interest) {
    for (const listener of interest.listeners.values()) this.deliver(listener);
  }

  private deliver(listener: () => void) {
    try { listener(); }
    catch (error) { this.options.warn(`Daemon source observer failed: ${bounded(error)}`); }
  }
}
