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
import { useWorkbenchThread } from "./use-workbench-thread";
import { buildPendingUserInputRequestSubmissionOptions } from "./thread-view/thread-user-input-request-submission";

export default function useWorkbenchQuestionnaire(projectId: string, target: WorkbenchThreadTarget | null, onError?: (message: string) => void) {
  const thread = useWorkbenchThread(projectId, target);
  const clientState = useWorkbenchClientStateSnapshot();
  const store = useWorkbenchClientStateController();
  const request = thread.state.pendingQuestionnaire;
  const threadId = target && "threadId" in target ? target.threadId : null;
  const requestKey = request?.requestKey ?? "";
  const daemonRegistrationId = clientState.daemonRegistrationId;
  const draft = useMemo(() => clientState.records.find(record => record.kind === "questionnaireDraft"
    && record.daemonRegistrationId === daemonRegistrationId && record.projectId === projectId
    && record.threadId === threadId && record.requestKey === requestKey), [clientState.records, daemonRegistrationId, projectId, threadId, requestKey]);
  const save = useCallback(async (update: (draft: WorkbenchQuestionnaireDraft) => WorkbenchQuestionnaireDraft) => {
    try {
      if (!requestKey || !threadId) throw new Error("The questionnaire is no longer available.");
      return await saveQuestionnaireDraft(store, { daemonRegistrationId, projectId: ProjectIdSchema.parse(projectId), threadId, requestKey }, update);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "Unable to save questionnaire draft.");
      throw error;
    }
  }, [store, daemonRegistrationId, projectId, threadId, requestKey, onError]);
  const clear = useCallback(async () => {
    try {
      if (!threadId) return;
      await clearQuestionnaireDraft(store, { daemonRegistrationId, projectId: ProjectIdSchema.parse(projectId), threadId, requestKey });
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "Unable to clear questionnaire draft.");
      throw error;
    }
  }, [store, daemonRegistrationId, projectId, threadId, requestKey, onError]);
  const submit = useCallback(async (response: WorkbenchUserInputResponse, options?: WorkbenchSubmitUserInputRequestOptions) => {
    if (!request) throw new Error("The questionnaire is no longer available.");
    const source = thread.state.document ?? await thread.actions.read();
    await thread.actions.submitQuestionnaire(response, { ...buildPendingUserInputRequestSubmissionOptions(source, request), ...options });
  }, [request, thread.state.document, thread.actions.read, thread.actions.submitQuestionnaire]);
  return {
    thread,
    request,
    draft: draft?.kind === "questionnaireDraft" ? draft.value : null,
    save,
    clear,
    submit,
  };
}
