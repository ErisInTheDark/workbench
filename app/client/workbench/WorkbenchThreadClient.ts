/*
 * Exports:
 * - WorkbenchThreadClientOptions: workspace transport, daemon location and app-owned thread adapters.
 * - WorkbenchThreadProject: renderer context independent of live catalogue availability.
 * - WorkbenchThreadOpenOutcome: result of selecting an existing thread.
 * - default WorkbenchThreadClient: one daemon's thread renderer: thread stores, route selection, local drafts, account limits and models.
 */

import type WorkbenchWorkspaceClient from "./app/WorkbenchWorkspaceClient";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { defaultProviderKey } from "workbench-shared/workbench/provider/provider-registrations";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";
import { matchesWorkbenchModelOption } from "workbench-shared/workbench/provider/provider-model";
import type { WorkbenchThreadRouteTarget } from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchThreadSidebarRowSnapshot } from "workbench-shared/workbench/thread/thread-sidebar-row";
import type { WorkbenchThreadIdentityResolution, WorkbenchThreadIdentityResolveRequest } from "workbench-shared/workbench/thread/workbench-thread-identity";
import { DraftIdSchema, ProjectIdSchema, ThreadReferenceSchema, type DraftId } from "workbench-shared/workbench/identity";
import type {
  ThreadPayload, ThreadSummary, WorkbenchComposerSettings, WorkbenchControls, WorkbenchHarness, WorkbenchListModelsOptions,
  WorkbenchModelOption, WorkbenchProjectOption, WorkbenchSubagentSummary, WorkbenchThreadRuntimeSnapshot,
} from "workbench-shared/types";
import { normalizeWorkbenchAgentPath } from "workbench-shared/workbench/agent-paths";
import WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import { workbenchTranscriptOperations } from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import WorkbenchTranscriptClient from "./database/transcript/WorkbenchTranscriptClient";
import LifecycleScope from "./state/LifecycleScope";
import ThreadDocumentStore from "./state/ThreadDocumentStore";
import ThreadObservationController, { getThreadObservationKey } from "./thread/ThreadObservationController";
import ThreadTextPresentationController from "./thread/ThreadTextPresentationController";
import { createThreadDocumentKeyForThread } from "./thread/thread-document-keys";
import ThreadTranscriptProjectionController from "./transcript/ThreadTranscriptProjectionController";
import ThreadStore from "./thread/ThreadStore";
import createDraftThreadSource from "./thread/DraftThreadSource";
import createObservedThreadSource from "./thread/ObservedThreadSource";
import WorkbenchAccountClient from "./WorkbenchAccountClient";

type ThreadStoreTarget = Exclude<WorkbenchThreadRouteTarget, { kind: "new" }>;
type ProviderTarget = Extract<ThreadStoreTarget, { kind: "provider" }>;
type WorkbenchThreadListener = (snapshot: WorkbenchThreadRuntimeSnapshot) => void;

export type WorkbenchThreadProject = WorkbenchProjectOption
  | Pick<WorkbenchProjectOption, "id" | "name" | "rootPath" | "roots">;

export type WorkbenchThreadOpenOutcome =
  | { kind: "opened" }
  | { kind: "superseded" }
  | { kind: "failure"; message: string };

export interface WorkbenchThreadClientOptions {
  workspace: WorkbenchWorkspaceClient;
  /** The daemon folder this renderer serves; requests and limits are scoped to its daemon. */
  location?: ProjectLocationReference;
  observeProviderEvents?: boolean;
  updateThreadStateWithAcceptance?: WorkbenchControls["updateThreadStateWithAcceptance"];
  onStatusMessage?: (message: string) => void;
  /** Turns a saved composer attachment URL back into the image the daemon reads. */
  resolveAttachmentUrl?: (url: string) => Promise<string>;
  resolveThreadIdentity?: (request: WorkbenchThreadIdentityResolveRequest) => Promise<WorkbenchThreadIdentityResolution | null>;
}

