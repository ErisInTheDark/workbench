/*
 * Exports:
 * - default ThreadViewStatus: the shown thread's status row (live activity, git arc work, vis, skills, todos and feedback) and its error card.
 */
"use client";

import { useContext, useMemo } from "react";

import type { WorkbenchSkillSummary } from "workbench-shared/types";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchThreadRouteTarget } from "workbench-shared/workbench/thread/thread-state";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import useWorkspaceObservation from "../../../workbench/app/use-workspace-observation";
import { useThread } from "../use-thread";
import { useTranscript } from "../use-transcript";
import WorkbenchWorkspaceContext, { useWorkbenchDaemonClient } from "../WorkbenchWorkspaceContext";
import type ThreadCheckpointCommitActions from "./ThreadCheckpointCommitActions";
import ThreadAddressedFeedback from "./ThreadAddressedFeedback";
import ThreadErrorCard from "./ThreadErrorCard";
import ThreadStatusArea from "./ThreadStatusArea";
import ThreadTodoPanel from "./ThreadTodoPanel";
import { getThreadGitArcWork } from "./thread-git-arc-presentation";
import { getLiveThreadActivity, getThreadTerminalEntries } from "./thread-live-activity";
import type { ThreadTodoControls } from "./thread-todo-controls";
import type { ThreadReferenceSelection } from "./use-thread-reference-selection";
import useThreadLiveActivity from "./use-thread-live-activity";
import { readActiveTranscript } from "./ThreadViewTranscript";

