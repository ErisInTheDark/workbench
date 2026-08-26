/*
 * Exports:
 * - default WorkbenchThreadTooltipDetails: select compact preview or live questionnaire and proposal presentation for one sidebar thread. Keywords: sidebar, tooltip, questionnaire, proposal, ownership.
 */
"use client";

import type {
  WorkbenchControls,
  WorkbenchHarness,
  WorkbenchPendingUserInputRequest,
  WorkbenchQuestionnaireDraft,
  WorkbenchSubmitUserInputRequestOptions,
  WorkbenchUserInputResponse,
} from "../../lib/types";
import type { UserInput } from "../../lib/codex/generated/app-server/v2/UserInput";
import type { WorkspaceFileLinkRoot } from "../../lib/workbench/markdown/markdown-links";
import ThreadCheckpointCommitItem from "./thread-view/ThreadCheckpointCommitItem";
import ThreadUserInputRequest from "./thread-view/ThreadUserInputRequest";
import { buildPendingUserInputRequestSubmissionOptions } from "./thread-view/thread-user-input-request-submission";

export default function WorkbenchThreadTooltipDetails({
  cwd,
  harness,
  materialized,
  onDraftChange,
  onDraftClear,
  onReadThread,
  onSubmitUserInputRequest,
  pendingRequest,
  projectFilePaths,
  projectId,
  projectRootPath,
  proposalId,
  questionnaireDraft,
  spellCheck,
  threadId,
  workspaceRoots,
}: {
  cwd: string | null;
  harness: WorkbenchHarness;
  materialized: boolean;
  onDraftChange: (draft: WorkbenchQuestionnaireDraft) => void;
  onDraftClear: () => void;
  onReadThread: WorkbenchControls["readThread"] | null;
  onSubmitUserInputRequest: (threadId: string, response: WorkbenchUserInputResponse, options?: WorkbenchSubmitUserInputRequestOptions) => Promise<void>;
  pendingRequest: WorkbenchPendingUserInputRequest | null;
  projectFilePaths?: readonly string[];
  projectId: string;
  projectRootPath?: string;
  proposalId: string | null;
  questionnaireDraft: WorkbenchQuestionnaireDraft | null;
  spellCheck: boolean;
  threadId: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const questionnaireIsLive = Boolean(pendingRequest && !materialized && onReadThread);
  return (
    <div className="flex min-w-0 flex-col gap-2" data-thread-tooltip-details="true">
      {pendingRequest ? (
        <section
          aria-label="Pending questionnaire"
          className="rounded-[0.8rem] bg-[color-mix(in_srgb,var(--text)_3%,transparent)] p-2"
          data-thread-tooltip-questionnaire={questionnaireIsLive ? "live" : "preview"}
        >
          {questionnaireIsLive ? (
            <ThreadUserInputRequest
              draft={questionnaireDraft}
              mode="live"
              onDraftChange={onDraftChange}
              onDraftClear={onDraftClear}
              onSubmit={async (response, supplementalInput?: UserInput[]) => {
                const thread = await onReadThread?.(
                  threadId,
                  pendingRequest.harness,
                  cwd ? { cwd } : undefined,
                ) ?? null;
                await onSubmitUserInputRequest(threadId, response, {
                  ...buildPendingUserInputRequestSubmissionOptions(thread, pendingRequest),
                  ...(supplementalInput?.length ? { supplementalInput } : {}),
                });
              }}
              presentation="compact"
              projectRootPath={projectRootPath}
              request={pendingRequest.request}
              spellCheck={spellCheck}
              workspaceRoots={workspaceRoots}
            />
          ) : (
            <ThreadUserInputRequest
              draft={questionnaireDraft}
              mode="preview"
              presentation="compact"
              projectRootPath={projectRootPath}
              request={pendingRequest.request}
              workspaceRoots={workspaceRoots}
            />
          )}
        </section>
      ) : null}
      {proposalId ? (
        <section
          aria-label="Proposed commit"
          className="rounded-[0.8rem] bg-[color-mix(in_srgb,var(--text)_3%,transparent)] p-2"
          data-thread-tooltip-proposal={materialized || !cwd ? "preview" : "commit"}
        >
          <ThreadCheckpointCommitItem
            commandOutcome="completed"
            cwd={cwd}
            embedded
            harness={harness}
            intent={null}
            presentation={materialized || !cwd ? "compact-preview" : "compact-commit"}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            proposalId={proposalId}
            sourceItemId={`sidebar-proposal:${proposalId}`}
            threadId={threadId}
            workspaceRoots={workspaceRoots}
          />
        </section>
      ) : null}
    </div>
  );
}
