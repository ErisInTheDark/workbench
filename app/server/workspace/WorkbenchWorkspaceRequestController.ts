/*
 * Exports:
 * - default WorkbenchWorkspaceRequestController: own one app caller's named query interests and publication fences.
 */
import {
  WorkspaceObserveSchema, WorkspaceReleaseSchema,
  type WorkspaceObserve, type WorkspaceObservation, type WorkspaceThreadRows,
} from "workbench-shared/workbench/workspace/workspace-observation";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import type { DaemonId, ProjectId } from "workbench-shared/workbench/identity";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchProjectThreadSidebars } from "workbench-shared/workbench/thread/thread-state";
import { projectLogicalThreadRows } from "workbench-shared/workbench/project/workbench-project-projection";
import type WorkbenchPresentationController from "../state/WorkbenchPresentationController";
import type WorkbenchDaemonSources from "./WorkbenchDaemonSources";
import type WorkbenchDaemonSource from "./WorkbenchDaemonSource";
import type { WorkbenchDaemonTranscriptEvent } from "./WorkbenchDaemonSource";
import type WorkbenchWorkspaceController from "./WorkbenchWorkspaceController";
import type WorkbenchWorkspaceThreads from "./WorkbenchWorkspaceThreads";
import { z } from "zod";
import { WorkspaceCommandSchema, WorkspaceThreadMutationSchema, WorkspaceThreadActionSchema, workspaceCommandRoutes, type WorkspaceThreadMutation } from "workbench-shared/workbench/workspace/workspace-commands";
import { VoiceStartSchema, type VoiceSessionEvent } from "workbench-shared/workbench/voice/voice-session-contract";
import { WorkbenchRpcRequestInterruptedError } from "workbench-shared/workbench/WorkbenchRpcSocketClient";
import { randomUUID } from "node:crypto";
import type { WorkbenchClientNotification } from "workbench-shared/workbench/WorkbenchSocketClient";
import type { WorkbenchHarness, WorkbenchLogicalThreadRow } from "workbench-shared/types";
import {
  WorkspaceLayoutRequestSchema, type WorkspaceLayoutRequest,
} from "workbench-shared/workbench/workspace/workspace-commands";
import {
  createPresentationLayoutMutation, editPresentationHomeOrder, editPresentationPinnedOrder, editPresentationProjectOrder,
} from "../state/workbench-presentation-layout";
import {
  getWorkbenchThreadDisplayKey, getWorkbenchThreadDisplaySection,
} from "workbench-shared/workbench/thread/thread-display-order";
import { getProjectQualifiedThreadDisplayKey, getThreadDisplayThreadKey, parseProjectQualifiedThreadDisplayKey } from "workbench-shared/workbench/thread/thread-display-layout";
import { WorkbenchThreadStateMutationResultSchema, WorkbenchComposerProfileSlotSchema } from "workbench-shared/workbench/thread/thread-state";
import { WorkspaceTranscriptRequestSchema } from "workbench-shared/workbench/workspace/workspace-commands";
import {
  workbenchTranscriptOperations, conformWorkbenchTranscriptUpdated, conformWorkbenchTranscriptStreamed,
  type WorkbenchTranscriptUpdatedParams, type WorkbenchTranscriptStreamedParams,
} from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";

type Payload = {
  [Kind in WorkspaceObservation["kind"]]: Omit<
    Extract<WorkspaceObservation, { kind: Kind }>, "subscriptionId" | "generation" | "revision"
  >;
}[WorkspaceObservation["kind"]];
type Observation = ReturnType<WorkbenchDaemonSource["observe"]>;
type Json = z.infer<ReturnType<typeof z.json>>;
interface Interest {
  request: WorkspaceObserve;
  value: WorkspaceObservation;
  stop: Array<() => void>;
  sources: Map<DaemonId, { projectIds: ProjectId[]; observation: Observation }>;
  owner: ReturnType<WorkbenchWorkspaceThreads["observe"]> | null;
  thread: { key: string; observation: Observation } | null;
}
interface TranscriptSubscription {
  source: WorkbenchDaemonSource | null;
  projectId: ProjectId | null;
  threadId: string;
  read: { release(): void } | null;
  stop: Array<() => void>;
}

export default class WorkbenchWorkspaceRequestController {
  private readonly interests = new Map<string, Interest>();
  private readonly pendingRefresh = new Set<Interest>();
  private refreshing = false;
  private closed = false;
  private readonly cancellation = new AbortController();
  private readonly transcripts = new Map<string, TranscriptSubscription>();
  private readonly providerListeners = new Map<DaemonId, () => void>();
  private readonly voice = new Map<string, {
    source: WorkbenchDaemonSource;
    upstreamId: string;
    release: () => void;
    stop: Array<() => void>;
  }>();

