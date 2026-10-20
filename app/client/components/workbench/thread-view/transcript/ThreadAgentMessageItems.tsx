/*
 * Exports:
 * - ThreadAgentMessageItem: one agent message as streamed markdown (a typewriter caret holds its spot before text shows), with commentary copy rows and the final answer's timestamp.
 * - ThreadAgentCommentarySequence: consecutive commentary as one hover group, so a merged prose run's copy row appears from any of its items.
 * - ThreadIncomingAgentMessageRuns: one bubble per run of consecutive same-sender incoming messages, stamped with the run's latest message.
 * Keep runtime exports component-only for React Refresh.
 */
"use client";

import { useCallback, useContext, useMemo } from "react";

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { findWorkbenchThreadItemTimelineEntry, type WorkbenchThreadItemTimelineEntry } from "workbench-shared/workbench/thread/thread-item-timeline";
import { stripWorkbenchTurnEndMarker } from "workbench-shared/workbench/thread/thread-recovery-message";
import { readWorkbenchToolOutput } from "workbench-shared/workbench/thread/thread-tool-output";
import { getSubagentSummary } from "../../../../workbench/thread/thread-subagents";
import MarkdownRender from "../../../ui/MarkdownRender";
import { useTranscript } from "../../use-transcript";
import { getThreadEntryMotionIdentity } from "../ThreadEntryMotionController";
import ThreadCommentaryActionRow from "../ThreadCommentaryActionRow";
import ThreadIncomingAgentMessageItem from "../ThreadIncomingAgentMessageItem";
import { ThreadMarkdownSectionActionsProvider } from "../ThreadMarkdownSectionActions";
import ThreadAnimationStyleContext from "../ThreadAnimationStyleContext";
import ThreadMessageTimestamp from "../ThreadMessageTimestamp";
import { ThreadEntryAnimation } from "../ThreadRevealText";
import { buildThreadCommentaryRuns, type ThreadCommentaryRunActions } from "../thread-commentary-runs";
import { groupIncomingAgentMessageRuns, type AgentCommentaryItem, type IncomingAgentMessageItem } from "../thread-render-blocks";
import { ThreadEntryMotion } from "../thread-scroll-viewport-context";
import { UndeliveredSteerActions } from "./ThreadItemActionControls";

export function ThreadAgentMessageItem ({
  canonical = false,
  completedAt,
  copyRuns,
  isFinal,
  isMostRecent = false,
  item,
}: {
  /** Show the stored text only; messages rebuilt from records have no live presentation. */
  canonical?: boolean;
  completedAt: number | null;
  /** Commentary prose runs this item ends; each gets a copy row. */
  copyRuns?: ThreadCommentaryRunActions;
  isFinal: boolean;
  /** Nothing follows this item yet, so a live message may still be streaming. */
  isMostRecent?: boolean;
  item: Extract<ThreadItem, { type: "agentMessage" }>;
}) {
  const transcript = useTranscript();
  const turn = useTranscript.turn();
  const presentationSource = canonical ? null : turn.presentationSource;
  const presentedText = useTranscript.presentedText({
    canonicalText: item.text,
    field: "agentMessageText",
    itemId: item.id,
    source: presentationSource,
    threadId: transcript.threadId,
    turnId: turn.id,
  });
  const text = stripWorkbenchTurnEndMarker(presentedText);
  // No provider-neutral item completion exists; a later item proves this text finished, and a lagging reveal is still streaming.
  const streaming = Boolean(presentationSource) && (isMostRecent || presentedText !== item.text);
  const caret = useContext(ThreadAnimationStyleContext).caret;
  const breakCopyMarkdown = copyRuns?.breakCopyMarkdown;
  const renderBreakActions = useCallback((breakIndex: number) => {
    const markdown = breakCopyMarkdown?.[breakIndex];
    return markdown ? <ThreadCommentaryActionRow markdown={markdown} placement="break" /> : null;
  }, [breakCopyMarkdown]);
  // A typewriter caret waits in the message's spot until its first words show.
  if (!text.trim() && !(streaming && caret)) return null;
  return (
    <section className={copyRuns ? "relative py-2" : "py-2"}>
      <ThreadMarkdownSectionActionsProvider value={copyRuns ? renderBreakActions : null}>
        <MarkdownRender live={Boolean(presentationSource)} markdown={text} streaming={streaming} />
      </ThreadMarkdownSectionActionsProvider>
      {copyRuns?.endCopyMarkdown ? <ThreadCommentaryActionRow markdown={copyRuns.endCopyMarkdown} placement="end" /> : null}
      {isFinal ? <ThreadMessageTimestamp className="mt-1" timestampSeconds={completedAt} /> : null}
    </section>
  );
}

export function ThreadAgentCommentarySequence ({
  animateEntries,
  completedAt,
  isMostRecent,
  items,
}: {
  animateEntries: boolean;
  completedAt: number | null;
  isMostRecent: boolean;
  items: readonly AgentCommentaryItem[];
}) {
  const copyRuns = useMemo(() => buildThreadCommentaryRuns(items.map(item => stripWorkbenchTurnEndMarker(item.text))), [items]);
  return (
    <div className="group/commentary space-y-2">
      {items.map((item, index) => (
        <ThreadEntryMotion enabled={animateEntries && index > 0} identity={getThreadEntryMotionIdentity(item)} key={item.id}>
          {(animate) => (
            <ThreadEntryAnimation play={animate}>
              <ThreadAgentMessageItem
                completedAt={completedAt}
                copyRuns={copyRuns[index]}
                isFinal={false}
                isMostRecent={isMostRecent && index === items.length - 1}
                item={item}
              />
            </ThreadEntryAnimation>
          )}
        </ThreadEntryMotion>
      ))}
    </div>
  );
}

export function ThreadIncomingAgentMessageRuns ({
  items,
  itemTimeline,
}: {
  items: readonly IncomingAgentMessageItem[];
  itemTimeline?: readonly WorkbenchThreadItemTimelineEntry[];
}) {
  const transcript = useTranscript();
  return (
    <>
      {groupIncomingAgentMessageRuns(items).map((run) => {
        const last = run.items.at(-1)!;
        const timeline = findWorkbenchThreadItemTimelineEntry(last.id, itemTimeline);
        const timestampMs = timeline?.firstSeenAt ?? (last.type === "functionCallOutput"
          ? readWorkbenchToolOutput(last)?.workbenchInjectionAcceptedAt
          : timeline?.startedAt);
        const userItems = run.items.filter((item): item is Extract<ThreadItem, { type: "userMessage" }> => item.type === "userMessage");
        return (
          <ThreadIncomingAgentMessageItem
            key={run.items[0]!.id}
            messages={run.messages}
            steerActions={run.deliveryState === "unsent" ? <UndeliveredSteerActions items={userItems} /> : undefined}
            steerState={run.deliveryState}
            subagent={getSubagentSummary(transcript.subagents, run.messages[0].senderThreadId)}
            timestamp={timestampMs === undefined || timestampMs === null
              ? undefined
              : <ThreadMessageTimestamp className="mt-1" timestampSeconds={timestampMs / 1_000} />}
          />
        );
      })}
    </>
  );
}
