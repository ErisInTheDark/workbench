/*
 * Exports:
 * - default useWorkbenchQuestionnaire: bind a thread's request, existing draft owner and answer actions.
 */
"use client";

import { useCallback, useMemo } from "react";
import type { WorkbenchQuestionnaireDraft, WorkbenchSubmitUserInputRequestOptions, WorkbenchUserInputResponse } from "workbench-shared/types";
import type { WorkbenchThreadRouteTarget as WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import { clearQuestionnaireDraft, saveQuestionnaireDraft } from "../../workbench/state/draft-persistence";
import { useWorkbenchClientStateController, useWorkbenchClientStateSnapshot } from "./workbench-client-state-context";
import { useThread } from "./use-thread";
import { useWorkbenchClientController } from "./workbench-client-context";
import { buildPendingUserInputRequestSubmissionOptions } from "./thread-view/thread-user-input-request-submission";

export default function useWorkbenchQuestionnaire(projectId: string, target: WorkbenchThreadTarget | null, onError?: (message: string) => void) {
  const thread = useThread(projectId, target);
  const { pending: request } = useThread.questionnaire(thread.store);
  const { transcript, turns } = useThread.turns(thread.store);
  const clientState = useWorkbenchClientStateSnapshot();
  const client = useWorkbenchClientController();
  const store = useWorkbenchClientStateController();
  const threadId = target && "threadId" in target ? target.threadId : null;
  const rootThreadId = target?.kind === "provider" ? target.threadId
    : target?.kind === "subagent" ? target.parentThreadId : null;
  const ownerIdentity = rootThreadId ? client.mounted?.threadDraftIdentityFor(rootThreadId) : null;
  const ownerProjectId = ownerIdentity?.projectId ?? projectId;
  const requestKey = request?.requestKey ?? "";
  const daemonRegistrationId = rootThreadId
    ? ownerIdentity?.daemonRegistrationId ?? "" : clientState.daemonRegistrationId;
  const draft = useMemo(() => clientState.records.find(record => record.kind === "questionnaireDraft"
    && record.daemonRegistrationId === daemonRegistrationId && record.projectId === ownerProjectId
    && record.threadId === threadId && record.requestKey === requestKey), [clientState.records, daemonRegistrationId, ownerProjectId, threadId, requestKey]);
  const resolveDraftIdentity = useCallback(() => {
    if (!threadId || !requestKey) return null;
    const owner = rootThreadId ? client.mounted?.threadDraftIdentityFor(rootThreadId) : {
      daemonRegistrationId: store.daemonRegistrationId,
      projectId: ProjectIdSchema.parse(projectId),
      threadId,
    };
    return owner ? { ...owner, threadId, requestKey } : null;
  }, [client, projectId, requestKey, rootThreadId, store, threadId]);
  const save = useCallback(async (update: (draft: WorkbenchQuestionnaireDraft) => WorkbenchQuestionnaireDraft) => {
    try {
      if (!requestKey || !threadId) throw new Error("The questionnaire is no longer available.");
      return await saveQuestionnaireDraft(store, resolveDraftIdentity, update);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "Unable to save questionnaire draft.");
      throw error;
    }
  }, [store, resolveDraftIdentity, threadId, requestKey, onError]);
  const clear = useCallback(async () => {
    try {
      if (!threadId) return;
      await clearQuestionnaireDraft(store, resolveDraftIdentity);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "Unable to clear questionnaire draft.");
      throw error;
    }
  }, [store, resolveDraftIdentity, threadId, onError]);
  const submit = useCallback(async (response: WorkbenchUserInputResponse, options?: WorkbenchSubmitUserInputRequestOptions) => {
    if (!request) throw new Error("The questionnaire is no longer available.");
    const loaded = "projection" in transcript && transcript.projection ? turns : null;
    const supplementalInput = options?.supplementalInput
      ? await Promise.all(options.supplementalInput.map(async item => item.type === "image"
        ? { ...item, url: await store.resolveDraftAttachmentUrl(item.url) }
        : item))
      : undefined;
    await thread.actions.submitQuestionnaire(response, {
      ...buildPendingUserInputRequestSubmissionOptions(loaded, request),
      ...options,
      ...(supplementalInput ? { supplementalInput } : {}),
    });
  }, [request, store, transcript, turns, thread.actions]);
  return {
    thread,
    request,
    draft: draft?.kind === "questionnaireDraft" ? draft.value : null,
    save,
    clear,
    submit,
  };
}
