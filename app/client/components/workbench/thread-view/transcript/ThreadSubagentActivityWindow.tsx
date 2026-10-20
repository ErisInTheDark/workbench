/*
 * Exports:
 * - default ThreadSubagentActivityWindow: live tail of a child's current turn for wait previews, rendered through the same
 *   block pipeline and block view as the main transcript, inside the child's own transcript scope.
 */
"use client";

import { useContext, useMemo } from "react";

import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import { isVisibleWorkbenchAgentMessageText } from "workbench-shared/workbench/thread/thread-recovery-message";
import type { RelatedThread } from "../../../../workbench/thread/ThreadStore";
import { useThread } from "../../use-thread";
import {
  TranscriptBodiesContext, TranscriptScopeContext, TranscriptTurnContext, useTranscript,
  type TranscriptScope, type TranscriptTurnScope,
} from "../../use-transcript";
import WorkbenchClientContext from "../../workbench-client-context";
import ContextualProjectProvider from "../../ContextualProjectProvider";
import { useProject } from "../../use-projects";
import { useThreadCodeDetails } from "../WorkbenchThreadDisplaySettingsContext";
import { getRenderableBlockKey, type ThreadRenderableBlock } from "../thread-render-blocks";
import ThreadRenderableBlockView from "./ThreadRenderableBlockView";
import { ThreadContentLoadingSkeleton } from "./ThreadTurnLoadStates";
import type { SubagentActivityProps } from "./subagent-activity-slot";
import { buildTranscriptEntries, useStableRenderableBlocks } from "./transcript-blocks";

/** Enough recent context to follow a working child; older turn content stays one tab-click away. */
const SUBAGENT_ACTIVITY_WINDOW_BLOCKS = 24;
const NO_BLOCKS: ThreadRenderableBlock[] = [];
const NO_BROWSE_RESULTS: TranscriptTurnScope["browseResultEntries"] = [];
const NO_SUBAGENTS: TranscriptScope["subagents"] = [];

function getFinalAgentMessageId (turn: Turn) {
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (item.type === "agentMessage" && isVisibleWorkbenchAgentMessageText(item.text) && item.phase === "final_answer") return item.id;
  }
  return null;
}

/**
 * Holding "view" interest keeps the child's own owner refreshing it while it works; the parent's related documents are
 * only loaded once. Transcripts also render without a mounted client, where only the passed document can show.
 */
export default function ThreadSubagentActivityWindow (props: SubagentActivityProps) {
  return useContext(WorkbenchClientContext) && props.subagent
    ? <LiveThreadSubagentActivityWindow fallbackThread={props.fallbackThread} subagent={props.subagent} />
    : <ThreadSubagentActivityWindowBody thread={props.fallbackThread} />;
}

function LiveThreadSubagentActivityWindow ({ fallbackThread, subagent }: SubagentActivityProps & { subagent: NonNullable<SubagentActivityProps["subagent"]> }) {
  const project = useProject.contextual();
  const live = useThread(project?.id ?? "", {
    harness: subagent.harness, kind: "subagent", parentThreadId: subagent.parentThreadId, threadId: subagent.threadId,
  }, "view");
  const { turns } = useTranscript.turns(live.store);
  const thread = useMemo(() => live.head && turns.length ? { ...live.head, turns } : fallbackThread, [live.head, fallbackThread, turns]);
  return (
    <TranscriptBodiesContext.Provider value={live.store?.transcriptBodies ?? null}>
      <ThreadSubagentActivityWindowBody thread={thread} />
    </TranscriptBodiesContext.Provider>
  );
}

/** The child's paths resolve against its own working directory. */
function ThreadSubagentActivityWindowBody ({ thread }: { thread: RelatedThread | undefined }) {
  return (
    <ContextualProjectProvider cwd={thread?.cwd}>
      <ThreadSubagentActivityTail thread={thread} />
    </ContextualProjectProvider>
  );
}

function ThreadSubagentActivityTail ({ thread }: { thread: RelatedThread | undefined }) {
  const parent = useTranscript();
  const project = useProject.contextual();
  const currentTurn = thread?.turns?.at(-1) ?? null;
  const scope = useMemo<TranscriptScope>(() => ({
    relatedThreadsById: parent.relatedThreadsById,
    subagents: NO_SUBAGENTS,
    threadId: thread?.id ?? "",
  }), [parent.relatedThreadsById, thread?.id]);
  const turnScope = useMemo<TranscriptTurnScope | null>(() => currentTurn ? {
    browseResultEntries: NO_BROWSE_RESULTS,
    completedAt: currentTurn.completedAt,
    id: currentTurn.id,
    presentationSource: null,
    startedAt: currentTurn.startedAt,
    status: currentTurn.status,
  } : null, [currentTurn]);
  const turnItems = currentTurn?.items;
  const codeDetails = useThreadCodeDetails();
  const recentBlocks = useMemo(() => turnItems
    ? buildTranscriptEntries(turnItems, { browseResultEntries: NO_BROWSE_RESULTS, codeDetails, hiddenReasoningStep: null, project })
      .flatMap(entry => entry.kind === "block" ? [entry.block] : [])
      .slice(-SUBAGENT_ACTIVITY_WINDOW_BLOCKS)
    : NO_BLOCKS, [codeDetails, project, turnItems]);
  const blocks = useStableRenderableBlocks(recentBlocks);
  if (!thread || !currentTurn || !turnScope) {
    return <ThreadContentLoadingSkeleton />;
  }
  if (!blocks.length) {
    return <p className="m-0 text-[0.92em] leading-[1.6] text-fg/muted">No subagent activity was captured yet.</p>;
  }

  const finalAgentMessageId = getFinalAgentMessageId(currentTurn);
  return (
    <TranscriptScopeContext.Provider value={scope}>
      <TranscriptTurnContext.Provider value={turnScope}>
        <div className="flex flex-col gap-1">
          {blocks.map((block) => (
            <ThreadRenderableBlockView
              animateEntries={false}
              block={block}
              finalAgentMessageId={finalAgentMessageId}
              isMostRecentBlock={block === blocks.at(-1)}
              key={getRenderableBlockKey(block)}
              primaryUserBlock={null}
            />
          ))}
        </div>
      </TranscriptTurnContext.Provider>
    </TranscriptScopeContext.Provider>
  );
}