  constructor(private readonly options: {
    workspace: WorkbenchWorkspaceController;
    sources: WorkbenchDaemonSources;
    threads: WorkbenchWorkspaceThreads;
    presentation: Pick<WorkbenchPresentationController, "read" | "subscribe" | "mutate">;
    network: {
      read(): Extract<Payload, { kind: "network" }>;
      subscribe(listener: () => void): () => void;
    };
    runtime: {
      read(): Extract<WorkspaceObservation, { kind: "runtime" }>["data"];
      subscribe(listener: () => void): () => void;
    };
    appState: {
      read(browserStateId: string | null): Promise<Extract<WorkspaceObservation, { kind: "appState" }>["data"]>;
      subscribe(browserStateId: string | null, listener: () => void): () => void;
    };
    publish(value: WorkspaceObservation): void;
    publishVoice(event: VoiceSessionEvent): void;
    publishThreadEvent(notification: WorkbenchClientNotification, harness: WorkbenchHarness, daemonId: DaemonId): void;
    publishTranscript(event: WorkbenchDaemonTranscriptEvent): void;
    warn(message: string): void;
  }) {}

  async layout(input: WorkspaceLayoutRequest) {
    const request = WorkspaceLayoutRequestSchema.parse(input);
    let snapshot = this.options.presentation.read();
    if (snapshot.revision !== request.expectedRevision) throw new Error("Layout changed in another browser.");
    const byIdentity = new Map<string, WorkbenchLogicalThreadRow>();
    for (const interest of this.interests.values()) {
      if (interest.value.kind !== "projectThreads") continue;
      for (const row of interest.value.data.rows) {
        if (!row.logicalProjectId) continue;
        const identity = row.entry.entryKind === "draft" ? `draft:${row.entry.draft.draftId}`
          : `${row.location.daemonId}/${row.location.projectId}/${row.entry.identity.threadId}`;
        byIdentity.set(identity, { ...row, logicalProjectId: row.logicalProjectId });
      }
    }
    let rows = [...byIdentity.values()];
    let changePriority: (() => Promise<number>) | null = null;
    if ((request.action === "homeEdit" || request.action === "projectEdit" || request.action === "pinnedEdit")
      && "sourceKey" in request.intent) {
      const sourceKey = request.intent.sourceKey;
      const source = rows.find(row => request.action === "projectEdit"
        ? row.logicalProjectId === request.logicalProjectId && getWorkbenchThreadDisplayKey(row.entry) === sourceKey
        : getProjectQualifiedThreadDisplayKey(row.logicalProjectId, getWorkbenchThreadDisplayKey(row.entry)) === sourceKey);
      const folderKey = request.action === "homeEdit"
        ? parseProjectQualifiedThreadDisplayKey(sourceKey)?.threadKey : sourceKey;
      if (!source && !folderKey?.startsWith("folder:")) throw new Error("The layout's source row is no longer observed.");
      const section = request.action === "homeEdit" ? request.intent.section
        : request.action === "projectEdit" ? request.intent.section : "pinned";
      if (source && getWorkbenchThreadDisplaySection(source.entry) !== section) {
        if (section === "settled" || source.entry.entryKind === "subagent" || source.entry.metadata.archived) {
          throw new Error("This thread cannot move to that section.");
        }
        if (source.entry.entryKind === "draft") {
          const draftId = source.entry.draft.draftId;
          const draft = snapshot.drafts.find(draft => draft.id === draftId);
          if (!draft || draft.phase !== "unsent") throw new Error("The unsent draft is unavailable.");
          changePriority = async () => this.options.presentation.mutate({ kind: "setDraftPriority", draftId,
            expectedRevision: draft.revision, pinned: section === "pinned", snoozed: section === "snoozed" }).revision;
        } else {
          const threadId = source.entry.identity.threadId;
          const expectedRevision = snapshot.revision;
          changePriority = async () => {
            await this.options.threads.withThread(threadId, async (daemon, owner) => {
              const accepted = WorkbenchThreadStateMutationResultSchema.parse(await daemon.request(
                "workbench/thread-state/priority/set", { projectId: owner.location.projectId,
                  sourceKey: `${owner.identity.harness}:${owner.identity.threadId}`, priority: section }));
              if (!accepted.accepted) throw new Error("The daemon rejected the priority change.");
            }, this.cancellation.signal);
            return expectedRevision;
          };
        }
        rows = rows.map(row => row !== source || row.entry.entryKind === "subagent" ? row : {
          ...row, entry: { ...row.entry, metadata: { archived: false, pinned: section === "pinned", snoozed: section === "snoozed" } },
        });
      }
    }
    const layouts: Array<ReturnType<typeof createPresentationLayoutMutation>> = [];
    switch (request.action) {
      case "homeEdit":
        layouts.push(...editPresentationHomeOrder(snapshot, rows, request.intent)
          .map(selection => createPresentationLayoutMutation(snapshot, rows, selection)));
        break;
      case "projectSave":
      case "projectAndHomeSave":
        layouts.push(createPresentationLayoutMutation(snapshot, rows, {
          scope: "project", logicalProjectId: request.logicalProjectId, order: request.order,
        }));
        if (request.action === "projectAndHomeSave") layouts.push(createPresentationLayoutMutation(snapshot, rows, {
          scope: "home", logicalProjectId: null, order: request.homeOrder,
        }));
        break;
      case "homeSave":
        layouts.push(createPresentationLayoutMutation(snapshot, rows, { scope: "home", logicalProjectId: null, order: request.order }));
        break;
      case "pinnedSave":
        layouts.push(createPresentationLayoutMutation(snapshot, rows, { scope: "pinned", logicalProjectId: null, order: request.order }));
        break;
      case "projectEdit": {
        const order = editPresentationProjectOrder(snapshot, request.logicalProjectId, rows, request.intent);
        if (!order) throw new Error("Project layout position is no longer available.");
        layouts.push(createPresentationLayoutMutation(snapshot, rows, { scope: "project", logicalProjectId: request.logicalProjectId, order }));
        if (request.homeOrder) layouts.push(createPresentationLayoutMutation(snapshot, rows, { scope: "home", logicalProjectId: null, order: request.homeOrder }));
        break;
      }
      case "pinnedEdit": {
        const order = editPresentationPinnedOrder(snapshot, rows, request.intent);
        if (!order) throw new Error("Pinned layout position is no longer available.");
        layouts.push(createPresentationLayoutMutation(snapshot, rows, { scope: "pinned", logicalProjectId: null, order }));
        break;
      }
    }
    if (changePriority) {
      const expectedRevision = await changePriority();
      snapshot = this.options.presentation.read();
      if (snapshot.revision !== expectedRevision) throw new Error("Priority changed, but another presentation write superseded the layout move.");
    }
    return this.options.presentation.mutate({
      kind: "saveLayouts", expectedRevision: snapshot.revision,
      layouts: layouts.map(({ kind: _kind, expectedRevision: _revision, ...layout }) => layout),
    });
  }