export default function ThreadViewStatus ({
  checkpointCommitActions,
  isMessageBoardOpen,
  projectId,
  projectRootPath,
  referenceSelection,
  skills,
  target,
  threadId,
  todoControls,
  workspaceRoots,
}: {
  /** Owned by the view, so pending commit state outlives the composer remount on a tab switch. */
  checkpointCommitActions: ThreadCheckpointCommitActions;
  isMessageBoardOpen: boolean;
  projectId: string;
  projectRootPath: string;
  referenceSelection: ThreadReferenceSelection;
  skills: WorkbenchSkillSummary[];
  /** The shown thread: the root, or the selected subagent. */
  target: WorkbenchThreadRouteTarget;
  /** The shown thread's id, known before its head loads. */
  threadId: string;
  todoControls: ThreadTodoControls;
  workspaceRoots: readonly WorkspaceFileLinkRoot[];
}) {
  const daemon = useWorkbenchDaemonClient();
  const active = useThread(projectId, target, "view");
  const activeThread = active.head;
  const turns = useTranscript.turns(active.store);
  const { pending: pendingUserInputRequest } = useThread.questionnaire(active.store);
  const visQuery = useMemo(() => ({ kind: "threadVis" as const, threadId: ThreadReferenceSchema.parse(threadId) }), [threadId]);
  const vis = useWorkspaceObservation(useContext(WorkbenchWorkspaceContext), visQuery).value?.data ?? null;
  const visActions = useMemo(() => ({
    onEnd: (sessionId: string) => { void daemon?.threads.vis.end({ threadId, sessionId }).catch((error: unknown) => console.error("Ending the vis session failed.", error)); },
    // The card reports a change that was not saved, so a failure reaches the user there.
    onControl: async (sessionId: string, controlId: string, value: string) => {
      if (!daemon) throw new Error("Workbench is not connected.");
      await daemon.threads.vis.control({ threadId, sessionId, controlId, value });
    },
  }), [threadId, daemon]);

  const usesSqlTranscript = Boolean(activeThread && !activeThread.isDraft);
  const isDraftThreadView = Boolean(activeThread?.isDraft);
  const { source: transcriptSource, projection } = readActiveTranscript(activeThread, turns.transcript);
  const loadedTurns = activeThread?.isDraft || projection ? turns.turns : null;
  const activityTurn = loadedTurns?.at(-1) ?? null;
  // The thread's lifecycle decides liveness; a provider's turn status never does.
  const liveTurn = activityTurn && activityTurn.id === turns.liveTurnId ? activityTurn : null;
  const terminalContext = useMemo(() => ({
    cwd: activeThread?.cwd || projectRootPath || ".",
    knownSkills: skills, projectRootPath, workspaceRoots,
  }), [activeThread?.cwd, projectRootPath, skills, workspaceRoots]);
  const terminalRetention = useMemo(() => ({
    itemTimeline: projection?.turns.at(-1)?.itemTimeline,
    turnStartedAt: activityTurn?.startedAt,
  }), [projection, activityTurn]);
  const terminalCommands = useMemo(() => getThreadTerminalEntries(
    liveTurn ? liveTurn.items.filter(item => "status" in item && item.status === "inProgress") : [],
    { ...terminalContext, includeOutput: false },
  ), [liveTurn, terminalContext]);
  const liveActivity = useMemo(() => getLiveThreadActivity({
    pendingUserInputRequest, turn: liveTurn, commands: terminalCommands,
  }), [pendingUserInputRequest, liveTurn, terminalCommands]);
  const live = useThreadLiveActivity({
    activity: liveActivity,
    items: liveTurn?.items ?? [],
    terminalContext,
    terminalRetention,
    presentationSource: activeThread ? { kind: "sqlite", sourceKey: `${activeThread.harness}:${activeThread.id}` } : null,
    threadId: activeThread?.id ?? "",
    turnId: liveTurn?.id ?? null,
  });

  const entry = active.entry;
  const gitCommits = entry?.gitCommits ?? [];
  const gitArcWork = getThreadGitArcWork({ gitArc: entry?.gitArc ?? null, proposalObservations: active.gitArcProposals });
  const sourceFailed = transcriptSource?.status === "failed" || transcriptSource?.status === "absent"
    || transcriptSource?.status === "unavailable";
  // Thread chrome under the transcript waits for it, so opening goes skeleton -> whole view in one step.
  const transcriptCanRender = !usesSqlTranscript || projection !== null || sourceFailed;
  if (!activeThread || !transcriptCanRender) return null;
  const headTodos = active.head?.todos;
  const headFeedback = active.head?.addressedFeedback;
  return <>
    {!isMessageBoardOpen && (live || !isDraftThreadView) ? (
      <ThreadStatusArea
        // Observed heads learn the working directory with the transcript; the arc panel's Git requests need it.
        gitArc={!isDraftThreadView && activeThread.cwd && (gitArcWork || gitCommits.length) ? {
          claim: gitArcWork,
          commitActions: checkpointCommitActions,
          cwd: activeThread.cwd,
          harness: activeThread.harness,
          running: liveTurn !== null,
        } : null}
        gitCommits={gitCommits}
        harness={activeThread.harness}
        key={activeThread.id}
        live={live}
        skills={entry && !isDraftThreadView ? { onDeactivate: active.actions.deactivateSkill, skills: active.head?.skills ?? [] } : null}
        threadId={activeThread.id}
        threadLifecycle={entry?.lifecycle ?? null}
        vis={!isDraftThreadView && vis?.sessions.length ? { sessions: vis.sessions, ...visActions } : null}
        todos={entry && !isDraftThreadView ? {
          goalSet: Boolean(active.head?.goal),
          count: headTodos?.length ?? 0,
          feedbackCount: headFeedback?.length ?? 0,
          renderPanel: () => (
            <>
              <ThreadTodoPanel
                controls={todoControls}
                goal={active.head?.goal ?? null}
                onAddTodo={active.actions.addTodo}
                onClearGoal={active.actions.clearGoal}
                onSetGoal={active.actions.setGoal}
              />
              <ThreadAddressedFeedback
                feedback={headFeedback ?? []}
                onDetach={active.actions.detachAddressedFeedback}
                selection={referenceSelection}
              />
            </>
          ),
        } : null}
      />
    ) : null}
    {!isDraftThreadView ? <ThreadErrorCard lifecycle={entry?.lifecycle} /> : null}
  </>;
}
