/*
 * Exports:
 * - default ThreadRenderableBlockView: one renderable block through its renderer: activity runs (their steps through the
 *   command, file, reasoning and web-search renderers), messages, coordination and single items. Memoised per block and timeline.
 */
"use client";

import { memo } from "react";

import { findWorkbenchThreadItemTimelineEntry, type WorkbenchThreadItemTimelineEntry } from "workbench-shared/workbench/thread/thread-item-timeline";
import { readWorkbenchToolOutput } from "workbench-shared/workbench/thread/thread-tool-output";
import { useProject } from "../../use-projects";
import { useTranscript } from "../../use-transcript";
import ThreadActivityRun from "../ThreadActivityRun";
import ThreadBrowseStepIcon from "../ThreadBrowseStepIcon";
import ThreadCommandDetailRows from "../ThreadCommandDetailRows";
import ThreadContextCompactionItem from "../ThreadContextCompactionItem";
import ThreadDynamicToolCallItem from "../ThreadDynamicToolCallItem";
import ThreadFileChangeItem from "../ThreadFileChangeItem";
import ThreadGenericItem from "../ThreadGenericItem";
import ThreadIncomingAgentMessageGroup from "../ThreadIncomingAgentMessageGroup";
import ThreadMessageTimestamp from "../ThreadMessageTimestamp";
import ThreadSleepItem from "../ThreadSleepItem";
import ThreadToolOutputItem from "../ThreadToolOutputItem";
import ThreadWebSearchItem, { ThreadWebSearchSequence } from "../ThreadWebSearchItem";
import { getCommandItemDisplay } from "../thread-activity-chips";
import { getLiftedBrowseSteps } from "../thread-browse-steps";
import { hasSameBlockTimeline, type ThreadRenderableBlock } from "../thread-render-blocks";
import { ThreadAgentCommentarySequence, ThreadAgentMessageItem, ThreadIncomingAgentMessageRuns } from "./ThreadAgentMessageItems";
import ThreadCommandSequence, { ThreadMcpItem } from "./ThreadCommandSequence";
import ThreadReasoningSequence from "./ThreadReasoningSequence";
import ThreadSubagentCoordination, { ThreadSubagentWaitExchange } from "./ThreadSubagentCoordination";
import ThreadUserMessageItem, { ThreadUserMessageSequence } from "./ThreadUserMessageItem";
import { getActiveItemStartedAtMs } from "./transcript-blocks";

type Timeline = readonly WorkbenchThreadItemTimelineEntry[] | undefined;
type ActivityRunBlock = Extract<ThreadRenderableBlock, { kind: "activityRun" }>;
type ItemBlock = Extract<ThreadRenderableBlock, { kind: "item" }>;

interface BlockViewProps {
  animateEntries: boolean;
  block: ThreadRenderableBlock;
  finalAgentMessageId: string | null;
  isMostRecentBlock: boolean;
  itemTimeline?: Timeline;
  primaryUserBlock: ThreadRenderableBlock | null;
}

function timestampSeconds(timestampMs: number | null | undefined) {
  return timestampMs === undefined || timestampMs === null ? null : timestampMs / 1_000;
}

/** A run's steps through each group's renderer; Browse calls lift into one row per step. */
function ThreadActivityRunBlock({ animateEntries, block, isMostRecent, itemTimeline }: {
  animateEntries: boolean;
  block: ActivityRunBlock;
  isMostRecent: boolean;
  itemTimeline: Timeline;
}) {
  const turn = useTranscript.turn();
  const project = useProject.contextual();
  return (
    <ThreadActivityRun
      animateEntries={animateEntries}
      block={block}
      isMostRecent={isMostRecent}
      itemTimeline={itemTimeline}
      renderers={{
        code: ({ item }) => <ThreadDynamicToolCallItem activeStartedAtMs={getActiveItemStartedAtMs(item, itemTimeline)} item={item} />,
        commands: ({ items }) => items.map((item) => {
          const browseSteps = getLiftedBrowseSteps(item, getCommandItemDisplay(item, { ...project?.matcherContext, cwd: project?.cwd }), turn.browseResultEntries);
          return browseSteps
            ? <ThreadCommandDetailRows icon={row => <ThreadBrowseStepIcon row={row} />} key={item.id} rows={browseSteps} />
            : <ThreadCommandSequence itemTimeline={itemTimeline} items={[item]} key={item.id} />;
        }),
        files: ({ items }) => <ThreadFileChangeItem animateEntries={animateEntries} items={items} />,
        reasoning: ({ item }, isLastSegment) => (
          <ThreadReasoningSequence block={{ items: [item], kind: "reasoningSequence" }} isMostRecent={isMostRecent && isLastSegment} />
        ),
        sleep: ({ durationMs, item }) => (
          <ThreadSleepItem
            durationMs={durationMs}
            ended={item.type === "commandExecution" && item.status !== "inProgress"}
            timeline={findWorkbenchThreadItemTimelineEntry(item.id, itemTimeline)}
            turnStatus={turn.status}
          />
        ),
        webSearch: ({ items }) => <ThreadWebSearchSequence items={items} />,
      }}
      turnLive={turn.status === "inProgress"}
    />
  );
}