  async mutateThread(input: WorkspaceThreadMutation) {
    const request = WorkspaceThreadMutationSchema.parse(input);
    return this.options.threads.withThread(request.identity.threadId, async (source, owner) => {
      const { method, ...params } = request;
      const resolved = { ...params, projectId: owner.location.projectId,
        identity: { threadId: owner.identity.threadId, harness: owner.identity.harness } };
      if (request.method === "workbench/thread-state/snooze/until") {
        return this.options.threads.withThread(request.target.identity.threadId, (targetSource, targetOwner) => {
          if (targetSource !== source) throw new Error("Dependent snooze requires threads on the same daemon.");
          return source.request<Json>(method, { ...resolved,
            target: { projectId: targetOwner.location.projectId, identity: {
              threadId: targetOwner.identity.threadId, harness: targetOwner.identity.harness,
            } } });
        }, this.cancellation.signal);
      }
      return source.request<Json>(method, resolved);
    }, this.cancellation.signal);
  }

  async threadAction(input: z.infer<typeof WorkspaceThreadActionSchema>) {
    const { threadId, intent } = WorkspaceThreadActionSchema.parse(input);
    return this.options.threads.withThread(threadId, async (source, owner) => {
      const projectId = owner.location.projectId;
      const identity = { harness: owner.identity.harness, threadId: owner.identity.threadId };
      if (intent.kind === "stop") {
        await source.daemon.threads.stop({ threadId: identity.threadId, intent: "stop" });
        return { accepted: true };
      }
      if (intent.kind === "priority") return source.request<Json>(
        "workbench/thread-state/priority/set", {
          projectId, priority: intent.priority,
          sourceKey: getThreadDisplayThreadKey(identity.harness, identity.threadId),
        });
      if (intent.kind === "snoozeUntil") return this.options.threads.withThread(intent.targetThreadId,
        (targetSource, target) => {
          if (source !== targetSource) throw new Error("Dependent snooze requires threads on the same daemon.");
          return source.request<Json>("workbench/thread-state/snooze/until", {
            projectId, identity, target: { projectId: target.location.projectId,
              identity: { harness: target.identity.harness, threadId: target.identity.threadId } },
          });
        }, this.cancellation.signal);
      const mutation = intent.kind === "pin" ? { method: "workbench/thread-state/pin/set", pinned: intent.pinned }
        : intent.kind === "snooze" ? { method: "workbench/thread-state/snooze/set", snoozed: intent.snoozed }
          : intent.kind === "archive" ? { method: "workbench/thread-state/archive/set", archived: intent.archived }
            : intent.kind === "status" ? { method: "workbench/thread-state/status/set", status: intent.status }
              : { method: intent.kind === "restore" ? "workbench/thread-state/restore" : "workbench/thread-state/settle" };
      const { method, ...params } = mutation;
      return source.request<Json>(method, { ...params, projectId, identity });
    }, this.cancellation.signal);
  }

