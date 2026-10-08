/*
 * Exports:
 * - WorkspaceQuerySnapshot: stable received facts and app-connection-aware freshness.
 * - WorkspaceQueryHandle: caller-owned typed observation and release boundary.
 * - default WorkbenchWorkspaceClient: share typed query interests over the tab's single app connection.
 */
import {
  WorkspaceQuerySchema, WorkspaceObservationSchema, workspaceObservationShape,
  type WorkspaceQuery, type WorkspaceObservation, type WorkspaceObservationDelta,
  type WorkspaceSourcePhase, type WorkspaceTranscriptState,
} from "workbench-shared/workbench/workspace/workspace-observation";
import { WORKBENCH_THREAD_SIDEBAR_ROW_VERSION } from "workbench-shared/workbench/thread/thread-sidebar-row";
import { applyObservationDelta } from "workbench-shared/workbench/workspace/observation-patch";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";
import { WorkbenchRpcRequestInterruptedError } from "workbench-shared/workbench/WorkbenchRpcSocketClient";
import type WorkbenchAppRpcClient from "./WorkbenchAppRpcClient";
import WorkbenchDaemonClient, { WorkbenchDaemonRequestError } from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import { WorkspaceCommandSchema, WorkspaceTranscriptRequestSchema, WorkspaceThreadMutationSchema, workspaceCommandRoutes, type WorkspaceCommandMethod } from "workbench-shared/workbench/workspace/workspace-commands";
import type { DaemonId } from "workbench-shared/workbench/identity";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { z } from "zod";
import {
  workbenchTranscriptOperations, WORKBENCH_TRANSCRIPT_PROTOCOL_VERSION,
} from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import type WorkbenchSocketClient from "workbench-shared/workbench/WorkbenchSocketClient";
import type { WorkbenchClientNotification } from "workbench-shared/workbench/WorkbenchSocketClient";
import type { WorkbenchHarness, WorkbenchSendThreadMessageOptions } from "workbench-shared/types";
import { WorkbenchHarnessSchema, type WorkbenchThreadRouteTarget } from "workbench-shared/workbench/thread/thread-state";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";

type WorkspaceScope = { kind: "folder"; location: ProjectLocationReference }
  | { kind: "installation"; daemonId?: DaemonId } | { kind: "thread"; threadId: string };
type Notification = Parameters<Parameters<WorkbenchSocketClient["onWorkbenchNotification"]>[0]>[0]
  | { method: "workspace/transcript/state"; params: WorkspaceTranscriptState };

export interface WorkspaceQuerySnapshot<Kind extends WorkspaceQuery["kind"] = WorkspaceQuery["kind"]> {
  phase: WorkspaceSourcePhase;
  failure: string | null;
  value: Extract<WorkspaceObservation, { kind: Kind }> | null;
}

export interface WorkspaceQueryHandle<Kind extends WorkspaceQuery["kind"]> {
  getSnapshot(): WorkspaceQuerySnapshot<Kind>;
  readonly signal: AbortSignal;
  subscribe(listener: () => void): () => void;
  release(): void;
}

interface Interest {
  id: string;
  query: WorkspaceQuery;
  cancellation: AbortController;
  listeners: Map<object, { callbacks: Set<() => void>; cancellation: AbortController }>;
  /** Exactly what the app holds; deltas apply only onto this revision. */
  raw: WorkspaceObservation | null;
  /** Deltas that arrived before the first value they build on. */
  early: WorkspaceObservationDelta[];
  snapshot: WorkspaceQuerySnapshot;
}
const MAX_EARLY_DELTAS = 32;


export default class WorkbenchWorkspaceClient {
  private readonly interests = new Map<string, Interest>();
  private readonly unsubscribe: Array<() => void>;
  private disposed = false;
  private readonly cancellation = new AbortController();
  private readonly notificationListeners = new Set<(notification: Notification) => void>();
  private readonly threadObservations = new Map<string, { release(): void }>();
  private readonly facades = new Map<string, WorkbenchDaemonClient>();