function ThreadItemBlock({ block, finalAgentMessageId, isMostRecent, itemTimeline, primaryUserBlock }: {
  block: ItemBlock;
  finalAgentMessageId: string | null;
  isMostRecent: boolean;
  itemTimeline: Timeline;
  primaryUserBlock: ThreadRenderableBlock | null;
}) {
  const transcript = useTranscript();
  const turn = useTranscript.turn();
  const item = block.item;
  switch (item.type) {
    case "functionCallOutput": {
      if (item.resultExpiredAt) return <p className="py-2 text-[0.92em] text-fg/muted">Result expired after 1 day.</p>;
      const output = readWorkbenchToolOutput(item);
      if (!output) return <ThreadGenericItem item={item} threadId={transcript.threadId} />;
      const timestamp = findWorkbenchThreadItemTimelineEntry(output.id, itemTimeline)?.firstSeenAt ?? output.workbenchInjectionAcceptedAt;
      return (
        <ThreadToolOutputItem
          item={output}
          subagents={transcript.subagents}
          timestamp={timestamp === undefined || timestamp === null
            ? undefined
            : <ThreadMessageTimestamp className="mt-1" timestampSeconds={timestamp / 1_000} />}
        />
      );
    }
    case "userMessage": {
      const timeline = findWorkbenchThreadItemTimelineEntry(item.id, itemTimeline);
      const isPrimary = item.id === (primaryUserBlock?.kind === "item" ? primaryUserBlock.item.id : null);
      return (
        <ThreadUserMessageItem
          item={item}
          startedAt={timestampSeconds(timeline?.firstSeenAt ?? timeline?.startedAt) ?? (isPrimary ? turn.startedAt : null)}
        />
      );
    }
    case "agentMessage":
      return (
        <ThreadAgentMessageItem
          completedAt={turn.completedAt}
          isFinal={item.id === finalAgentMessageId}
          isMostRecent={isMostRecent}
          item={item}
        />
      );
    case "plan":
      return null;
    case "contextCompaction": {
      const timelineEntry = findWorkbenchThreadItemTimelineEntry(item.id, itemTimeline);
      // Workbench owns compaction status; only status-less items from older daemons fall back to turn activity.
      const isActive = item.status
        ? item.status === "inProgress"
        : turn.status === "inProgress" && (!timelineEntry || timelineEntry.completedAt === null);
      return (
        <ThreadContextCompactionItem
          completedAt={timelineEntry?.completedAt}
          isActive={isActive}
          item={item}
          startedAt={timelineEntry?.startedAt ?? timelineEntry?.firstSeenAt}
        />
      );
    }
    case "mcpToolCall":
      return <ThreadMcpItem item={item} itemTimeline={itemTimeline} />;
    case "dynamicToolCall":
      return (
        <ThreadDynamicToolCallItem
          activeStartedAtMs={getActiveItemStartedAtMs(item, itemTimeline)}
          answeredAt={findWorkbenchThreadItemTimelineEntry(item.id, itemTimeline)?.completedAt ?? null}
          item={item}
        />
      );
    case "webSearch":
      return <ThreadWebSearchItem item={item} />;
    case "collabAgentToolCall":
      return null;
    default:
      return (
        <ThreadGenericItem
          item={item}
          threadId={transcript.threadId}
          timeline={findWorkbenchThreadItemTimelineEntry(item.id, itemTimeline)}
          turnStatus={turn.status}
        />
      );
  }
}

function ThreadRenderableBlockViewComponent ({
  animateEntries,
  block,
  finalAgentMessageId,
  isMostRecentBlock,
  itemTimeline,
  primaryUserBlock,
}: BlockViewProps) {
  const transcript = useTranscript();
  const turn = useTranscript.turn();
  switch (block.kind) {
    case "activityRun":
      return <ThreadActivityRunBlock animateEntries={animateEntries} block={block} isMostRecent={isMostRecentBlock} itemTimeline={itemTimeline} />;
    case "subagentCoordination":
      return <ThreadSubagentCoordination block={block} itemTimeline={itemTimeline} />;
    case "agentMessageSequence":
      return (
        <ThreadIncomingAgentMessageGroup items={block.items} state={block.state} subagents={transcript.subagents}>
          <ThreadIncomingAgentMessageRuns itemTimeline={itemTimeline} items={block.items} />
        </ThreadIncomingAgentMessageGroup>
      );
    case "agentCommentarySequence":
      return (
        <ThreadAgentCommentarySequence
          animateEntries={animateEntries}
          completedAt={turn.completedAt}
          isMostRecent={isMostRecentBlock}
          items={block.items}
        />
      );
    case "subagentWaitExchange":
      return <ThreadSubagentWaitExchange block={block} itemTimeline={itemTimeline} />;
    case "userMessageSequence": {
      const timeline = findWorkbenchThreadItemTimelineEntry(block.items.at(-1)!.id, itemTimeline);
      return <ThreadUserMessageSequence items={block.items} startedAt={timestampSeconds(timeline?.firstSeenAt ?? timeline?.startedAt)} />;
    }
    case "commandSequence":
      return <ThreadCommandSequence itemTimeline={itemTimeline} items={block.items} />;
    case "fileChangeSequence":
      return (
        <ThreadFileChangeItem animateEntries={animateEntries} items={block.items} />
      );
    case "reasoningSequence":
      return <ThreadReasoningSequence block={block} isMostRecent={isMostRecentBlock} />;
    case "webSearchSequence":
      return <ThreadWebSearchSequence items={block.items} />;
    case "item":
      return (
        <ThreadItemBlock
          block={block}
          finalAgentMessageId={finalAgentMessageId}
          isMostRecent={isMostRecentBlock}
          itemTimeline={itemTimeline}
          primaryUserBlock={primaryUserBlock}
        />
      );
  }
}

/** Scope and turn changes reach blocks through context; props compare only what is per block. */
export default memo(ThreadRenderableBlockViewComponent, (left, right) => (
  left.block === right.block
  && left.finalAgentMessageId === right.finalAgentMessageId
  && hasSameBlockTimeline(left.block, left.itemTimeline, right.itemTimeline)
  && left.isMostRecentBlock === right.isMostRecentBlock
  && left.primaryUserBlock === right.primaryUserBlock
));
