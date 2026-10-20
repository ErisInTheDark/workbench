/*
 * Exports:
 * - default WorkbenchThreadTooltipDetails: one sidebar thread's tooltip sections, read through the project that lists it, in urgency order: questionnaire card, active claim overlap notice, the status panel's pending proposal list, waits, quiet intersections and todos; proposals observe through the leased thread store on the thread's own daemon.
 */
"use client";

import type { WorkbenchHarness } from "workbench-shared/types";
import type { ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type { WorkspaceFileLinkRoot } from "../../workbench/markdown/markdown-links";
import { useMemo, useState } from "react";

import ThreadCheckpointCommitActions from "./thread-view/ThreadCheckpointCommitActions";
import ThreadGitArcProposalList from "./thread-view/ThreadGitArcProposalList";
import ContextualProjectProvider from "./ContextualProjectProvider";
import ThreadGitArcIntersectionCard from "./thread-view/ThreadGitArcIntersectionCard";
import { ThreadStoreGitArcObservationProvider } from "./thread-view/ThreadGitArcObservationContext";
import { useWorkbenchClientController } from "./workbench-client-context";
import WorkbenchThreadDaemonScope from "./WorkbenchThreadDaemonScope";
import ThreadUserInputRequest from "./thread-view/ThreadUserInputRequest";
import useWorkbenchQuestionnaire from "./use-workbench-questionnaire";
import { useProjects } from "./use-projects";
import { useThread } from "./use-thread";
import { useThreads } from "./use-threads";
import { useSettings } from "./use-settings";
import WorkbenchThreadReferenceList from "./WorkbenchThreadReferenceList";
import { ThreadTooltipSection } from "./WorkbenchThreadTooltipContent";
import WorkbenchThreadTooltipTodos from "./WorkbenchThreadTooltipTodos";

export default function WorkbenchThreadTooltipDetails({
  harness,
  materialized,
  onQuestionnaireError,
  fallbackProjectId,
  threadId,
  parentThreadId,
}: {
  harness: WorkbenchHarness;
  materialized: boolean;
  onQuestionnaireError?: (message: string) => void;
  /** The project to read the thread through when no sidebar or summary lists it. */
  fallbackProjectId: ProjectId | "";
  threadId: WorkbenchThreadId;
  parentThreadId?: WorkbenchThreadId;
}) {
  const sidebars = useThreads.sidebars();
  const settings = useSettings.forThread(parentThreadId
    ? { kind: "subagent", harness, parentThreadId, threadId } : { kind: "provider", harness, threadId });
  const summaries = useProjects.threads();
  const projectId = useMemo(() => sidebars.projects.find(({ entries }) => entries.some(candidate => (
    candidate.entryKind !== "draft" && candidate.identity.harness === harness && candidate.identity.threadId === threadId
  )))?.projectId ?? summaries.projects.find(({ pinnedThreads, unsettledThreads }) => (
    pinnedThreads.some(candidate => candidate.entryKind === "thread" && candidate.identity.harness === harness && candidate.identity.threadId === threadId)
    || unsettledThreads.some(candidate => candidate.identity.harness === harness && candidate.identity.threadId === threadId)
  ))?.projectId ?? fallbackProjectId, [fallbackProjectId, harness, sidebars, summaries, threadId]);
  const questionnaire = useWorkbenchQuestionnaire(projectId, parentThreadId
    ? { kind: "subagent", harness, parentThreadId, threadId } : { kind: "provider", harness, threadId }, onQuestionnaireError);
  const threadContext = useWorkbenchClientController().mounted?.threadContextFor(threadId) ?? null;
  const cwd = questionnaire.thread.head?.cwd || null;
  const projectRootPath = threadContext?.project.rootPath;
  const roots = threadContext?.project.roots;
  const workspaceRoots = useMemo<readonly WorkspaceFileLinkRoot[]>(() => roots && roots.length > 1
    ? roots.map(root => ({ id: root.id, rootPath: root.rootPath })) : [], [roots]);
  const sidebarEntry = useThread.sidebarEntry(projectId, harness, threadId);
  const ownerArcEntry = useThread.arc(threadId, harness);
  const planIntersections = useThread.claimIntersections(threadId, harness, "plan");
  const stashedIntersections = useThread.claimIntersections(threadId, harness, "stashed");
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
  const pendingProposals = useMemo(() => gitArc?.proposals.filter(({ status }) => status === "proposed") ?? [], [gitArc]);
  const [commitActions] = useState(() => new ThreadCheckpointCommitActions());
  const projectFilePaths = useThread.fileIndex(threadId, pendingProposals.length > 0).snapshot.paths;
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
        ownerProjectId={observed.ownerProjectId}
        presentation="compact"
      />
    </ThreadTooltipSection>
  );
  const overlapsActive = ({ observed }: typeof shown[number]) => observed.intersections.activeEntries.length > 0;

  return (
    <WorkbenchThreadDaemonScope context={threadContext}>
    <ThreadStoreGitArcObservationProvider thread={questionnaire.thread}>
    <ContextualProjectProvider
      cwd={cwd ?? undefined}
      filePaths={projectFilePaths}
      id={projectId}
      rootPath={projectRootPath}
      workspaceRoots={workspaceRoots}
    >
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
                onSubmit={async (response, options) => {
                  await questionnaire.submit(response, options);
                }}
                willAutoCompact={Boolean(questionnaire.thread.head?.willAutoCompact)}
                presentation="compact"
                request={pendingRequest.request}
                spellCheck={settings.get("composerSpellCheck")}
              />
            ) : (
              <ThreadUserInputRequest
                draft={questionnaire.draft}
                mode="preview"
                presentation="compact"
                request={pendingRequest.request}
              />
            )}
          </div>
        </section>
      ) : null}
      {shown.filter(overlapsActive).map(entry => intersectionSection(entry, true))}
      {pendingProposals.length && cwd ? (
        <ThreadTooltipSection aria-label="Commit proposals" className="!pt-0" data-thread-tooltip-proposal="commit">
          {/* The list insets its own rows; its em-sized type is read here at the tooltip's section scale. */}
          <div className="-mx-3 text-[1.1em]">
            <ThreadGitArcProposalList
              acceptance={stack?.acceptance ?? null}
              commitActions={commitActions}
              cwd={cwd}
              harness={harness}
              proposals={pendingProposals}
              stackLayers={stack?.stackLayers ?? []}
              threadId={threadId}
            />
          </div>
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
          <WorkbenchThreadTooltipTodos todos={todos} />
        </ThreadTooltipSection>
      ) : null}
    </div>
    </ContextualProjectProvider>
    </ThreadStoreGitArcObservationProvider>
    </WorkbenchThreadDaemonScope>
  );
}