  async transcript(input: z.infer<typeof WorkspaceTranscriptRequestSchema>) {
    if (this.closed) throw new Error("Workspace connection is closed.");
    const request = WorkspaceTranscriptRequestSchema.parse(input);
    if (request.kind === "report") {
      this.options.warn(`Browser transcript conformance: ${request.params.issues.length} invalid fields, ${request.params.repairedPaths.length} repairs.`);
      return { reported: true };
    }
    if (request.kind === "unsubscribe") {
      this.releaseTranscript(request.params.subscriptionId);
      return { unsubscribed: true };
    }
    if (request.kind === "read") return this.options.threads.withThread(request.params.threadId, (source, owner) =>
      source.request<Json>(workbenchTranscriptOperations.read.method, {
        ...request.params, threadId: owner.identity.threadId, protocolVersion: 4,
      }), this.cancellation.signal);

    const { subscriptionId: id, ...query } = request.params;
    this.releaseTranscript(id);
    const subscription: TranscriptSubscription = {
      source: null, projectId: null, threadId: query.threadId, read: null, stop: [],
    };
    this.transcripts.set(id, subscription);
    let changed = () => {};
    const ownership = this.options.threads.observe(query.threadId, () => changed());
    subscription.stop.push(ownership.release);
    changed = () => {
      if (this.transcripts.get(id) !== subscription) return;
      const owner = ownership.getSnapshot();
      const source = owner.phase === "current" ? this.options.sources.get(owner.location.daemonId) : null;
      if (owner.phase !== "current" || !source) {
        subscription.read?.release();
        subscription.read = null;
        subscription.source = null;
        this.options.publishTranscript({ kind: "transcriptState", data: {
          subscriptionId: id, phase: owner.phase === "pending" ? "pending" : "failed",
          failure: owner.phase === "current" ? "The transcript owner is unavailable."
            : owner.failure ?? (owner.phase === "pending" ? null : "The transcript owner is unavailable."),
        } });
        return;
      }
      if (subscription.read && subscription.source === source && subscription.projectId === owner.location.projectId) return;
      subscription.read?.release();
      subscription.source = source;
      subscription.projectId = owner.location.projectId;
      subscription.threadId = owner.identity.threadId;
      this.observeProvider(source);
      try {
        subscription.read = source.observeTranscript({ ...query, threadId: owner.identity.threadId }, event => {
          if (this.transcripts.get(id) !== subscription || subscription.source !== source) return;
          this.options.publishTranscript({ ...event, data: { ...event.data, subscriptionId: id } } as WorkbenchDaemonTranscriptEvent);
        });
      } catch (error) {
        subscription.read = null;
        subscription.source = null;
        const message = this.failure(error);
        this.options.warn(`Transcript subscription failed: ${message}`);
        this.options.publishTranscript({ kind: "transcriptState", data: {
          subscriptionId: id, phase: "failed", failure: message,
        } });
      }
    };
    changed();
    return { subscribed: true };
  }

  async command(input: z.infer<typeof WorkspaceCommandSchema>) {
    if (this.closed) throw new Error("Workspace connection is closed.");
    const command = WorkspaceCommandSchema.parse(input);
    if (command.method === "profiles/target/read" || command.method === "profiles/target/set") {
      const slot = WorkbenchComposerProfileSlotSchema.parse(command.params.slot);
      if (slot.kind === "thread") return this.options.threads.withThread(slot.threadId,
        (source, owner) => source.request<Json>(command.method, {
          ...command.params, slot: { ...slot, projectId: owner.location.projectId,
            threadId: owner.identity.threadId, harness: owner.identity.harness },
        }), this.cancellation.signal);
    }
    const route = workspaceCommandRoutes[command.method];
    if (route === "thread") {
      const threadId = command.params.threadId;
      if (typeof threadId !== "string") throw new Error("Thread identity is required.");
      return this.options.threads.withThread(threadId, (source, owner) =>
        source.request<Json>(command.method, {
          ...command.params, threadId: owner.identity.threadId, projectId: owner.location.projectId,
        }), this.cancellation.signal);
    }
    if (route === "session") {
      const sessionId = command.params.sessionId;
      const session = typeof sessionId === "string" ? this.voice.get(sessionId) : null;
      if (!session) throw new Error("This caller does not own the voice session.");
      return session.source.request<Json>(command.method, { ...command.params, sessionId: session.upstreamId });
    }
    const scope = command.scope;
    if (scope?.kind === "thread") {
      return this.options.threads.withThread(scope.threadId, (source, owner) =>
        this.executeSourceCommand(source, command.method, route === "folder"
          ? { ...command.params, projectId: owner.location.projectId } : command.params),
      this.cancellation.signal);
    }
    const source = scope?.kind === "folder" ? this.options.sources.get(scope.location.daemonId)
      : scope?.kind === "installation" && scope.daemonId ? this.options.sources.get(scope.daemonId)
      : this.options.sources.attached;
    if (!source?.available) throw new WorkbenchRpcRequestInterruptedError("The selected source is unavailable; request was not sent.", false);
    const params = { ...command.params };
    if (route === "folder") {
      if (scope?.kind !== "folder") throw new Error("Folder location is required.");
      const projects = this.options.workspace.getSnapshot();
      const target = scope.location;
      const observed = projects.projects.some(project => project.locations.some(location =>
        location.target.daemonId === target.daemonId && location.target.projectId === target.projectId && location.project)
        || project.observedLocations?.some(location => location.daemonId === target.daemonId && location.projectId === target.projectId))
        || projects.observedProjects.some(project => project.locations.some(location =>
          location.location.daemonId === target.daemonId && location.location.projectId === target.projectId));
      if (!observed) throw new Error("The selected folder is not observed on its daemon.");
      params.projectId = target.projectId;
    }
    return this.executeSourceCommand(source, command.method, params);
  }