  constructor(readonly rpc: WorkbenchAppRpcClient) {
    this.unsubscribe = [
      rpc.onEvent(event => { if (event.kind === "workspaceDelta") this.acceptDelta(event.delta); }),
      rpc.onInvalidObservation(address => this.rejectObservation(address.subscriptionId, address.generation)),
      rpc.onOpen(() => {
        this.notify({ method: "workbench/transcript/capabilities", params: { protocolVersion: WORKBENCH_TRANSCRIPT_PROTOCOL_VERSION } });
        for (const interest of this.interests.values()) this.open(interest);
      }),
      rpc.subscribe(() => {
        const connection = rpc.getSnapshot();
        if (connection.phase === "current") return;
        for (const interest of this.interests.values()) this.publish(interest, {
          ...interest.snapshot, phase: interest.snapshot.value ? "stale" : "pending", failure: null,
        });
      }),
    ];
    this.unsubscribe.push(rpc.onEvent(event => {
      if (event.kind === "voice") this.notify({ method: "voice/event", params: event.event });
      else if (event.kind === "transcriptSnapshot") this.notify({ method: "workbench/transcript/updated", params: event.data });
      else if (event.kind === "transcriptStream") this.notify({ method: "workbench/transcript/streamed", params: event.data });
      else if (event.kind === "transcriptState") this.notify({ method: "workspace/transcript/state", params: event.data });
    }));
  }

  daemon(scope?: WorkspaceScope) {
    const key = scope?.kind === "folder" ? `folder/${scope.location.daemonId}/${scope.location.projectId}`
      : scope?.kind === "thread" ? `thread/${scope.threadId}` : `installation/${scope?.daemonId ?? ""}`;
    const existing = this.facades.get(key);
    if (existing) return existing;
    const facade = new WorkbenchDaemonClient({
      request: <Result>(method: string, params: object) => this.request<Result>(method, params, scope),
      onNotification: listener => this.onWorkbenchNotification(listener),
      onReconnect: listener => this.rpc.onReconnect(listener),
      onDisconnect: listener => this.onDisconnect(listener),
    });
    this.facades.set(key, facade);
    return facade;
  }

  async releaseThread(subscriptionId: string) {
    this.threadObservations.get(subscriptionId)?.release();
    this.threadObservations.delete(subscriptionId);
  }

  async observeThread(request: {
    projectId: string; subscriptionId: string;
    target: Exclude<WorkbenchThreadRouteTarget, { kind: "new" | "draft" }>;
  }) {
    this.threadObservations.get(request.subscriptionId)?.release();
    const threadId = request.target.kind === "subagent" ? request.target.parentThreadId : request.target.threadId;
    // Translate replacement query generations into the renderer's retained revision space.
    let revision = 0;
    const projected = () => {
      const fact = observation.getSnapshot();
      const data = fact.value?.data;
      return data ? { ...data, runtime: fact.value?.runtime ?? {}, subscriptionId: request.subscriptionId, revision,
        freshness: fact.phase === "current" ? data.freshness : "loading" as const,
        error: fact.failure ?? data.error } : null;
    };
    const changed = () => {
      revision++;
      const value = projected();
      if (value) this.notify({ method: "workbench/thread-state/updated", params: value });
    };
    const observation = this.observe({ kind: "thread", threadId: ThreadReferenceSchema.parse(threadId) }, changed);
    this.threadObservations.set(request.subscriptionId, observation);
    try {
      const value = await this.waitFor(observation);
      if (!value.data) throw new Error(value.failure ?? "Thread observation is unavailable.");
      return { observation: projected() };
    } catch (error) {
      if (this.threadObservations.get(request.subscriptionId) === observation) {
        this.threadObservations.delete(request.subscriptionId);
        observation.release();
      }
      throw error;
    }
  }

