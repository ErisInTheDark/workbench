/*
 * Exports:
 * - ThreadControllerTarget: project-qualified provider, subagent or draft identity.
 * - ThreadGitArcProposalObservation: source-local loading, loaded, refreshing, or failed proposal validity.
 * - ThreadControllerSnapshot: one thread surface, with source-local SQLite state.
 * - ThreadControllerPorts: native data, observation and transcript adapter ports.
 * - default WorkbenchThreadController: own shared thread admission, reads, proposal demand, and source lifecycle.
 */
import type { ThreadPayload, WorkbenchPendingUserInputRequest, WorkbenchReadThreadOptions, WorkbenchSubagentSummary, WorkbenchControls } from "workbench-shared/types";
import type { RateLimitSnapshot } from "workbench-shared/codex/generated/app-server/v2/RateLimitSnapshot";
import type { GitCheckpointProposal } from "workbench-shared/workbench/git/checkpoint-contracts";
import { GitArcFailureException, type GitArcFailure } from "workbench-shared/workbench/git/git-arc-failures";
import type { WorkbenchThreadSidebarEntry, WorkbenchThreadRouteTarget as WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import { getCurrentInProgressTurn } from "workbench-shared/codex/thread-state";
import { getNextSubagentHydrationBatch } from "./thread/thread-subagents";
import type ThreadObservationController from "./thread/ThreadObservationController";
import { getThreadObservationKey } from "./thread/ThreadObservationController";
import type ThreadTranscriptProjectionController from "./transcript/ThreadTranscriptProjectionController";
import type { ThreadTranscriptProjectionState } from "./transcript/ThreadTranscriptProjectionController";
import ThreadHistoryRetentionController, { type ThreadHistoryRetentionSurface } from "./thread/ThreadHistoryRetentionController";

export type ThreadControllerTarget = Exclude<WorkbenchThreadTarget, { kind: "new" }>;
type ThreadEntry = Exclude<WorkbenchThreadSidebarEntry, { entryKind: "draft" }>;
export type ThreadGitArcProposalObservation =
  | { error: string; failure?: GitArcFailure; status: "failed" }
  | { proposal: GitCheckpointProposal; refreshing?: true; status: "loaded" }
  | { status: "loading" };
export interface ThreadControllerSnapshot {
  status: "loading" | "ready" | "failed";
  error: string | null;
  document: ThreadPayload | null;
  entry: ThreadEntry | null;
  gitArcProposals: Record<string, ThreadGitArcProposalObservation>;
  pendingQuestionnaire: WorkbenchPendingUserInputRequest | null;
  rateLimits: RateLimitSnapshot | null;
  subagents: WorkbenchSubagentSummary[];
  transcript: ThreadTranscriptProjectionState;
  relatedDocuments: Record<string, ThreadPayload>;
}
export interface ThreadControllerPorts {
  controls: Pick<WorkbenchControls, "compactThread" | "stopThread" | "setCurrentThreadAgent" | "setCurrentThreadModel" | "setCurrentThreadReasoningEffort" | "setCurrentThreadServiceTier" | "setCurrentThreadComposerSettings" | "submitPendingUserInputRequest" | "updateThreadStateWithAcceptance">;
  observations: ThreadObservationController;
  readGitArcProposal?: (input: {
    cwd: string;
    harness: ThreadPayload["harness"];
    proposalId: string;
    rootId?: string;
    threadId: string;
  }) => Promise<GitCheckpointProposal>;
  read: (options: WorkbenchReadThreadOptions, beforeCommit: () => Promise<void>, selectionBound: boolean) => Promise<ThreadPayload | null>;
  releaseHistoricalTurns: (turnIds: readonly string[]) => ThreadPayload | null;
  readNative: () => Pick<ThreadControllerSnapshot, "document" | "pendingQuestionnaire" | "rateLimits">;
  subscribeNative: (listener: () => void) => () => void;
  subscribeGitArcProposalRefresh?: (listener: () => void) => () => void;
  createTranscript: (publish: (state: ThreadTranscriptProjectionState) => void) => {
    controller: ThreadTranscriptProjectionController;
    stopAvailability: () => void;
  };
  reportError: (message: string) => void;
  getChild: (subagent: WorkbenchSubagentSummary) => WorkbenchThreadController;
  scheduleRefresh?: (callback: () => void) => ReturnType<typeof setTimeout>;
  cancelRefresh?: (timer: ReturnType<typeof setTimeout>) => void;
}

export default class WorkbenchThreadController {
  private readonly consumers = new Map<object, "summary" | "view" | "route">();
  private readonly listeners = new Set<() => void>();
  private readonly families = new Map<object, { ids: readonly string[]; children: Map<string, { owner: WorkbenchThreadController; release: () => void }> }>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private observation: ReturnType<ThreadObservationController["acquire"]> | null = null;
  private stopNative: (() => void) | null = null;
  private transcript: ReturnType<ThreadControllerPorts["createTranscript"]> | null = null;
  private opening: Promise<ThreadPayload | null> | null = null;
  private gitArcProposalObservationGeneration = 0;
  private gitArcProposalObservationKey: string | null = null;
  private gitArcProposalRefreshKey: string | null = null;
  private readonly gitArcProposalDemands = new Map<string, number>();
  private gitArcProposals: Record<string, ThreadGitArcProposalObservation> = {};
  private stopGitArcProposalRefresh: (() => void) | null = null;
  private generation = 0;
  private disposed = false;
  private readonly historyRetention: ThreadHistoryRetentionController;
  private snapshot: ThreadControllerSnapshot = {
    status: "loading", error: null, document: null, entry: null,
    gitArcProposals: {}, pendingQuestionnaire: null, rateLimits: null, subagents: [], relatedDocuments: {}, transcript: { status: "idle" },
  };

  constructor(readonly projectId: string, readonly target: ThreadControllerTarget, private readonly ports: ThreadControllerPorts) {
    this.historyRetention = new ThreadHistoryRetentionController({
      releaseTurns: turnIds => this.ports.releaseHistoricalTurns(turnIds),
    });
  }

  get threadId() { return this.target.kind === "draft" ? this.target.draftId : this.target.threadId; }
  get hasConsumers() { return this.consumers.size > 0; }
  observeGitArcProposal(proposalId: string) {
    if (this.disposed) return () => {};
    this.gitArcProposalDemands.set(proposalId, (this.gitArcProposalDemands.get(proposalId) ?? 0) + 1);
    this.syncGitArcProposalObservation(this.snapshot.entry, this.snapshot.document?.cwd ?? null);
    this.publish({ ...this.snapshot, gitArcProposals: this.gitArcProposals });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.gitArcProposalDemands.get(proposalId) ?? 0;
      if (count <= 1) this.gitArcProposalDemands.delete(proposalId);
      else this.gitArcProposalDemands.set(proposalId, count - 1);
    };
  }
  captureLifetime() {
    const generation = this.generation;
    return () => !this.disposed && this.hasConsumers && generation === this.generation;
  }
  readonly actions = {
    changeAgent: (value: string | null) => this.ports.controls.setCurrentThreadAgent(this.threadId, value),
    changeModel: (value: string) => this.ports.controls.setCurrentThreadModel(this.threadId, value),
    changeReasoningEffort: (value: string | null) => this.ports.controls.setCurrentThreadReasoningEffort(this.threadId, value),
    changeServiceTier: (value: string | null) => this.ports.controls.setCurrentThreadServiceTier(this.threadId, value),
    changeSettings: (value: Parameters<WorkbenchControls["setCurrentThreadComposerSettings"]>[1]) => this.ports.controls.setCurrentThreadComposerSettings(this.threadId, value),
    compact: async (source?: ThreadPayload | null) => {
      const document = source ?? this.snapshot.document;
      return document ? this.ports.controls.compactThread(document) : null;
    },
    stop: async (source?: ThreadPayload | null) => {
      const document = source ?? this.snapshot.document;
      return document ? this.ports.controls.stopThread(document) : null;
    },
    read: (_harness?: ThreadPayload["harness"], options?: WorkbenchReadThreadOptions) => this.read(options),
    submitQuestionnaire: (response: Parameters<WorkbenchControls["submitPendingUserInputRequest"]>[1], options?: Parameters<WorkbenchControls["submitPendingUserInputRequest"]>[2]) =>
      this.ports.controls.submitPendingUserInputRequest(this.threadId, response, options),
    snoozeQuestionnaire: async (requestKey: string) => {
      const entry = this.snapshot.entry;
      if (!entry) throw new Error("The questionnaire thread is not admitted.");
      const accepted = await this.ports.controls.updateThreadStateWithAcceptance({
        method: "workbench/thread-state/questionnaire/snooze", projectId: ProjectIdSchema.parse(this.projectId),
        identity: entry.identity, requestKey,
      });
      if (!accepted) throw new Error("The questionnaire changed before it could be snoozed.");
    },
  };
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  acquireChildren(ids: readonly string[]) {
    const token = {};
    this.families.set(token, { ids, children: new Map() });
    this.reconcile();
    return () => {
      const family = this.families.get(token);
      this.families.delete(token);
      for (const child of family?.children.values() ?? []) child.release();
    };
  }

  acquireHistorySurface(): ThreadHistoryRetentionSurface {
    return this.historyRetention.acquireSurface();
  }

  acquire(interest: "summary" | "view" | "route" = "view") {
    if (this.disposed) throw new Error("The thread owner is disposed.");
    const consumer = {};
    const first = !this.consumers.size;
    this.consumers.set(consumer, interest);
    if (first) {
      this.stopNative = this.ports.subscribeNative(() => this.reconcile());
    }
    if (interest !== "route") this.observe();
    this.reconcile();
    if (interest === "view" && !this.ports.readNative().document && this.target.kind !== "draft") {
      void this.read({}, { retain: false }).catch(() => { /* read owns and publishes the common failure. */ });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const hadDocumentConsumer = [...this.consumers.values()].some(value => value !== "summary");
      this.consumers.delete(consumer);
      const hasDocumentConsumer = [...this.consumers.values()].some(value => value !== "summary");
      if (hadDocumentConsumer && !hasDocumentConsumer) {
        const retained = this.historyRetention.releaseInactive();
        if (retained) this.publish({ ...this.snapshot, document: retained });
      }
      if (!this.consumers.size) {
        this.generation++;
        this.clearGitArcProposalObservation();
        this.opening = null;
        this.stopNative?.();
        this.stopNative = null;
        this.observation?.release();
        this.observation = null;
        this.releaseTranscript();
        this.cancelRefresh();
        this.publish({ ...this.snapshot, status: "loading", error: null, entry: null, gitArcProposals: {} });
        for (const listener of this.listeners) listener();
      } else this.reconcile();
    };
  }

  async waitForAdmission(generation = this.generation) {
    if (this.target.kind === "draft") return;
    const key = getThreadObservationKey(this.projectId, this.target);
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (this.disposed || generation !== this.generation || !this.consumers.size) {
          this.listeners.delete(check);
          reject(new Error("Thread opening was cancelled."));
          return;
        }
        const state = this.ports.observations.getSnapshot(key);
        const entry = state.observation?.entries.find(entry => entry.entryKind !== "draft" && entry.identity.threadId === this.threadId);
        if (state.status === "failed" || state.status === "absent" || (state.status === "ready" && !entry)) {
          this.listeners.delete(check);
          reject(new Error(state.error || "This thread is no longer available."));
        } else if (entry) {
          this.listeners.delete(check);
          resolve();
        }
      };
      this.listeners.add(check);
      check();
    });
  }

  read(options: WorkbenchReadThreadOptions = {}, { retain = true, selectionBound = false }: { retain?: boolean; selectionBound?: boolean } = {}): Promise<ThreadPayload | null> {
    if (!options.cursor && this.opening) return this.opening;
    const release = retain ? this.acquire("summary") : () => {};
    if (!options.cursor) this.cancelRefresh();
    const generation = this.generation;
    const task = this.ports.read(options, () => this.waitForAdmission(generation), selectionBound)
      .then(document => {
        if (generation !== this.generation || this.disposed) return null;
        if (!document && !options.cursor && !this.ports.readNative().document && !this.snapshot.document) {
          this.fail(new Error("Thread loading returned no content. Select the thread again to retry."));
        }
        if (document && this.snapshot.error) this.publish({ ...this.snapshot, error: null, status: "loading" });
        this.reconcile();
        return document;
      })
      .catch(error => {
        if (generation !== this.generation || this.disposed) return null;
        if (!options.cursor) this.fail(error, true);
        throw error;
      })
      .finally(() => {
        if (this.opening === task) this.opening = null;
        release();
        this.reconcile();
      });
    if (!options.cursor) this.opening = task;
    return task;
  }

  fail(error: unknown, preserveView = false) {
    const message = (error instanceof Error ? error.message : "Unable to open thread.").replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, 500);
    this.ports.reportError(message);
    if (preserveView && this.snapshot.document && this.snapshot.entry) return;
    this.publish({ ...this.snapshot, status: "failed", error: message });
  }

  async recover() {
    if (this.disposed || !this.consumers.size) return;
    this.generation++;
    this.invalidateGitArcProposalObservation();
    this.opening = null;
    this.cancelRefresh();
    this.publish({ ...this.snapshot, error: null, status: "loading" });
    for (const listener of this.listeners) listener();
    this.reconcile();
    if (this.target.kind !== "draft" && [...this.consumers.values()].some(interest => interest !== "summary")) {
      await this.read({}, { retain: false });
    }
  }

  async activate() {
    if (this.disposed || !this.hasConsumers || this.target.kind === "draft"
      || ![...this.consumers.values()].some(interest => interest !== "summary")
      || (this.snapshot.status === "ready" && this.snapshot.document)) return;
    this.observe();
    await this.read({}, { retain: false });
  }

  private observe() {
    if (!this.observation && this.target.kind !== "draft") {
      this.observation = this.ports.observations.acquire(this.projectId, this.target, () => this.reconcile());
    }
  }

  dispose({ transportClosing = false }: { transportClosing?: boolean } = {}) {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.clearGitArcProposalObservation();
    this.gitArcProposalDemands.clear();
    this.consumers.clear();
    this.cancelRefresh();
    for (const family of this.families.values()) {
      for (const child of family.children.values()) child.release();
    }
    this.families.clear();
    this.stopNative?.();
    this.observation?.release();
    if (transportClosing) this.transcript?.controller.setAvailable(false);
    this.releaseTranscript();
    this.historyRetention.dispose();
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }

  private releaseTranscript() {
    this.transcript?.stopAvailability();
    this.transcript?.controller.dispose();
    this.transcript = null;
  }

  private reconcile() {
    if (this.disposed || !this.consumers.size) return;
    const current = this.ports.readNative();
    const native = { ...current, document: current.document ?? this.snapshot.document };
    const observation = this.target.kind === "draft" ? null
      : this.ports.observations.getSnapshot(getThreadObservationKey(this.projectId, this.target));
    const candidate = observation?.observation?.entries.find(entry => entry.entryKind !== "draft"
      && entry.identity.threadId === this.threadId);
    const entry = candidate?.entryKind !== "draft" ? candidate ?? null : null;
    const needsDocument = [...this.consumers.values()].some(interest => interest !== "summary");
    const usable = (this.target.kind === "draft" || entry !== null) && (!needsDocument || native.document !== null);
    const failure = observation?.status === "failed" || (!entry && (observation?.status === "absent" || observation?.status === "ready"))
      ? observation.error || "This thread is no longer available." : null;
    const subagents = observation?.observation
      ? this.ports.observations.getSubagents(getThreadObservationKey(this.projectId, observation.observation.target))
      : [];
    const relatedDocuments = Object.fromEntries(subagents.flatMap(subagent => {
      const document = this.ports.getChild(subagent).getSnapshot().document;
      return document ? [[subagent.threadId, document]] : [];
    }));
    this.syncGitArcProposalObservation(entry, needsDocument ? native.document?.cwd ?? null : null);
    this.publish({
      ...this.snapshot, ...native, entry, gitArcProposals: this.gitArcProposals, subagents, relatedDocuments,
      status: this.snapshot.error || failure ? "failed" : usable ? "ready" : "loading",
      error: this.snapshot.error ?? failure,
    });
    this.hydrateChildren();
    this.syncRefresh(needsDocument);
    if (!needsDocument) {
      this.releaseTranscript();
      this.historyRetention.select(native.document);
      return;
    }
    if (native.document?.harness === "codex" && !native.document.isDraft) {
      this.transcript ??= this.ports.createTranscript(transcript => this.publish({ ...this.snapshot, transcript }));
      this.transcript.controller.select({ thread: native.document });
    }
    this.historyRetention.select(native.document);
  }

  private syncGitArcProposalObservation(entry: ThreadEntry | null, cwd: string | null) {
    const proposals = entry?.gitArc?.proposals ?? [];
    if (!this.ports.readGitArcProposal || !cwd || !proposals.length || !entry) {
      this.clearGitArcProposalObservation();
      return;
    }
    if (!this.stopGitArcProposalRefresh && this.ports.subscribeGitArcProposalRefresh) {
      this.stopGitArcProposalRefresh = this.ports.subscribeGitArcProposalRefresh(() => {
        this.invalidateGitArcProposalObservation(this.gitArcProposalObservationKey);
        this.reconcile();
      });
    }
    const key = [
      cwd,
      entry.identity.harness,
      entry.identity.threadId,
      entry.gitArc?.checkpointCommit ?? "",
      ...proposals.map(({ proposalId, rootId, status }) => `${proposalId}\0${rootId ?? ""}\0${status}`),
    ].join("\0");
    const proposalRoots = new Map(proposals.map(({ proposalId, rootId }) => [proposalId, rootId]));
    if (key === this.gitArcProposalObservationKey) {
      for (const [proposalId] of this.gitArcProposalDemands) {
        if (!proposalRoots.has(proposalId) || this.gitArcProposals[proposalId]) continue;
        this.gitArcProposals = { ...this.gitArcProposals, [proposalId]: { status: "loading" } };
        this.readGitArcProposal(entry, cwd, proposalId, proposalRoots.get(proposalId), this.gitArcProposalObservationGeneration, key);
      }
      return;
    }
    const retainLoadedProposals = key === this.gitArcProposalRefreshKey;
    this.gitArcProposalRefreshKey = null;
    this.gitArcProposalObservationKey = key;
    const generation = ++this.gitArcProposalObservationGeneration;
    const previous = this.gitArcProposals;
    this.gitArcProposals = {};
    for (const [proposalId] of this.gitArcProposalDemands) {
      if (!proposalRoots.has(proposalId)) continue;
      const current = previous[proposalId];
      this.gitArcProposals[proposalId] = retainLoadedProposals && current?.status === "loaded"
        ? { ...current, refreshing: true }
        : { status: "loading" };
      this.readGitArcProposal(entry, cwd, proposalId, proposalRoots.get(proposalId), generation, key);
    }
  }

  private readGitArcProposal(
    entry: ThreadEntry,
    cwd: string,
    proposalId: string,
    rootId: string | undefined,
    generation: number,
    key: string,
  ) {
    void this.ports.readGitArcProposal!({
        cwd,
        harness: entry.identity.harness,
        proposalId,
        ...(rootId ? { rootId } : {}),
        threadId: entry.identity.threadId,
      }).then((proposal) => {
        if (!this.isCurrentGitArcProposalObservation(generation, key, proposalId)) return;
        this.gitArcProposals = {
          ...this.gitArcProposals,
          [proposalId]: { proposal, status: "loaded" },
        };
        this.reconcile();
      }).catch((error) => {
        if (!this.isCurrentGitArcProposalObservation(generation, key, proposalId)) return;
        const message = (error instanceof Error ? error.message : "Unable to observe Git arc proposal.")
          .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?")
          .slice(0, 500);
        this.gitArcProposals = {
          ...this.gitArcProposals,
          [proposalId]: {
            error: message,
            ...(error instanceof GitArcFailureException ? { failure: error.failure } : {}),
            status: "failed",
          },
        };
        this.reconcile();
      });
  }

  private isCurrentGitArcProposalObservation(generation: number, key: string, proposalId: string) {
    return !this.disposed
      && this.hasConsumers
      && generation === this.gitArcProposalObservationGeneration
      && key === this.gitArcProposalObservationKey
      && Object.hasOwn(this.gitArcProposals, proposalId);
  }

  private invalidateGitArcProposalObservation(refreshKey: string | null = null) {
    this.gitArcProposalObservationGeneration++;
    this.gitArcProposalObservationKey = null;
    this.gitArcProposalRefreshKey = refreshKey;
  }

  private clearGitArcProposalObservation() {
    this.invalidateGitArcProposalObservation();
    this.gitArcProposals = {};
    this.stopGitArcProposalRefresh?.();
    this.stopGitArcProposalRefresh = null;
  }

  private hydrateChildren() {
    for (const [token, family] of this.families) {
      for (const subagent of this.snapshot.subagents) {
        if (!family.ids.includes(subagent.threadId) || family.children.has(subagent.threadId)) continue;
        const owner = this.ports.getChild(subagent);
        // Install the owned handle before acquiring: admission can publish synchronously.
        const child = { owner, release: () => {} };
        family.children.set(subagent.threadId, child);
        const unsubscribe = owner.subscribe(() => this.reconcile());
        const release = owner.acquire("summary");
        child.release = () => { unsubscribe(); release(); };
      }
      const batch = getNextSubagentHydrationBatch({
        threadIds: [...family.children.keys()],
        loadedThreadIds: new Set([...family.children].filter(([, child]) => child.owner.snapshot.document || child.owner.snapshot.status === "failed").map(([id]) => id)),
        loadingThreadIds: new Set([...family.children].filter(([, child]) => child.owner.opening).map(([id]) => id)),
      });
      for (const id of batch) {
        const child = family.children.get(id)!;
        void child.owner.read({ cursor: null, readScope: "subagentBackground" }, { retain: false })
          .catch(() => { /* The child owner publishes and reports its failure. */ })
          .finally(() => { if (this.families.has(token)) this.reconcile(); });
      }
    }
  }

  private cancelRefresh() {
    if (this.refreshTimer === null) return;
    (this.ports.cancelRefresh ?? clearTimeout)(this.refreshTimer);
    this.refreshTimer = null;
  }

  private syncRefresh(hasView: boolean) {
    if (this.target.kind !== "subagent" || !hasView || !this.snapshot.document || !getCurrentInProgressTurn(this.snapshot.document)) {
      this.cancelRefresh();
      return;
    }
    if (this.refreshTimer !== null || this.opening) return;
    this.refreshTimer = (this.ports.scheduleRefresh ?? (callback => setTimeout(callback, 1500)))(() => {
      this.refreshTimer = null;
      void this.read({ readScope: "subagentBackground" }, { retain: false })
        .catch(() => { /* The thread owner reports refresh failures and retains usable content. */ });
    });
  }

  private publish(next: ThreadControllerSnapshot) {
    if (areDeeplyEqual(this.snapshot, next)) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