  private async executeSourceCommand(
    source: WorkbenchDaemonSource, method: z.infer<typeof WorkspaceCommandSchema>["method"], params: Record<string, Json>,
  ) {
    if (method === "account/limits/read" || method === "models/list") this.observeProvider(source);
    if (method !== "voice/start") return source.request<Json>(method, params);
    const start = VoiceStartSchema.parse(params);
    if (this.voice.has(start.sessionId)) throw new Error("Voice session is already owned.");
    const upstreamId = randomUUID();
    const session = {
      source, upstreamId, release: source.retain(), stop: [] as Array<() => void>,
    };
    this.voice.set(start.sessionId, session);
    session.stop.push(source.daemon.onVoiceEvent(event => {
        if (event.sessionId !== upstreamId || !this.voice.has(start.sessionId)) return;
        this.options.publishVoice(event.type === "transcript"
          ? { ...event, sessionId: start.sessionId, delta: { ...event.delta, sessionId: start.sessionId } }
          : { ...event, sessionId: start.sessionId });
        if (event.type === "finished" || event.type === "cancelled" || event.type === "error") this.releaseVoice(start.sessionId);
      }), source.socket.onConnectionClose(() => {
        if (!this.voice.has(start.sessionId)) return;
        this.options.publishVoice({ type: "error", sessionId: start.sessionId, message: "Voice source disconnected." });
        this.releaseVoice(start.sessionId);
      }));
    try { return await source.request<Json>(method, { ...params, sessionId: upstreamId }); }
    catch (error) {
      if (!(error instanceof WorkbenchRpcRequestInterruptedError) || !error.dispatched) this.releaseVoice(start.sessionId);
      throw error;
    }
  }

  observe(input: WorkspaceObserve) {
    if (this.closed) throw new Error("Workspace connection is closed.");
    const request = WorkspaceObserveSchema.parse(input);
    const existing = this.interests.get(request.subscriptionId);
    if (existing && request.generation <= existing.request.generation) {
      if (request.generation === existing.request.generation && areDeeplyEqual(request.query, existing.request.query)) {
        return existing.value;
      }
      throw new Error("Workspace observation belongs to an obsolete generation.");
    }
    if (existing) this.retire(existing);
    const interest: Interest = {
      request, stop: [], sources: new Map(), owner: null, thread: null,
      value: { ...this.initial(request), subscriptionId: request.subscriptionId, generation: request.generation, revision: 0 },
    };
    this.interests.set(request.subscriptionId, interest);
    const refresh = () => this.refresh(interest);
    switch (request.query.kind) {
      case "search": {
        let observation: ReturnType<WorkbenchWorkspaceController["search"]["observe"]> | undefined;
        observation = this.options.workspace.search.observe(request.query.request, () => {
          if (observation) this.update(interest, observation.getSnapshot());
        });
        interest.stop.push(observation.release);
        this.update(interest, observation.getSnapshot());
        break;
      }
      case "daemonRuntime": interest.stop.push(this.options.sources.subscribe(refresh)); break;
      case "network": interest.stop.push(this.options.network.subscribe(refresh)); break;
      case "runtime": interest.stop.push(this.options.runtime.subscribe(refresh)); break;
      case "presentation": interest.stop.push(this.options.presentation.subscribe(refresh)); break;
      case "appState": {
        const browserStateId = request.query.browserStateId;
        let reading = false;
        let dirty = false;
        const read = () => {
          dirty = true;
          if (reading || !this.active(interest)) return;
          reading = true;
          void (async () => {
            try {
              while (dirty && this.active(interest)) {
                dirty = false;
                try {
                  const data = await this.options.appState.read(browserStateId);
                  if (this.active(interest)) this.update(interest, { kind: "appState", phase: "current", failure: null, data });
                } catch (error) {
                  if (!this.active(interest)) return;
                  const message = this.failure(error);
                  this.options.warn(`App state observation failed: ${message}`);
                  this.update(interest, { kind: "appState", phase: "failed", failure: message,
                    data: interest.value.kind === "appState" ? interest.value.data : null });
                }
              }
            } finally { reading = false; }
          })();
        };
        interest.stop.push(this.options.appState.subscribe(browserStateId, read));
        let registrations = this.options.workspace.getBindings();
        interest.stop.push(this.options.workspace.subscribe(() => {
          const next = this.options.workspace.getBindings();
          if (areDeeplyEqual(registrations, next)) return;
          registrations = next;
          read();
        }));
        read();
        break;
      }
      case "projects":
        interest.stop.push(this.options.workspace.subscribe(refresh),
          this.options.workspace.retain({ summaries: true, daemonIds: request.query.daemonIds }));
        break;
      case "projectGroups":
        interest.stop.push(this.options.workspace.subscribe(refresh),
          this.options.workspace.retain({ summaries: true, placement: true }));
        break;
      case "projectThreads":
        interest.stop.push(this.options.workspace.subscribe(refresh),
          this.options.presentation.subscribe(refresh), this.options.workspace.retain());
        break;
      case "projectTree": {
        const source = this.options.sources.get(request.query.location.daemonId);
        if (source) interest.thread = {
          key: request.query.location.projectId,
          observation: source.observe({ kind: "projectTree", projectId: request.query.location.projectId }, refresh),
        };
        interest.stop.push(this.options.sources.subscribe(refresh));
        break;
      }
      case "thread":
      case "threadOwner":
        interest.owner = this.options.threads.observe(request.query.threadId, refresh);
        interest.stop.push(this.options.sources.subscribe(refresh));
        break;
    }
    this.refresh(interest);
    return interest.value;
  }

