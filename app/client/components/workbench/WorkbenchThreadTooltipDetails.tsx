/*
 * Exports:
 * - default WorkbenchThreadTooltipDetails: select compact plan, questionnaire, and proposal presentation for one sidebar thread.
 */
"use client";

import type { WorkbenchHarness } from "workbench-shared/types";
import type { ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type { UserInput } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { WorkspaceFileLinkRoot } from "../../workbench/markdown/markdown-links";
import type { WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";
import ThreadCheckpointCommitItem from "./thread-view/ThreadCheckpointCommitItem";
import ThreadGitArcIntersectionCard from "./thread-view/ThreadGitArcIntersectionCard";
import ThreadUserInputRequest from "./thread-view/ThreadUserInputRequest";
import useWorkbenchQuestionnaire from "./use-workbench-questionnaire";
import { useWorkbenchProjectThreadSummaries, useWorkbenchThreadSidebarEntry } from "./use-workbench-client";

export default function WorkbenchThreadTooltipDetails({
  cwd,
  harness,
  materialized,
  onQuestionnaireError,
  onOpenThread,
  projectFilePaths,
  projectId,
  projectRootPath,
  spellCheck,
  threadId,
  parentThreadId,
  workspaceRoots,
}: {
  cwd: string | null;
  harness: WorkbenchHarness;
  materialized: boolean;
  onQuestionnaireError?: (message: string) => void;
  onOpenThread: (target: WorkbenchThreadTarget) => void;
  projectFilePaths?: readonly string[];
  projectId: ProjectId | "";
  projectRootPath?: string;
  spellCheck: boolean;
  threadId: WorkbenchThreadId;
  parentThreadId?: WorkbenchThreadId;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const questionnaire = useWorkbenchQuestionnaire(projectId, parentThreadId
    ? { kind: "subagent", harness, parentThreadId, threadId } : { kind: "provider", harness, threadId }, onQuestionnaireError);
  const sidebarEntry = useWorkbenchThreadSidebarEntry(projectId, harness, threadId);
  const summaries = useWorkbenchProjectThreadSummaries();
  const pinnedEntry = summaries.projects.find(project => project.projectId === projectId)?.pinnedThreads.find(entry => (
    entry.entryKind === "thread" && entry.identity.harness === harness && entry.identity.threadId === threadId
  ));
  const entry = questionnaire.thread.state.entry ?? sidebarEntry ?? (pinnedEntry?.entryKind === "thread" ? pinnedEntry : null);
  const pendingRequest = questionnaire.request;
  const proposalId = entry?.gitArc?.proposals.find(proposal => proposal.status === "proposed")?.proposalId ?? null;
  const questionnaireLoading = !pendingRequest && Boolean(entry && (
    ("pendingQuestionnaire" in entry && entry.pendingQuestionnaire)
    || ("canCompleteQuestionnaire" in entry && entry.canCompleteQuestionnaire)
    || (entry.lifecycle.kind === "needsAttention" && entry.lifecycle.reason === "pendingInput")
  ));
  const questionnaireIsLive = Boolean(pendingRequest && !materialized && questionnaire.thread.state.canRead);
  if (questionnaire.thread.state.status === "failed") return null;
  return (
    <div className="flex min-w-0 flex-col gap-2" data-thread-tooltip-details="true">
      {pendingRequest || questionnaireLoading ? (
        <section
          aria-label="Pending questionnaire"
          className="rounded-[0.8rem] bg-[color-mix(in_srgb,var(--text)_3%,transparent)] [--thread-tooltip-panel-bg:color-mix(in_srgb,var(--text)_3%,var(--fg-bg,var(--bg)))] p-2"
          data-thread-tooltip-questionnaire={questionnaireLoading ? "loading" : questionnaireIsLive ? "live" : "preview"}
        >
          <div className="[--fg-bg:var(--thread-tooltip-panel-bg)]">
            {!pendingRequest ? (
              <ThreadUserInputRequest mode="loading" presentation="compact" />
            ) : questionnaireIsLive ? (
              <ThreadUserInputRequest
                key={`${projectId}:${threadId}:${pendingRequest.requestKey}`}
                draft={questionnaire.draft}
                mode="live"
                onDraftChange={questionnaire.save}
                onDraftClear={questionnaire.clear}
                onSubmit={async (response, supplementalInput?: UserInput[]) => {
                  await questionnaire.submit(response, {
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
                draft={questionnaire.draft}
                mode="preview"
                presentation="compact"
                projectRootPath={projectRootPath}
                request={pendingRequest.request}
                workspaceRoots={workspaceRoots}
              />
            )}
          </div>
        </section>
      ) : null}
      {proposalId ? (
        <section
          aria-label="Proposed commit"
          className="rounded-[0.8rem] bg-[color-mix(in_srgb,var(--text)_3%,transparent)] [--thread-tooltip-panel-bg:color-mix(in_srgb,var(--text)_3%,var(--fg-bg,var(--bg)))] p-2"
          data-thread-tooltip-proposal={materialized || !cwd ? "preview" : "commit"}
        >
          <div className="[--fg-bg:var(--thread-tooltip-panel-bg)]">
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
          </div>
        </section>
      ) : null}
      <ThreadGitArcIntersectionCard
        harness={harness}
        onOpenThread={onOpenThread}
        presentation="compact"
        projectId={projectId}
        threadId={threadId}
      />
    </div>
  );
}
