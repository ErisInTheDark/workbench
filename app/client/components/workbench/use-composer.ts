/*
 * Exports:
 * - default useComposer: one composer's input draft, saved and cleared at its owner's address; `.questionnaire` binds a
 *   thread's pending questionnaire and its answer draft; `.references` attaches references to any thread's composer.
 *   Drafts and requests are read through getters with a content key for dependencies; draft identities change only
 *   with their content. Failed writes report to the shell banner, then rethrow.
 */
"use client";

import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";

import type {
  WorkbenchComposerInputDraft, WorkbenchQuestionnaireDraft, WorkbenchSubmitUserInputRequestOptions,
  WorkbenchUserInputResponse,
} from "workbench-shared/types";
import type { PresentationDraftReference } from "workbench-shared/state/workbench-presentation-state";
import appStateReleases from "workbench-shared/state/workbench-app-state-releases";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import { ProjectIdSchema, ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchThreadRouteTarget as WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";
import { readWorkbenchRoute } from "../../workbench/navigation/use-workbench-route";
import { useWorkbenchNavigate } from "../../workbench/navigation/use-workbench-project-navigation";
import type { DraftUpdate } from "./thread-view/DraftSessionController";
import {
  attachComposerDraftReference, clearComposerDraft, clearQuestionnaireDraft, presentationDraftToInput,
  readComposerDraft, resolveComposerDraftTarget, saveComposerDraft, saveQuestionnaireDraft,
  type ClientDraftIdentity, type ComposerDraftTargetContext,
} from "../../workbench/state/draft-persistence";
import type WorkbenchClientStateController from "../../workbench/state/WorkbenchClientStateController";
import { buildPendingUserInputRequestSubmissionOptions } from "./thread-view/thread-user-input-request-submission";
import { useThread } from "./use-thread";
import { useTranscript } from "./use-transcript";
import { useWorkbenchClientController, type WorkbenchClientController } from "./workbench-client-context";
import { useWorkbenchClientState, useWorkbenchClientStateController } from "./workbench-client-state-context";
import { useWorkbenchComposerProfiles } from "./WorkbenchComposerProfileContext";
import { useWorkbenchShellError } from "./workbench-shell-error-context";

type Mounted = WorkbenchClientController["mounted"];
type ThreadController = ReturnType<typeof useThread>;
interface Retained<Value> { value: Value; key: number }

const noSubscription = () => () => {};

/** The thread whose daemon owns a target's drafts: a subagent's drafts live with its parent. */
function rootThreadIdOf(target: WorkbenchThreadTarget | null) {
  return target?.kind === "provider" ? target.threadId : target?.kind === "subagent" ? target.parentThreadId : null;
}

/** The address a thread's drafts are read and written at: its owner's registration and project, keyed by the thread. */
function draftOwnerIdentity(mounted: Mounted, rootThreadId: string, threadId: string): ClientDraftIdentity | null {
  const owner = mounted?.threadDraftIdentityFor(rootThreadId);
  return owner ? { ...owner, threadId: ThreadReferenceSchema.parse(threadId) } : null;
}

/** Client state plus the late-landing owner and presentation facts drafts are resolved through. */
function useDraftSources(mounted: Mounted, state: WorkbenchClientStateController) {
  const presentation = mounted?.presentationClient ?? null;
  return useCallback((listener: () => void) => {
    const unsubscribers = [
      state.subscribe(listener),
      mounted?.subscribeChanges(listener) ?? noSubscription(),
      presentation?.subscribe(listener) ?? noSubscription(),
    ];
    return () => { for (const unsubscribe of unsubscribers) unsubscribe(); };
  }, [mounted, presentation, state]);
}

/** A read whose value keeps its identity, and whose key holds, until its content changes. */
function useRetained<Value>(subscribe: (listener: () => void) => () => void, read: () => Value): Retained<Value> {
  const kept = useRef<Retained<Value> | null>(null);
  const snapshot = useCallback(() => {
    const next = read();
    if (kept.current && areDeeplyEqual(kept.current.value, next)) return kept.current;
    kept.current = { value: next, key: (kept.current?.key ?? 0) + 1 };
    return kept.current;
  }, [read]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

function useReportedWrite() {
  const report = useWorkbenchShellError();
  return useCallback(async <Result>(write: () => Promise<Result>, fallback: string) => {
    try {
      return await write();
    } catch (error) {
      report?.(error instanceof Error ? error.message : fallback);
      throw error;
    }
  }, [report]);
}

/** Every composer draft destination resolves through the url, owners and profiles as they are when it is written. */
function useComposerDraftTargets() {
  const client = useWorkbenchClientController();
  const state = useWorkbenchClientStateController();
  const navigate = useWorkbenchNavigate();
  const profilesFor = useWorkbenchComposerProfiles.registry();
  const context = useMemo<ComposerDraftTargetContext>(() => ({
    threadDraftIdentityFor: threadId => draftOwnerIdentity(client.mounted, threadId, threadId),
    draftLocationFor: draftId => client.mounted?.draftLocationFor(draftId) ?? null,
    presentation: client.mounted?.presentationClient ?? null,
    listingRows: () => client.mounted?.threadSidebar.getListing?.().rows ?? [],
    currentThread: () => client.mounted?.threadRuntime.getSnapshot().currentThread ?? null,
    route: () => readWorkbenchRoute(client, state),
    navigate: route => navigate(route, { replace: true }),
    profilesFor: daemonId => profilesFor?.(daemonId) ?? null,
  }), [client, navigate, profilesFor, state]);
  return useCallback((projectId: string, threadId: string, target: WorkbenchThreadTarget | null) =>
    resolveComposerDraftTarget(context, projectId, threadId, target ?? undefined), [context]);
}

export default function useComposer(projectId: string, threadId: string, target: WorkbenchThreadTarget | null) {
  const client = useWorkbenchClientController();
  const state = useWorkbenchClientStateController();
  const subscribe = useDraftSources(client.mounted, state);
  const targetKind = target?.kind ?? null;
  const draftId = target?.kind === "draft" ? target.draftId : null;
  const read = useCallback((): WorkbenchComposerInputDraft | null => {
    if (draftId) {
      const presentation = client.mounted?.presentationClient;
      return presentation ? presentationDraftToInput(presentation, draftId) : null;
    }
    if (targetKind !== "provider" && targetKind !== "subagent") return null;
    return readComposerDraft(state.getSnapshot().records, draftOwnerIdentity(client.mounted, threadId, threadId));
  }, [client.mounted, draftId, state, targetKind, threadId]);
  const draft = useRetained(subscribe, read);
  const resolveTarget = useComposerDraftTargets();
  const reported = useReportedWrite();
  const latestTarget = useRef(target);
  latestTarget.current = target;
  const save = useCallback((update: DraftUpdate<WorkbenchComposerInputDraft>,
    options: { reason: "autosave" | "submission" | "retarget"; detached: boolean }) => reported(() =>
    saveComposerDraft(state, resolveTarget(projectId, threadId, latestTarget.current), update, options),
  "Unable to save composer draft."), [projectId, reported, resolveTarget, state, threadId]);
  const clear = useCallback(() => reported(() =>
    clearComposerDraft(state, resolveTarget(projectId, threadId, latestTarget.current)),
  "Unable to clear composer draft."), [projectId, reported, resolveTarget, state, threadId]);
  const getDraft = useCallback(() => draft.value, [draft]);
  return useMemo(() => ({ draftKey: draft.key, getDraft, save, clear }), [clear, draft.key, getDraft, save]);
}

/** `thread` is the caller's `useThread(projectId, target)`; its store carries the pending request and answer actions. */
useComposer.questionnaire = function useComposerQuestionnaire(
  projectId: string, target: WorkbenchThreadTarget | null, thread: ThreadController,
) {
  const client = useWorkbenchClientController();
  const state = useWorkbenchClientStateController();
  const { pending: request } = useThread.questionnaire(thread.store);
  const { transcript, turns } = useTranscript.turns(thread.store);
  const threadId = target && "threadId" in target ? target.threadId : null;
  const rootThreadId = rootThreadIdOf(target);
  const requestKey = request?.requestKey ?? "";
  const resolveIdentity = useCallback(() => {
    if (!threadId || !requestKey) return null;
    const owner = rootThreadId ? draftOwnerIdentity(client.mounted, rootThreadId, threadId) : {
      daemonRegistrationId: state.daemonRegistrationId, projectId: ProjectIdSchema.parse(projectId), threadId,
    };
    return owner ? { ...owner, requestKey } : null;
  }, [client.mounted, projectId, requestKey, rootThreadId, state, threadId]);
  const subscribe = useDraftSources(client.mounted, state);
  const read = useCallback(() => {
    const identity = resolveIdentity();
    return identity ? state.records("questionnaireDraft").find(record => record.daemonRegistrationId === identity.daemonRegistrationId
      && record.projectId === identity.projectId && record.threadId === identity.threadId
      && record.requestKey === identity.requestKey)?.value ?? null : null;
  }, [resolveIdentity, state]);
  const draft = useRetained(subscribe, read);
  const reported = useReportedWrite();
  const save = useCallback((update: (draft: WorkbenchQuestionnaireDraft) => WorkbenchQuestionnaireDraft) => reported(() => {
    if (!requestKey || !threadId) throw new Error("The questionnaire is no longer available.");
    return saveQuestionnaireDraft(state, resolveIdentity, update);
  }, "Unable to save questionnaire draft."), [reported, requestKey, resolveIdentity, state, threadId]);
  const clear = useCallback(() => reported(async () => {
    if (threadId) await clearQuestionnaireDraft(state, resolveIdentity);
  }, "Unable to clear questionnaire draft."), [reported, resolveIdentity, state, threadId]);
  const latest = useRef({ request, transcript, turns, actions: thread.actions });
  latest.current = { request, transcript, turns, actions: thread.actions };
  const submit = useCallback(async (response: WorkbenchUserInputResponse, options?: WorkbenchSubmitUserInputRequestOptions) => {
    const { request: pending, transcript: loadedTranscript, turns: loadedTurns, actions } = latest.current;
    if (!pending) throw new Error("The questionnaire is no longer available.");
    const loaded = "projection" in loadedTranscript && loadedTranscript.projection ? loadedTurns : null;
    const supplementalInput = options?.supplementalInput
      ? await Promise.all(options.supplementalInput.map(async item => item.type === "image"
        ? { ...item, url: await state.resolveDraftAttachmentUrl(item.url) }
        : item))
      : undefined;
    await actions.submitQuestionnaire(response, {
      ...buildPendingUserInputRequestSubmissionOptions(loaded, pending),
      ...options,
      ...(supplementalInput ? { supplementalInput } : {}),
    });
  }, [state]);
  const getRequest = useCallback(() => latest.current.request, []);
  const getDraft = useCallback(() => draft.value, [draft]);
  return useMemo(() => ({ requestKey, getRequest, draftKey: draft.key, getDraft, save, clear, submit }),
    [clear, draft.key, getDraft, getRequest, requestKey, save, submit]);
};

/** Attach references, such as dropped feedback, to any thread's composer draft without opening it. */
useComposer.references = function useComposerReferences() {
  const state = useWorkbenchClientStateController();
  const canAttach = useWorkbenchClientState(snapshot =>
    snapshot.schemaVersion >= appStateReleases.composerDraftReferences.version);
  const resolveTarget = useComposerDraftTargets();
  const reported = useReportedWrite();
  const attach = useCallback((ownerProjectId: string, target: WorkbenchThreadTarget,
    reference: PresentationDraftReference) => reported(async () => {
    if (state.getSnapshot().schemaVersion < appStateReleases.composerDraftReferences.version) {
      throw new Error("Restart Workbench to attach feedback to an existing thread.");
    }
    if (target.kind === "new") throw new Error("Feedback needs a concrete thread composer.");
    const threadId = target.kind === "draft" ? target.draftId : target.threadId;
    await saveComposerDraft(state, resolveTarget(ownerProjectId, threadId, target),
      draft => attachComposerDraftReference(draft, reference), { reason: "autosave", detached: true });
  }, "Unable to save composer draft."), [reported, resolveTarget, state]);
  return useMemo(() => ({ canAttach, attach }), [attach, canAttach]);
};