  release(input: { subscriptionId: string; generation: number }) {
    const request = WorkspaceReleaseSchema.parse(input);
    const interest = this.interests.get(request.subscriptionId);
    if (interest?.request.generation === request.generation) this.retire(interest);
    return { released: true };
  }

  dispose() {
    this.closed = true;
    this.cancellation.abort(new Error("Workspace caller disconnected before dispatch."));
    for (const id of this.transcripts.keys()) this.releaseTranscript(id);
    for (const stop of this.providerListeners.values()) stop();
    this.providerListeners.clear();
    for (const interest of this.interests.values()) this.retire(interest);
    for (const [sessionId, session] of this.voice) {
      void session.source.daemon.voice.cancel(session.upstreamId).catch(error => {
        if (!(error instanceof WorkbenchRpcRequestInterruptedError)) this.options.warn(`Voice cleanup failed: ${this.failure(error)}`);
      }).finally(() => this.releaseVoice(sessionId));
    }
    this.pendingRefresh.clear();
  }

  private initial(request: WorkspaceObserve): Payload {
    const base = { phase: "pending" as const, failure: null };
    switch (request.query.kind) {
      case "search": return { ...base, kind: "search", data: { results: [] }, sources: [] };
      case "daemonRuntime": return { ...base, kind: "daemonRuntime", daemonId: request.query.daemonId ?? null, data: null };
      case "network": return this.options.network.read();
      case "runtime": return { ...base, kind: "runtime", data: this.options.runtime.read() };
      case "presentation": return { phase: "current", failure: null, kind: "presentation", data: this.options.presentation.read() };
      case "projects": return { ...base, kind: "projects", data: this.options.workspace.getSnapshot() };
      case "projectGroups": return { ...base, kind: "projectGroups", data: this.options.workspace.getProjectGroups().data };
      case "projectThreads": return { ...base, kind: "projectThreads", data: { rows: [], projects: [] } };
      case "threadOwner": return { ...base, kind: "threadOwner", data: { phase: "pending", failure: null } };
      case "thread": return { ...base, kind: "thread", owner: { phase: "pending", failure: null }, data: null };
      case "projectTree": return { ...base, kind: "projectTree", sourceGeneration: 0, data: null };
      case "appState": return { ...base, kind: "appState", data: null };
    }
  }

