/*
 * Exports:
 * - default WorkbenchThreadTooltipDetails: one sidebar thread's tooltip sections in urgency order: questionnaire card, active claim overlap notice, the status panel's pending proposal list, waits, quiet intersections and required todos; proposals observe through the leased thread store on the thread's own daemon.
 */
"use client";

import type { WorkbenchHarness } from "workbench-shared/types";
import type { ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type { WorkbenchThreadTodo } from "workbench-shared/workbench/thread/thread-todo";
import type { UserInput } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { WorkspaceFileLinkRoot } from "../../workbench/markdown/markdown-links";
import type { WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";
import { useMemo, useState } from "react";

import ThreadCheckpointCommitActions from "./thread-view/ThreadCheckpointCommitActions";
import ThreadGitArcProposalList from "./thread-view/ThreadGitArcProposalList";
import ThreadGitArcIntersectionCard from "./thread-view/ThreadGitArcIntersectionCard";
import { ThreadStoreGitArcObservationProvider } from "./thread-view/ThreadGitArcObservationContext";
import { useWorkbenchClientController } from "./workbench-client-context";
import WorkbenchThreadDaemonScope from "./WorkbenchThreadDaemonScope";
import ThreadTodoPill from "./thread-view/ThreadTodoPill";
import ThreadUserInputRequest from "./thread-view/ThreadUserInputRequest";
import useWorkbenchQuestionnaire from "./use-workbench-questionnaire";
import {
  useThreadArcEntry, useThreadClaimIntersections, useWorkbenchProjectThreadSummaries, useWorkbenchThreadFileIndex,
  useWorkbenchThreadSidebarEntry,
} from "./use-workbench-client";
import WorkbenchThreadReferenceList from "./WorkbenchThreadReferenceList";
import { ThreadTooltipSection } from "./WorkbenchThreadTooltipContent";

/** Required todos by text; optional ones only as a count, since the thread's own panel lists them. */
function TooltipTodos({ todos }: { todos: readonly WorkbenchThreadTodo[] }) {
  const required = todos.filter(todo => todo.required);
  const optional = todos.length - required.length;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {required.map(todo => <ThreadTodoPill id={todo.id} key={todo.id} required text={todo.text} />)}
      {optional ? (
        <span className="px-1 text-[0.74rem] text-fg/muted">
          {required.length ? `+${optional} optional` : `${optional} optional ${optional === 1 ? "todo" : "todos"}`}
        </span>
      ) : null}
    </div>
  );
}

export default function WorkbenchThreadTooltipDetails({
  harness,
  materialized,
  onQuestionnaireError,
  onOpenThread,
  projectId,
  spellCheck,
  threadId,
  parentThreadId,
}: {
  harness: WorkbenchHarness;
  materialized: boolean;
  onQuestionnaireError?: (message: string) => void;
  onOpenThread: (target: WorkbenchThreadTarget) => void;
  projectId: ProjectId | "";
  spellCheck: boolean;
  threadId: WorkbenchThreadId;
  parentThreadId?: WorkbenchThreadId;
}) {
  const questionnaire = useWorkbenchQuestionnaire(projectId, parentThreadId
    ? { kind: "subagent", harness, parentThreadId, threadId } : { kind: "provider", harness, threadId }, onQuestionnaireError);
  // Everything about where the thread lives comes from the thread itself, never from whichever project is browsed.
  const threadContext = useWorkbenchClientController().mounted?.threadContextFor(threadId) ?? null;
  const cwd = questionnaire.thread.head?.cwd || null;
  const projectRootPath = threadContext?.project.rootPath;
  const roots = threadContext?.project.roots;
  const workspaceRoots = useMemo<readonly WorkspaceFileLinkRoot[]>(() => roots && roots.length > 1
    ? roots.map(root => ({ id: root.id, rootPath: root.rootPath })) : [], [roots]);
  const sidebarEntry = useWorkbenchThreadSidebarEntry(projectId, harness, threadId);
  const ownerArcEntry = useThreadArcEntry(threadId, harness);
  const summaries = useWorkbenchProjectThreadSummaries();
  const planIntersections = useThreadClaimIntersections(threadId, harness, "plan");
  const stashedIntersections = useThreadClaimIntersections(threadId, harness, "stashed");
  const pinnedEntry = summaries.projects.find(project => project.projectId === projectId)?.pinnedThreads.find(entry => (
    entry.entryKind === "thread" && entry.identity.harness === harness && entry.identity.threadId === threadId
  ));
  const entry = questionnaire.thread.entry ?? ownerArcEntry ?? sidebarEntry
    ?? (pinnedEntry?.entryKind === "thread" ? pinnedEntry : null);
  const hasStash = Boolean((ownerArcEntry?.gitArc ?? entry?.gitArc)?.stashedPaths?.length);
  const hasLiveClaims = Boolean((ownerArcEntry?.gitArc ?? entry?.gitArc)?.claimedPaths.length);
  const pendingRequest = questionnaire.request;
  const gitArc = entry?.gitArc ?? null;
  // Lean sidebar and pinned rows carry a narrower arc; acceptance and layers come from the leased store's lifecycle.
  const stack = questionnaire.thread.entry?.gitArc ?? null;
  // Pending work only; accepted history stays in the thread's own status panel.
  const pendingProposals = useMemo(() => gitArc?.proposals.filter(({ status }) => status === "proposed") ?? [], [gitArc]);
  // The same commit coordination the status panel owns: commit all, layers, and per-card readiness.
  const [commitActions] = useState(() => new ThreadCheckpointCommitActions());
  // Only proposal cards link files, so only they load the thread's file index.
  const projectFilePaths = useWorkbenchThreadFileIndex(threadId, pendingProposals.length > 0).snapshot.paths;
  const questionnaireLoading = !pendingRequest && Boolean(entry && (
    ("pendingQuestionnaire" in entry && entry.pendingQuestionnaire)
    || ("canCompleteQuestionnaire" in entry && entry.canCompleteQuestionnaire)
    || (entry.lifecycle.kind === "needsAttention" && entry.lifecycle.reason === "pendingInput")
  ));
  const questionnaireIsLive = Boolean(pendingRequest && !materialized && questionnaire.thread.store);
  const waitingFor = entry && "waitingOnThreads" in entry ? entry.waitingOnThreads ?? [] : [];
  const todos = questionnaire.thread.head?.todos ?? [];
  if (questionnaire.thread.status === "failed") return null;

  // A stashed arc reports its stash's overlap; live claims still report the plan's.
  const shown = [
    ...(hasStash ? [{ mode: "stashed" as const, observed: stashedIntersections }] : []),
    ...(!hasStash || hasLiveClaims ? [{ mode: "plan" as const, observed: planIntersections }] : []),
  ].filter(({ observed }) => observed.intersections.hasScope && observed.ownerProjectId);
  const intersectionSection = ({ mode, observed }: typeof shown[number], active: boolean) => (
    <ThreadTooltipSection bleed={active} key={mode}>
      <ThreadGitArcIntersectionCard
        chrome="notice"
        intersections={observed.intersections}
        logicalProjectId={observed.logicalProjectId}
        mode={mode}
        onOpenThread={onOpenThread}
        ownerProjectId={observed.ownerProjectId}
        presentation="compact"
      />
    </ThreadTooltipSection>
  );
  const overlapsActive = ({ observed }: typeof shown[number]) => observed.intersections.activeEntries.length > 0;

  return (
    <WorkbenchThreadDaemonScope context={threadContext}>
    <ThreadStoreGitArcObservationProvider thread={questionnaire.thread}>
    <div className="contents" data-thread-tooltip-details="true">
      {pendingRequest || questionnaireLoading ? (
        <section
          aria-label="Pending questionnaire"
          className="rounded-[0.8rem] bg-fg/3 p-2"
          data-thread-tooltip-questionnaire={questionnaireLoading ? "loading" : questionnaireIsLive ? "live" : "preview"}
        >
          <div>
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
      {shown.filter(overlapsActive).map(entry => intersectionSection(entry, true))}
      {/* Without a cwd nothing can be read or committed, so the section waits for the thread's head. */}
      {pendingProposals.length && cwd ? (
        // Edge to edge like the status panel's own list, whose rows carry their padding.
        <ThreadTooltipSection aria-label="Commit proposals" bleed className="!pt-0" data-thread-tooltip-proposal="commit">
          <ThreadGitArcProposalList
            acceptance={stack?.acceptance ?? null}
            commitActions={commitActions}
            cwd={cwd}
            harness={harness}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            proposals={pendingProposals}
            stackLayers={stack?.stackLayers ?? []}
            threadId={threadId}
            workspaceRoots={workspaceRoots}
          />
        </ThreadTooltipSection>
      ) : null}
      {waitingFor.length ? (
        <ThreadTooltipSection>
          <WorkbenchThreadReferenceList label="Waiting for" references={waitingFor} />
        </ThreadTooltipSection>
      ) : null}
      {shown.filter(entry => !overlapsActive(entry)).map(entry => intersectionSection(entry, false))}
      {todos.length ? (
        <ThreadTooltipSection aria-label="Todos">
          <TooltipTodos todos={todos} />
        </ThreadTooltipSection>
      ) : null}
    </div>
    </ThreadStoreGitArcObservationProvider>
    </WorkbenchThreadDaemonScope>
  );
}