  async request<Result>(method: string, params: object, scope?: WorkspaceScope): Promise<Result> {
        if (method === "thread/identity/resolve") {
          const target = z.object({ threadId: ThreadReferenceSchema }).parse(params);
          const observation = this.observe({ kind: "threadOwner", threadId: target.threadId });
          try {
            const result = await this.waitFor(observation);
            if (result.data.phase === "conflict") throw new Error(result.data.failure ?? "Conflicting thread ownership.");
            return { data: result.data.phase === "current" ? result.data.identity : null } as Result;
          } finally { observation.release(); }
        }
        if (method.startsWith("workbench/thread-state/")) {
          const mutation = WorkspaceThreadMutationSchema.parse({ ...params, method });
          return await this.rpc.requestRaw({ method: "workspace/thread/mutate", params: mutation }) as Result;
        }
        if (method === workbenchTranscriptOperations.read.method || method === workbenchTranscriptOperations.subscribe.method
          || method === workbenchTranscriptOperations.unsubscribe.method || method === workbenchTranscriptOperations.reportConformance.method) {
          const kind = method === workbenchTranscriptOperations.read.method ? "read"
            : method === workbenchTranscriptOperations.subscribe.method ? "subscribe"
              : method === workbenchTranscriptOperations.reportConformance.method ? "report" : "unsubscribe";
          const input = WorkspaceTranscriptRequestSchema.parse({ kind, params });
          return await this.rpc.requestRaw({ method: "workspace/transcript", params: input }) as Result;
        }
        if (!(method in workspaceCommandRoutes)) throw new Error("This daemon operation is not a workspace command.");
        const route = workspaceCommandRoutes[method as WorkspaceCommandMethod];
        const fields = z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(params)));
        if ((route === "thread" || route === "threadCwd") && scope?.kind === "thread") fields.threadId = scope.threadId;
        const destination = route === "folder" ? scope?.kind === "folder" || scope?.kind === "thread" ? scope : undefined
          : route === "installation" ? scope?.kind === "folder"
            ? { kind: "installation" as const, daemonId: scope.location.daemonId }
            : scope?.kind === "installation" || scope?.kind === "thread" ? scope : undefined
          : undefined;
        const command = WorkspaceCommandSchema.parse({ method, params: fields, scope: destination });
        // The semantic daemon facade validates each result with its domain schema.
        return await this.rpc.requestRaw({ method: "workspace/command", params: command }) as Result;
  }

  onWorkbenchNotification(listener: (notification: Notification) => void) {
    this.notificationListeners.add(listener);
    listener({ method: "workbench/transcript/capabilities", params: { protocolVersion: WORKBENCH_TRANSCRIPT_PROTOCOL_VERSION } });
    return () => { this.notificationListeners.delete(listener); };
  }

  onThreadEvent(listener: (notification: WorkbenchClientNotification, harness: WorkbenchHarness, daemonId: DaemonId) => void) {
    return this.rpc.onEvent(event => {
      if (event.kind === "threadEvent") listener(event.notification, event.harness, event.daemonId);
    });
  }

  onDisconnect(listener: () => void) {
    let connected = this.rpc.connected;
    return this.rpc.subscribe(() => {
      const next = this.rpc.connected;
      if (connected && !next) listener();
      connected = next;
    });
  }

  async connect(signal = this.cancellation.signal) {
    signal.throwIfAborted();
    if (this.rpc.connected) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { unsubscribe(); signal.removeEventListener("abort", abort); };
      const abort = () => { cleanup(); reject(signal.reason); };
      const unsubscribe = this.rpc.subscribe(() => {
        if (!this.rpc.connected) return;
        cleanup();
        resolve();
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else if (this.rpc.connected) { cleanup(); resolve(); }
    });
  }

  async waitFor<Kind extends WorkspaceQuery["kind"]>(observation: {
    getSnapshot(): WorkspaceQuerySnapshot<Kind>;
    subscribe(listener: () => void): () => void;
    signal?: AbortSignal;
  }): Promise<Extract<WorkspaceObservation, { kind: Kind }>> {
    const signal = observation.signal ?? this.cancellation.signal;
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      const cleanup = () => { unsubscribe(); signal.removeEventListener("abort", abort); };
      const abort = () => { cleanup(); reject(signal.reason); };
      const changed = () => {
        const fact = observation.getSnapshot();
        const value: WorkspaceObservation | null = fact.value;
        if (value?.kind === "threadOwner" && value.data.phase !== "pending") {
          cleanup();
          resolve(fact.value!);
        } else if (fact.phase === "failed" || fact.phase === "unavailable") {
          cleanup();
          reject(new Error(fact.failure ?? "Workspace query is unavailable."));
        } else if (fact.value && fact.phase === "current") {
          cleanup();
          resolve(fact.value);
        }
      };
      unsubscribe = observation.subscribe(changed);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else changed();
    });
  }

  observe<Query extends WorkspaceQuery>(
    query: Query,
    listener: () => void = () => {},
  ): WorkspaceQueryHandle<Query["kind"]> {
    if (this.disposed) throw new Error("Workspace client is closed.");
    const requested = WorkspaceQuerySchema.parse(query);
    const parsed: WorkspaceQuery = requested.kind === "projectThreads" && !requested.sidebarRowVersion
      ? { ...requested, sidebarRowVersion: WORKBENCH_THREAD_SIDEBAR_ROW_VERSION }
      : requested;
    let interest = [...this.interests.values()].find(item => areDeeplyEqual(item.query, parsed));
    const created = !interest;
    if (!interest) {
      interest = { id: crypto.randomUUID(), query: parsed, cancellation: new AbortController(),
        listeners: new Map(), raw: null, early: [], snapshot: { phase: "pending", failure: null, value: null } };
      this.interests.set(interest.id, interest);
    }
    const token = {};
    const retained = interest;
    const listeners = new Set([listener]);
    const cancellation = new AbortController();
    retained.listeners.set(token, { callbacks: listeners, cancellation });
    if (created && this.rpc.connected) this.open(retained);
    return {
      getSnapshot: () => retained.snapshot as WorkspaceQuerySnapshot<Query["kind"]>,
      signal: cancellation.signal,
      subscribe: (notify: () => void) => {
        listeners.add(notify);
        return () => { listeners.delete(notify); };
      },
      release: () => {
        if (!retained.listeners.delete(token)) return;
        cancellation.abort(new Error("Workspace query released."));
        if (retained.listeners.size) return;
        this.interests.delete(retained.id);
        retained.cancellation.abort();
        if (this.rpc.connected) {
          void this.rpc.requestRaw({ method: "workspace/release", params: {
            subscriptionId: retained.id, generation: this.rpc.getSnapshot().generation,
          } }).catch(error => {
            if (!(error instanceof WorkbenchRpcRequestInterruptedError)) this.warn("Workspace release failed", error);
          });
        }
      },
    };
  }

  async launchDraft(draftId: string, expectedRevision: number, options: WorkbenchSendThreadMessageOptions = {}) {
    const result = await this.rpc.requestRaw({ method: "workspace/draft/launch", params: {
      draftId, expectedRevision, additionalWritableRoots: options.additionalWritableRoots,
      context: { instructionInjections: options.instructionInjections,
        workflowIds: options.workflowIds, activatedSkillPaths: options.activatedSkillPaths },
    } });
    // The harness is additive: an older app server omits the applied identity's provider.
    const parsed = z.object({ threadId: z.uuid(), harness: WorkbenchHarnessSchema.optional() }).safeParse(result);
    if (!parsed.success) {
      reportClientSchemaError("Rejected workspace draft launch response", parsed.error);
      throw new Error("Draft launch response was invalid.");
    }
    return { threadId: parsed.data.threadId, harness: parsed.data.harness ?? null };
  }

  dispose() {
    this.facades.clear();
    if (this.disposed) return;
    this.disposed = true;
    this.cancellation.abort(new Error("Workspace client closed."));
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    for (const observation of this.threadObservations.values()) observation.release();
    this.threadObservations.clear();
    for (const interest of this.interests.values()) {
      interest.cancellation.abort();
      for (const owner of interest.listeners.values()) owner.cancellation.abort(new Error("Workspace client closed."));
    }
    this.interests.clear();
    this.notificationListeners.clear();
  }

  private open(interest: Interest) {
    const generation = this.rpc.getSnapshot().generation;
    const request = (query: WorkspaceQuery) => this.rpc.requestRaw({
      method: "workspace/observe", params: { subscriptionId: interest.id, generation, query },
    }, { signal: interest.cancellation.signal });
    const compatibleRequest = async () => {
      try {
        return await request(interest.query);
      } catch (error) {
        if (interest.query.kind !== "projectThreads" || !interest.query.sidebarRowVersion
          || !(error instanceof WorkbenchDaemonRequestError) || error.code !== -32600) throw error;
        const { sidebarRowVersion: _version, ...legacy } = interest.query;
        return await request(legacy);
      }
    };
    void compatibleRequest().then(result => {
      if (!this.active(interest) || !this.rpc.connected || generation !== this.rpc.getSnapshot().generation) return;
      const parsed = WorkspaceObservationSchema.safeParse(result);
      if (!parsed.success) {
        reportClientSchemaError("Rejected workspace query response", parsed.error);
        throw new Error("Workspace query response was invalid.");
      }
      this.accept(parsed.data);
    }, error => {
      if (!this.active(interest) || generation !== this.rpc.getSnapshot().generation) return;
      if (error instanceof WorkbenchRpcRequestInterruptedError) return;
      this.warn("Workspace query failed", error);
      this.publish(interest, { ...interest.snapshot, phase: interest.snapshot.value ? "stale" : "failed",
        failure: error instanceof Error ? error.message.slice(0, 512) : "Workspace query failed." });
    }).catch(error => {
      if (!this.active(interest) || !this.rpc.connected || generation !== this.rpc.getSnapshot().generation) return;
      this.warn("Workspace query decoding failed", error);
      this.publish(interest, { ...interest.snapshot, phase: "failed", failure: "Workspace query response was invalid." });
    });
  }

  private accept(value: WorkspaceObservation) {
    const interest = this.interests.get(value.subscriptionId);
    if (!interest || !this.rpc.connected || value.generation !== this.rpc.getSnapshot().generation) return;
    if (value.kind !== interest.query.kind) {
      this.warn("Workspace query kind mismatch", new Error("The server returned a different query kind."));
      this.rejectObservation(value.subscriptionId, value.generation);
      return;
    }
    if (interest.raw?.generation === value.generation && interest.raw.revision >= value.revision) return;
    interest.raw = value;
    const previous = interest.snapshot.value;
    if (previous?.kind === value.kind && value.phase !== "current") {
      if (value.kind === "thread" && previous.kind === "thread" && !value.data) value = { ...value, data: previous.data };
      else if (value.kind === "projectTree" && previous.kind === "projectTree" && !value.data) value = { ...value, data: previous.data };
      else if (value.kind === "presentation" && previous.kind === "presentation" && !value.data) value = { ...value, data: previous.data };
      else if (value.kind === "appState" && previous.kind === "appState" && !value.data) value = { ...value, data: previous.data };
      else if (value.kind === "runtime" && previous.kind === "runtime" && !value.data) value = { ...value, data: previous.data };
      else if (value.kind === "daemonRuntime" && previous.kind === "daemonRuntime" && !value.data) value = { ...value, data: previous.data };
      else if (value.kind === "network" && previous.kind === "network" && !value.data) value = { ...value, data: previous.data };
    }
    const raw = interest.raw;
    for (const delta of interest.early.splice(0)) this.applyDelta(interest, delta);
    // A replayed delta already published its newer value through `accept`.
    if (interest.raw === raw || !interest.raw) this.publish(interest, { phase: value.phase, failure: value.failure, value });
  }

  private acceptDelta(delta: WorkspaceObservationDelta) {
    const interest = this.interests.get(delta.subscriptionId);
    if (!interest || !this.rpc.connected || delta.generation !== this.rpc.getSnapshot().generation) return;
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
    let next: WorkspaceObservation;
    try {
      next = { ...applyObservationDelta(raw, delta.delta, workspaceObservationShape(raw.kind)), revision: delta.revision };
    } catch (error) {
      this.resync(interest, error instanceof Error ? error.message.slice(0, 300) : "invalid delta");
      return;
    }
    this.accept(next);
  }

  /** A delta that cannot apply means this copy diverged; re-observing returns the app's current full value. */
  private resync(interest: Interest, reason: string) {
    console.warn(`Workspace ${interest.query.kind} observation resync: ${reason}`);
    interest.raw = null;
    if (this.rpc.connected) this.open(interest);
  }

  private active(interest: Interest) { return !this.disposed && this.interests.get(interest.id) === interest; }

  private rejectObservation(subscriptionId: string, generation: number) {
    const interest = this.interests.get(subscriptionId);
    if (!interest || !this.rpc.connected || generation !== this.rpc.getSnapshot().generation) return;
    this.publish(interest, { ...interest.snapshot, phase: interest.snapshot.value ? "stale" : "failed",
      failure: "Workspace query update was invalid." });
  }

  private publish(interest: Interest, snapshot: WorkspaceQuerySnapshot) {
    if (!this.active(interest) || areDeeplyEqual(interest.snapshot, snapshot)) return;
    interest.snapshot = snapshot;
    for (const listener of [...interest.listeners.values()].flatMap(owner => [...owner.callbacks])) {
      try { listener(); }
      catch (error) { this.warn("Workspace query listener failed", error); }
    }
  }

  private warn(message: string, error: unknown) {
    console.warn(message, (error instanceof Error ? error.message : "Unexpected failure.")
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 512));
  }

  private notify(notification: Notification) {
    for (const listener of this.notificationListeners) {
      try { listener(notification); }
      catch (error) { this.warn("Workspace notification listener failed", error); }
    }
  }
}