  private refresh(interest: Interest) {
    if (!this.active(interest)) return;
    this.pendingRefresh.add(interest);
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      while (this.pendingRefresh.size) {
        const next = this.pendingRefresh.values().next().value!;
        this.pendingRefresh.delete(next);
        if (this.active(next)) this.project(next);
      }
    } finally { this.refreshing = false; }
  }

  private project(interest: Interest) {
    const query = interest.request.query;
    switch (query.kind) {
      case "search": return;
      case "daemonRuntime": {
        const source = query.daemonId ? this.options.sources.get(query.daemonId) : this.options.sources.attached;
        if (interest.thread && interest.thread.key !== source?.id) {
          const previous = interest.thread;
          interest.thread = null;
          previous.observation.release();
        }
        if (source && !interest.thread) interest.thread = {
          key: source.id, observation: source.observe({ kind: "runtime" }, () => this.refresh(interest)),
        };
        const fact = interest.thread?.observation.getSnapshot();
        this.update(interest, { kind: "daemonRuntime", daemonId: source?.id ?? null,
          phase: fact?.phase ?? "pending", failure: fact?.failure ?? null,
          data: fact?.value?.kind === "runtime" ? fact.value.data : null });
        return;
      }
      case "network": this.update(interest, this.options.network.read()); return;
      case "runtime": this.update(interest, { kind: "runtime", phase: "current", failure: null, data: this.options.runtime.read() }); return;
      case "presentation": this.update(interest, { kind: "presentation", phase: "current", failure: null, data: this.options.presentation.read() }); return;
      case "appState": return;
      case "projects": {
        const all = this.options.workspace.getSnapshot();
        const selected = query.daemonIds;
        const data = selected ? this.options.workspace.select(selected) : all;
        const complete = data.catalogues.length > 0 && data.catalogues.every(source => source.phase === "current");
        const failure = data.catalogues.find(source => source.failure)?.failure ?? null;
        this.update(interest, { kind: "projects", phase: complete ? "current"
          : data.projects.length || data.observedProjects.length ? "stale" : failure ? "failed" : "pending", failure, data });
        return;
      }
      case "projectGroups": {
        const groups = this.options.workspace.getProjectGroups();
        this.update(interest, { kind: "projectGroups", ...groups });
        return;
      }
      case "projectThreads": this.projectRows(interest); return;
      case "projectTree": {
        if (!interest.thread) {
          const source = this.options.sources.get(query.location.daemonId);
          if (source) interest.thread = {
            key: query.location.projectId,
            observation: source.observe({ kind: "projectTree", projectId: query.location.projectId }, () => this.refresh(interest)),
          };
        }
        const fact = interest.thread?.observation.getSnapshot();
        this.update(interest, { kind: "projectTree", sourceGeneration: fact?.value?.generation ?? 0,
          phase: fact?.phase ?? "pending", failure: fact?.failure ?? null,
          data: fact?.value?.kind === "projectTree" ? fact.value.project : null });
        return;
      }
      case "threadOwner":
      case "thread": {
        const owner = interest.owner?.getSnapshot() ?? { phase: "pending" as const, failure: null };
        const phase = owner.phase === "conflict" ? "failed" : owner.phase;
        const failure = owner.phase === "current" ? null : owner.failure;
        if (query.kind === "threadOwner") {
          this.update(interest, { kind: "threadOwner", phase, failure, data: owner });
          return;
        }
        const key = owner.phase === "current" ? `${owner.location.daemonId}/${owner.location.projectId}/${owner.identity.threadId}` : null;
        if (interest.thread?.key !== key) {
          const previous = interest.thread;
          interest.thread = null;
          previous?.observation.release();
          if (owner.phase === "current" && key) {
            const source = this.options.sources.get(owner.location.daemonId);
            if (source) {
              this.observeProvider(source);
              interest.thread = { key, observation: source.observe({
              kind: "thread", projectId: owner.location.projectId, threadId: ThreadReferenceSchema.parse(owner.identity.threadId),
              }, () => this.refresh(interest)) };
            }
          }
        }
        const fact = interest.thread?.observation.getSnapshot();
        this.update(interest, { kind: "thread", owner, phase: fact?.phase ?? phase, failure: fact?.failure ?? failure,
          data: fact?.value?.kind === "thread" ? fact.value.data : null });
      }
    }
  }

  private projectRows(interest: Interest) {
    const query = interest.request.query;
    if (query.kind !== "projectThreads") return;
    const workspace = this.options.workspace.getSnapshot();
    const selected = query.projects;
    const targets = new Map<DaemonId, Set<ProjectId>>();
    const add = (daemonId: DaemonId, projectId: ProjectId) => {
      const ids = targets.get(daemonId) ?? new Set<ProjectId>();
      ids.add(projectId);
      targets.set(daemonId, ids);
    };
    for (const project of workspace.projects) {
      if (selected && !selected.some(ref => ref.kind === "logical" && ref.projectId === project.id)) continue;
      for (const location of project.locations) add(location.daemonId, location.target.projectId);
      for (const location of project.observedLocations ?? []) add(location.daemonId, location.projectId);
    }
    for (const ref of selected ?? []) if (ref.kind === "location") add(ref.location.daemonId, ref.location.projectId);
    if (!selected) for (const project of workspace.observedProjects) {
      for (const location of project.locations) add(location.location.daemonId, location.location.projectId);
    }
    for (const [id, existing] of interest.sources) {
      const projectIds = [...targets.get(id) ?? []].sort();
      if (areDeeplyEqual(projectIds, existing.projectIds)) continue;
      interest.sources.delete(id);
      existing.observation.release();
    }
    for (const [id, ids] of targets) {
      if (interest.sources.has(id)) continue;
      const source = this.options.sources.get(id);
      if (!source) continue;
      const projectIds = [...ids].sort();
      interest.sources.set(id, { projectIds,
        observation: source.observe({ kind: "projectThreads", projectIds }, () => this.refresh(interest)) });
    }
    const sidebars = new Map<DaemonId, WorkbenchProjectThreadSidebars>();
    const projects: WorkspaceThreadRows["projects"] = [];
    for (const [daemonId, ids] of targets) {
      const fact = interest.sources.get(daemonId)?.observation.getSnapshot();
      const rows = fact?.value?.kind === "projectThreads" ? fact.value.projects : [];
      sidebars.set(daemonId, { projects: rows.flatMap(row => row.sidebar ? [row.sidebar] : []) });
      for (const projectId of ids) {
        const row = rows.find(row => row.projectId === projectId);
        projects.push({ location: { daemonId, projectId }, phase: fact?.phase === "current" ? row?.phase ?? "pending" : fact?.phase ?? "pending",
          failure: row?.failure ?? fact?.failure ?? null });
      }
    }
    const rows: WorkspaceThreadRows["rows"] = projectLogicalThreadRows(workspace.projects, sidebars, this.options.presentation.read())
      .filter(row => targets.get(row.location.daemonId)?.has(row.location.projectId));
    for (const project of workspace.observedProjects) for (const location of project.locations) {
      if (!targets.get(location.location.daemonId)?.has(location.location.projectId)) continue;
      const sidebar = sidebars.get(location.location.daemonId)?.projects.find(item => item.projectId === location.location.projectId);
      for (const entry of sidebar?.entries ?? []) {
        if (entry.entryKind !== "draft") rows.push({
          logicalProjectId: null, location: location.location, hostname: location.hostname,
          rootPath: location.project.rootPath, entry, observedOnly: true,
        });
      }
    }
    const discoveryPending = !projects.length && (workspace.catalogues.length === 0
      || workspace.catalogues.some(source => source.phase === "pending" || source.phase === "stale"));
    const failure = projects.find(project => project.failure)?.failure ?? null;
    this.update(interest, { kind: "projectThreads",
      phase: !discoveryPending && projects.every(project => project.phase === "current") ? "current"
        : rows.length ? "stale" : failure ? "failed" : "pending",
      failure, data: { rows, projects } });
  }

  private update(interest: Interest, payload: Payload) {
    if (!this.active(interest)) return;
    const next = { ...payload, subscriptionId: interest.request.subscriptionId,
      generation: interest.request.generation, revision: interest.value.revision };
    if (areDeeplyEqual(next, interest.value)) return;
    interest.value = { ...next, revision: next.revision + 1 };
    this.options.publish(interest.value);
  }

  private active(interest: Interest) {
    return !this.closed && this.interests.get(interest.request.subscriptionId) === interest;
  }

  private retire(interest: Interest) {
    this.interests.delete(interest.request.subscriptionId);
    for (const stop of interest.stop) stop();
    interest.owner?.release();
    interest.thread?.observation.release();
    for (const source of interest.sources.values()) source.observation.release();
    this.pendingRefresh.delete(interest);
  }

  private failure(error: unknown) {
    return (error instanceof Error ? error.message : "Workspace query failed.")
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 512);
  }

  private releaseVoice(sessionId: string) {
    const session = this.voice.get(sessionId);
    if (!session) return;
    this.voice.delete(sessionId);
    for (const stop of session.stop) stop();
    session.release();
  }

  private releaseTranscript(id: string) {
    const subscription = this.transcripts.get(id);
    if (!subscription) return;
    this.transcripts.delete(id);
    subscription.read?.release();
    for (const stop of subscription.stop) stop();
  }

  private observeProvider(source: WorkbenchDaemonSource) {
    if (this.providerListeners.has(source.id)) return;
    this.providerListeners.set(source.id, source.socket.onNotification((notification, harness) => {
      if (notification.method === "account/updated" || notification.method === "account/rateLimits/updated") {
        this.options.publishThreadEvent(notification, harness, source.id);
        return;
      }
      const params = notification.params;
      const threadId = "threadId" in params && typeof params.threadId === "string" ? params.threadId
        : "thread" in params && params.thread && typeof params.thread === "object" && "id" in params.thread
          && typeof params.thread.id === "string" ? params.thread.id : null;
      if (!threadId) return;
      const demanded = [...this.interests.values()].some(interest => {
        const owner = interest.owner?.getSnapshot();
        return owner?.phase === "current" && owner.location.daemonId === source.id && owner.identity.threadId === threadId;
      }) || [...this.transcripts.values()].some(subscription => subscription.source === source && subscription.threadId === threadId);
      if (demanded) this.options.publishThreadEvent(notification, harness, source.id);
    }));
  }
}