interface WorkbenchThreadClient {
  getThreadStore: (projectId: string, target: ThreadStoreTarget) => ThreadStore;
  clearThreadSelection: () => void;
  createThread: (harness: WorkbenchHarness, threadId?: DraftId, options?: { project?: WorkbenchThreadProject; select?: boolean }) => ThreadPayload<DraftId>;
  dispose: () => void;
  getSnapshot: () => WorkbenchThreadRuntimeSnapshot;
  getPublishedSnapshot: () => WorkbenchThreadRuntimeSnapshot;
  getModelCatalogues: () => ReadonlyMap<WorkbenchHarness, readonly WorkbenchModelOption[]>;
  /** The active folder's sidebar rows, summarised for the explorer. */
  installThreadStateSources: (sources: { activeProjectSnapshot: WorkbenchThreadSidebarRowSnapshot | null }) => void;
  listModels: (harness: WorkbenchHarness, options?: WorkbenchListModelsOptions) => Promise<WorkbenchModelOption[]>;
  subscribeModelUpdates: (listener: (harness: WorkbenchHarness) => void) => () => void;
  /** Selects an existing thread once its family observation admits it; the view's store loads its content. */
  openThread: (threadId: string, options: { harness?: WorkbenchHarness; project: WorkbenchThreadProject; isCurrent?: () => boolean }) => Promise<WorkbenchThreadOpenOutcome>;
  requestWorkbench: <TResponse>(method: string, params: unknown) => Promise<TResponse>;
  acceptSourceGeneration: (generation: number) => void;
  /** Show the selected draft's (or the default) provider's daemon-pushed limits. */
  watchRateLimits: () => void;
  setCurrentThreadAgent: (threadId: string, agentPath: string | null) => void;
  setCurrentThreadComposerSettings: (threadId: string, settings: WorkbenchComposerSettings) => void;
  setCurrentThreadModel: (threadId: string, model: string) => void;
  setCurrentThreadReasoningEffort: (threadId: string, effort: string | null) => void;
  setCurrentThreadServiceTier: (threadId: string, serviceTier: string | null) => void;
  setDraftThreadHarness: (harness: WorkbenchHarness, threadId?: string) => void;
  subscribe: (listener: WorkbenchThreadListener) => () => void;
  textPresentation: ThreadTextPresentationController;
}

const SUPERSEDED = { kind: "superseded" } as const;

function readLocalWorkbenchOrigin() {
  try {
    return new URL(window.location.href).origin;
  } catch {
    return null;
  }
}

function createDraftThread(harness: WorkbenchHarness, threadId: DraftId, cwd: string): ThreadPayload<DraftId> {
  const timestampSeconds = Math.floor(Date.now() / 1000);
  return {
    id: threadId, harness, isDraft: true, name: "Create new thread", preview: "",
    model: null, reasoningEffort: null, serviceTier: null, agentPath: null,
    createdAt: timestampSeconds, updatedAt: timestampSeconds, status: "idle", cwd, source: harness, path: null,
    agentNickname: null, agentRole: null, tokenUsage: null, turnHistory: [], turns: [],
  };
}

function WorkbenchThreadClient(
  options: WorkbenchThreadClientOptions,
  lifecycle: LifecycleScope = new LifecycleScope(),
): WorkbenchThreadClient {
  const workspace = options.workspace;
  const cancellation = new AbortController();
  lifecycle.addUnsubscribe(() => cancellation.abort(new Error("Thread view disposed.")));
  let disposed = false;

  async function requestWorkbench<TResponse>(method: string, params: unknown) {
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Workspace request parameters are invalid.");
    const location = options.location;
    return workspace.request<TResponse>(method, params,
      location ? { kind: "folder", location: {
        ...location, projectId: "projectId" in params && typeof params.projectId === "string"
          ? ProjectIdSchema.parse(params.projectId) : location.projectId,
      } } : undefined);
  }

  const daemon = new WorkbenchDaemonClient({ request: requestWorkbench });
  const threadObservations = new ThreadObservationController({
    observe: request => workspace.observeThread(request),
    release: subscriptionId => workspace.releaseThread(subscriptionId),
  });
  lifecycle.addUnsubscribe(workspace.onWorkbenchNotification(notification => {
    if (notification.method === "workbench/thread-state/updated"
      && notification.params && typeof notification.params === "object"
      && "updateKind" in notification.params && notification.params.updateKind === "threadObservation") {
      threadObservations.accept(notification.params);
    }
  }));

  let transcriptConformanceReportFailureLogged = false;
  const transcripts = new WorkbenchTranscriptClient({
    reportConformance: (report) => {
      void requestWorkbench(workbenchTranscriptOperations.reportConformance.method, report).catch((error) => {
        if (transcriptConformanceReportFailureLogged) return;
        transcriptConformanceReportFailureLogged = true;
        console.error("Failed to store Workbench transcript conformance diagnostic.", error);
      });
    },
    transport: {
      onDisconnect: (listener) => workspace.onDisconnect(listener),
      onNotification: (listener) => workspace.onWorkbenchNotification(listener),
      request: async (method, params) => await requestWorkbench<unknown>(method, params),
    },
  });
  const account = new WorkbenchAccountClient({
    listModels: async (harness) => (await daemon.models.list(harness)).data,
    reportError: message => options.onStatusMessage?.(message),
    observeRateLimits: (harness, changed) => {
      const handle = workspace.observe({
        kind: "accountLimits", provider: ProviderKeySchema.parse(harness), daemonId: options.location?.daemonId ?? null,
      }, changed);
      return {
        getSnapshot: () => {
          const fact = handle.getSnapshot();
          return { failure: fact.failure, limits: fact.value?.data ?? null };
        },
        release: () => handle.release(),
      };
    },
  });
  const modelUpdateListeners = new Set<(harness: WorkbenchHarness) => void>();
  const textPresentation = new ThreadTextPresentationController();
  /** Local drafts; existing threads have no client document. */
  const drafts = ThreadDocumentStore();

  const listeners = new Set<WorkbenchThreadListener>();
  let publishedSnapshot: WorkbenchThreadRuntimeSnapshot | null = null;
  let currentThreadId = "";
  let subagents: WorkbenchSubagentSummary[] = [];
  let threads: ThreadSummary[] = [];
  let threadsError = "";
  /** Bumped by every selection change; an open whose revision is stale was superseded. */
  let selectionRevision = 0;
  let selectedObservation: { key: string; release: () => void } | null = null;

  function createSnapshot(): WorkbenchThreadRuntimeSnapshot {
    return {
      currentThread: drafts.getSelectedDocument(), currentThreadId, subagents,
      threadDocuments: drafts.getSnapshot(), threads, threadsError,
    };
  }

  function emit() {
    const snapshot = createSnapshot();
    publishedSnapshot = snapshot;
    for (const listener of listeners) listener(snapshot);
  }

  function subscribe(listener: WorkbenchThreadListener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }
  lifecycle.addUnsubscribe(account.subscribe(emit));

  function reconcileSubagents() {
    const next = selectedObservation ? threadObservations.getSubagents(selectedObservation.key) : [];
    if (areDeeplyEqual(subagents, next)) return;
    subagents = next;
    emit();
  }
  lifecycle.addUnsubscribe(threadObservations.subscribe(() => { if (!disposed) reconcileSubagents(); }));

  /** Holds the selected thread's family observation; releasing the previous one cancels its pending open. */
  function selectObservation(next: { projectId: string; target: ProviderTarget } | null) {
    const key = next ? getThreadObservationKey(next.projectId, next.target) : null;
    if (selectedObservation?.key === key) return;
    selectedObservation?.release();
    selectedObservation = next && key
      ? { key, release: threadObservations.acquire(next.projectId, next.target, reconcileSubagents).release }
      : null;
    reconcileSubagents();
  }

  /** Resolves once the selected family observation admits the thread; a newer selection or a failure rejects. */
  function waitForSelectedAdmission(projectId: string, target: ProviderTarget) {
    const key = getThreadObservationKey(projectId, target);
    return new Promise<void>((resolve, reject) => {
      let stop = () => {};
      const check = () => {
        const observed = threadObservations.getSnapshot(key);
        // A newer selection releases this observation (idle) before it replaces the selected key.
        if (selectedObservation?.key !== key || observed.status === "idle") {
          stop();
          reject(new Error("Thread opening was cancelled."));
          return;
        }
        const entry = observed.observation?.entries.find(candidate => candidate.entryKind !== "draft" && candidate.identity.threadId === target.threadId);
        if (observed.status === "failed" || observed.status === "absent" || (observed.status === "ready" && !entry)) {
          stop();
          reject(new Error(observed.error || "This thread is no longer available."));
        } else if (entry) {
          stop();
          resolve();
        }
      };
      stop = threadObservations.subscribe(check);
      check();
    });
  }

  async function openThread(
    threadId: string,
    { harness, project, isCurrent = () => true }: { harness?: WorkbenchHarness; project: WorkbenchThreadProject; isCurrent?: () => boolean },
  ): Promise<WorkbenchThreadOpenOutcome> {
    const revision = ++selectionRevision;
    const current = () => !disposed && revision === selectionRevision && isCurrent();
    const failure = (error: unknown, fallback: string) => ({ kind: "failure", message: error instanceof Error ? error.message : fallback }) as const;
    if (options.resolveThreadIdentity) {
      try {
        const identity = await options.resolveThreadIdentity({ threadId: ThreadReferenceSchema.parse(threadId), harness, projectId: project.id });
        if (!current()) return SUPERSEDED;
        if (!identity) throw new Error("Thread identity has not been observed in this project.");
        threadId = identity.threadId;
        harness = identity.harness;
      } catch (error) {
        return current() ? failure(error, "Thread identity lookup failed.") : SUPERSEDED;
      }
    }
    if (!current()) return SUPERSEDED;
    const target: ProviderTarget = {
      kind: "provider", threadId: ThreadReferenceSchema.parse(threadId),
      harness: harness ?? threads.find(thread => thread.id === threadId)?.harness ?? defaultProviderKey,
    };
    selectObservation({ projectId: project.id, target });
    try {
      // The thread view reads its own store; opening only waits for the thread to be admitted.
      await waitForSelectedAdmission(project.id, target);
      if (!current()) return SUPERSEDED;
      drafts.selectDocumentKey("");
      currentThreadId = threadId;
      emit();
      return { kind: "opened" };
    } catch (error) {
      // A newer selection releases this open's observation; that cancellation is supersession, not failure.
      return current() ? failure(error, "Unable to open thread.") : SUPERSEDED;
    }
  }

  function clearThreadSelection() {
    selectionRevision += 1;
    selectObservation(null);
    if (!currentThreadId && !drafts.getSelectedThreadKey()) return;
    drafts.selectDocumentKey("");
    currentThreadId = "";
    emit();
  }

  function createThread(
    harness: WorkbenchHarness,
    threadId: DraftId = DraftIdSchema.parse(crypto.randomUUID()),
    { project, select = true }: { project?: WorkbenchThreadProject; select?: boolean } = {},
  ) {
    const draft = createDraftThread(harness, threadId, project ? project.rootPath || project.name || project.id : "");
    if (select) {
      selectionRevision += 1;
      selectObservation(null);
      currentThreadId = draft.id;
    }
    drafts.upsertDocument(draft, { select });
    emit();
    return draft;
  }

  function updateDraft(threadId: string, update: (draft: ThreadPayload) => ThreadPayload | null) {
    const draft = drafts.getDocumentByThreadId(threadId);
    if (!draft?.isDraft) return;
    const next = update(draft);
    if (!next) return;
    const previousKey = createThreadDocumentKeyForThread(draft);
    const selected = drafts.getSelectedThreadKey() === previousKey;
    if (createThreadDocumentKeyForThread(next) !== previousKey) drafts.deleteDocumentKey(previousKey);
    drafts.upsertDocument(next, { select: selected });
    emit();
  }

  function preferredReasoningEffort(harness: WorkbenchHarness, modelId: string | null) {
    const model = modelId ? account.getModels(harness).find(candidate => matchesWorkbenchModelOption(candidate, modelId)) : null;
    return model?.supportsReasoningEffort ? model.defaultReasoningEffort ?? model.supportedReasoningEfforts[0] ?? null : null;
  }

  function setCurrentThreadModel(threadId: string, model: string) {
    updateDraft(threadId, draft => ({ ...draft, model, reasoningEffort: preferredReasoningEffort(draft.harness, model) }));
  }

  function setCurrentThreadReasoningEffort(threadId: string, reasoningEffort: string | null) {
    updateDraft(threadId, draft => draft.model ? { ...draft, reasoningEffort } : null);
  }

  function setCurrentThreadAgent(threadId: string, agentPath: string | null) {
    updateDraft(threadId, draft => ({ ...draft, agentPath: normalizeWorkbenchAgentPath(agentPath) }));
  }

  function setCurrentThreadServiceTier(threadId: string, serviceTier: string | null) {
    updateDraft(threadId, draft => ({ ...draft, serviceTier: serviceTier === "fast" ? "fast" : null }));
  }

  function setDraftThreadHarness(harness: WorkbenchHarness, threadId = currentThreadId) {
    updateDraft(threadId, draft => draft.harness === harness ? null : {
      ...draft, harness, source: harness,
      model: null, reasoningEffort: null, serviceTier: null, agentPath: null, contextWindowTokens: null,
    });
  }

  function setCurrentThreadComposerSettings(threadId: string, settings: WorkbenchComposerSettings) {
    setDraftThreadHarness(settings.harness, threadId);
    updateDraft(threadId, draft => ({
      ...draft,
      model: settings.model,
      reasoningEffort: settings.model ? settings.reasoningEffort : null,
      agentPath: normalizeWorkbenchAgentPath(settings.agentPath),
      serviceTier: settings.serviceTier === "fast" ? "fast" : null,
      contextWindowTokens: settings.contextWindowTokens ?? null,
    }));
  }

  function installThreadStateSources({ activeProjectSnapshot }: { activeProjectSnapshot: WorkbenchThreadSidebarRowSnapshot | null }) {
    const prior = new Map(threads.map(thread => [`${thread.harness}:${thread.id}`, thread]));
    threads = (activeProjectSnapshot?.entries ?? []).flatMap((entry): ThreadSummary[] => {
      if (entry.entryKind !== "thread") return [];
      const activitySeconds = Math.trunc(entry.activityAt / 1000);
      return [{
        agentNickname: null, agentRole: null, cwd: "", path: null, source: "workbench",
        createdAt: prior.get(`${entry.identity.harness}:${entry.identity.threadId}`)?.createdAt ?? activitySeconds,
        harness: entry.identity.harness, id: entry.identity.threadId, name: entry.title, preview: entry.title,
        status: entry.lifecycle.kind === "working" ? "active" : "idle", updatedAt: activitySeconds,
      }];
    });
    threadsError = activeProjectSnapshot?.error ?? "";
    emit();
  }

  const threadStores = new Map<string, ThreadStore>();
  /** One store per thread: drafts read their local draft document, existing threads the daemon's channels. */
  function getThreadStore(projectId: string, target: ThreadStoreTarget) {
    const threadId = target.kind === "draft" ? target.draftId : target.threadId;
    const key = `${projectId}\0${threadId}`;
    let store = threadStores.get(key);
    if (!store) {
      store = new ThreadStore(projectId, target, publish => target.kind === "draft"
        ? createDraftThreadSource({
          draftId: target.draftId,
          readDraft: () => drafts.getDocumentByThreadId(target.draftId),
          subscribe,
          readRateLimits: harness => account.getRateLimits(harness),
          watchRateLimits: harness => account.watchRateLimits(harness),
          controls: { setCurrentThreadAgent, setCurrentThreadModel, setCurrentThreadReasoningEffort, setCurrentThreadServiceTier, setCurrentThreadComposerSettings },
        }, publish)
        : createObservedThreadSource({
          projectId, target, observations: threadObservations, daemon,
          connect: () => workspace.connect(cancellation.signal),
          createTranscript: (onState, onText) => {
            const projection = new ThreadTranscriptProjectionController({
              onError: error => console.error("Workbench SQLite transcript projection lifecycle failed.", error),
              onStateChange: onState, onText, transcripts, turnLimit: 4,
            });
            return { controller: projection, stopAvailability: transcripts.onAvailabilityChange(available => projection.setAvailable(available)) };
          },
          presentText: (harness, update, canonicalText) => {
            const key = {
              field: update.field, index: update.index, itemId: update.itemId, threadId: update.threadId, turnId: update.turnId,
              source: { kind: "sqlite" as const, sourceKey: `${harness}:${update.threadId}` },
            };
            textPresentation.acceptDelta({ key, canonicalText, delta: update.append ? update.text : canonicalText });
            if (!update.append) textPresentation.complete(key, canonicalText, { snap: true });
          },
          messageContext: ({ workflowIds, instructionInjections, activatedSkillPaths }) => ({
            workbenchOrigin: readLocalWorkbenchOrigin(), instructionScope: "full", instructionInjections,
            workflowIds: [...workflowIds], activatedSkillPaths: activatedSkillPaths ? [...activatedSkillPaths] : undefined,
          }),
          readRateLimits: harness => account.getRateLimits(harness),
          watchRateLimits: harness => account.watchRateLimits(harness),
          subscribeRateLimits: listener => subscribe(listener),
          readGitArcProposal: async input => await daemon.git.arc.proposal.read(input),
          compareGitArcClaims: async ({ cwd, harness, threadId }) => {
            const comparison = await daemon.git.arc.compare({ cwd, harness, refs: [], roots: [], threadId });
            return { changeCount: comparison.changes.length, hasUncommittedChanges: Boolean(comparison.hasUncommittedChanges) };
          },
          subscribeGitArcProposalRefresh: listener => {
            window.addEventListener("focus", listener);
            return () => window.removeEventListener("focus", listener);
          },
          updateThreadStateWithAcceptance: request => {
            if (!options.updateThreadStateWithAcceptance) throw new Error("Thread state mutations are not connected.");
            return options.updateThreadStateWithAcceptance(request);
          },
          reportError: message => options.onStatusMessage?.(message),
          resolveAttachmentUrl: async url => await options.resolveAttachmentUrl?.(url) ?? url,
        }, publish));
      threadStores.set(key, store);
    }
    return store;
  }

  lifecycle.addUnsubscribe(workspace.rpc.onReconnect(() => {
    void Promise.allSettled([...threadStores.values()].map(store => store.recover())).then(results => {
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") {
        console.warn("Unable to refresh thread views after reconnect.", failed.reason instanceof Error ? failed.reason.name : "Unknown failure.");
      }
    });
  }));

  // Thread facts ride the observation and transcript channels; provider events only invalidate shared catalogues.
  if (options.observeProviderEvents !== false) {
    lifecycle.addUnsubscribe(workspace.onThreadEvent((notification, harness, daemonId) => {
      if (daemonId && options.location && daemonId !== options.location.daemonId) return;
      if (notification.method !== "models/updated") return;
      account.invalidateModels(harness);
      for (const listener of modelUpdateListeners) listener(harness);
    }));
  }

  let sourceGeneration: number | null = null;
  function acceptSourceGeneration(generation: number) {
    const previous = sourceGeneration;
    sourceGeneration = generation;
    if (previous !== null && previous !== generation) account.reset();
  }
  lifecycle.addUnsubscribe(workspace.onDisconnect(() => account.reset()));

  function dispose() {
    disposed = true;
    for (const store of threadStores.values()) store.dispose();
    threadStores.clear();
    selectedObservation?.release();
    selectedObservation = null;
    threadObservations.dispose();
    listeners.clear();
    transcripts.dispose();
    account.dispose();
    modelUpdateListeners.clear();
    textPresentation.dispose();
    lifecycle.dispose();
  }

  return {
    getThreadStore,
    clearThreadSelection,
    createThread,
    dispose,
    getSnapshot: createSnapshot,
    getPublishedSnapshot: () => publishedSnapshot ??= createSnapshot(),
    getModelCatalogues: () => account.getSnapshot().modelsByHarness,
    installThreadStateSources,
    listModels: (harness, listOptions = {}) => account.listModels(harness, listOptions),
    subscribeModelUpdates: listener => {
      modelUpdateListeners.add(listener);
      return () => { modelUpdateListeners.delete(listener); };
    },
    openThread,
    requestWorkbench,
    acceptSourceGeneration,
    watchRateLimits: () => account.watchRateLimits(drafts.getSelectedDocument()?.harness ?? defaultProviderKey),
    setCurrentThreadAgent,
    setCurrentThreadComposerSettings,
    setCurrentThreadModel,
    setCurrentThreadReasoningEffort,
    setCurrentThreadServiceTier,
    setDraftThreadHarness,
    subscribe,
    textPresentation,
  };
}

export default WorkbenchThreadClient;
