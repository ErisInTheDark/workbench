/*
 * Exports:
 * - default ThreadCommandSequence: consecutive command-family items split into their render segments: recall, title, status,
 *   lifecycle and approval rows keep their own renderers, plain commands one row each.
 * - ThreadRegularCommandItem: one shell, MCP or native tool call through its renderer.
 * - ThreadMcpItem: one MCP call: Workbench calls through their specialized renderer, anything else as a tool row.
 * Keep runtime exports component-only for React Refresh.
 */
"use client";

import { useContext, useMemo } from "react";

import { findWorkbenchThreadItemTimelineEntry, type WorkbenchThreadItemTimelineEntry } from "workbench-shared/workbench/thread/thread-item-timeline";
import {
  getThreadCommandExecutionOutcome,
  getWorkbenchCommandRouteSummaryDisplay,
  getWorkbenchMcpCommandRoute,
  shouldUseWorkbenchMcpSpecializedRenderer,
} from "../../../../workbench/thread/thread-command-matchers";
import { ThreadItemApprovalsContext, useThreadItemApproval } from "../../../../workbench/thread/thread-item-approvals";
import { useProject } from "../../use-projects";
import { useTranscript } from "../../use-transcript";
import ThreadCommandDetailRows from "../ThreadCommandDetailRows";
import ThreadContextCommandItem from "../ThreadContextCommandItem";
import ThreadDynamicToolCallItem from "../ThreadDynamicToolCallItem";
import ThreadMcpToolCallItem from "../ThreadMcpToolCallItem";
import ThreadSleepItem from "../ThreadSleepItem";
import ThreadStatusCommandItem from "../ThreadStatusCommandItem";
import ThreadTitleCommandItem from "../ThreadTitleCommandItem";
import ThreadWorkbenchCommandItem from "../ThreadWorkbenchCommandItem";
import { SubagentActivitySlot } from "./subagent-activity-slot";
import { getBrowseItemSteps } from "../thread-browse-steps";
import {
  buildCommandSequenceRenderSegments, type CommandItem, type CommandSequenceItem,
} from "../thread-render-blocks";
import { getThreadSubagentWaitTiming } from "../thread-subagent-wait-groups";
import { useThreadItemLiveDuration } from "../use-thread-live-duration";
import ThreadCommandExecutionDetails from "./ThreadCommandExecutionDetails";
import ThreadRecallItem from "./ThreadRecallItem";
import { getActiveItemStartedAtMs } from "./transcript-blocks";

type McpItem = Extract<CommandSequenceItem, { type: "mcpToolCall" }>;
type Timeline = readonly WorkbenchThreadItemTimelineEntry[] | undefined;

/** One MCP call: Workbench calls through their specialized renderer, anything else as a tool row (Browse with its steps). */
export function ThreadMcpItem ({ itemTimeline, item }: { item: McpItem; itemTimeline: Timeline }) {
  const transcript = useTranscript();
  const turn = useTranscript.turn();
  const project = useProject.contextual();
  const SubagentActivity = useContext(SubagentActivitySlot);
  const activeStartedAtMs = getActiveItemStartedAtMs(item, itemTimeline);
  const durationMs = useThreadItemLiveDuration(item.durationMs, activeStartedAtMs);
  const approval = useThreadItemApproval(item.id);
  const route = getWorkbenchMcpCommandRoute({ argumentsValue: item.arguments, context: project?.mcpMatcherContext, server: item.server, tool: item.tool });
  const isMcpFailure = item.status === "failed" || Boolean(item.error);
  if (shouldUseWorkbenchMcpSpecializedRenderer(route, isMcpFailure) && route?.kind === "specialized" && (
    project?.cwd || route.operation.kind === "feedback" || route.operation.kind === "todo"
    || route.operation.kind === "gitArc" || route.operation.kind === "gitArcWait"
  )) {
    return (
      <ThreadWorkbenchCommandItem
        activeStartedAtMs={activeStartedAtMs}
        item={item}
        relatedThreadsById={transcript.relatedThreadsById}
        renderRecallRecord={(record) => <ThreadRecallItem record={record} />}
        renderSubagentActivity={({ subagent, thread }) => <SubagentActivity fallbackThread={thread} subagent={subagent} />}
        route={route}
        subagents={transcript.subagents}
        threadId={transcript.threadId}
      />
    );
  }
  const browseSteps = getBrowseItemSteps(item, getWorkbenchCommandRouteSummaryDisplay(route), turn.browseResultEntries);
  return (
    <ThreadMcpToolCallItem
      approval={approval}
      details={browseSteps?.length ? <ThreadCommandDetailRows rows={browseSteps} /> : undefined}
      durationMs={durationMs ?? null}
      item={item}
      route={route}
    />
  );
}

export function ThreadRegularCommandItem ({
  item,
  itemTimeline,
}: {
  item: CommandSequenceItem;
  itemTimeline: Timeline;
}) {
  if (item.type === "mcpToolCall") return <ThreadMcpItem item={item} itemTimeline={itemTimeline} />;
  if (item.type === "dynamicToolCall") {
    return <ThreadDynamicToolCallItem activeStartedAtMs={getActiveItemStartedAtMs(item, itemTimeline)} item={item} />;
  }
  return (
    <ThreadCommandExecutionDetails
      activeStartedAtMs={getActiveItemStartedAtMs(item, itemTimeline)}
      item={item}
    />
  );
}

/** Plain commands: one row each. */
function ThreadRegularCommandSequence ({
  itemTimeline,
  items,
}: {
  itemTimeline: Timeline;
  items: CommandSequenceItem[];
}) {
  return items.map(item => <ThreadRegularCommandItem item={item} itemTimeline={itemTimeline} key={item.id} />);
}

export default function ThreadCommandSequence ({
  itemTimeline,
  items: canonicalItems,
}: {
  itemTimeline: Timeline;
  items: CommandSequenceItem[];
}) {
  const transcript = useTranscript();
  const turn = useTranscript.turn();
  const activeCommand = canonicalItems.findLast((item): item is CommandItem => (
    item.type === "commandExecution" && item.status === "inProgress"
  ));
  const presentedOutput = useTranscript.presentedText({
    canonicalText: activeCommand?.aggregatedOutput ?? "",
    field: "commandExecutionOutput",
    itemId: activeCommand?.id ?? "",
    source: activeCommand ? turn.presentationSource : null,
    threadId: transcript.threadId,
    turnId: turn.id,
  });
  const items = useMemo(() => activeCommand
    ? canonicalItems.map((item) => item === activeCommand ? { ...activeCommand, aggregatedOutput: presentedOutput } : item)
    : canonicalItems, [activeCommand, canonicalItems, presentedOutput]);
  const approvals = useContext(ThreadItemApprovalsContext);
  const project = useProject.contextual();
  const renderSegments = useMemo(() => buildCommandSequenceRenderSegments({
    approvalItemIds: approvals,
    items,
    ...project?.matcherContext,
  }), [approvals, items, project]);

  if (!renderSegments.some((segment) => segment.kind !== "commands")) {
    return <ThreadRegularCommandSequence itemTimeline={itemTimeline} items={items} />;
  }

  return (
    <div className="space-y-1">
      {renderSegments.map((segment, index) => {
        switch (segment.kind) {
          case "threadContext":
            return (
              <ThreadContextCommandItem
                activeStartedAtMs={getActiveItemStartedAtMs(segment.item, itemTimeline)}
                key={`thread-context:${segment.item.id}`}
                operation={segment.operation}
                renderRecord={(record) => <ThreadRecallItem record={record} />}
                source={{
                  cwd: segment.item.cwd,
                  durationMs: segment.item.durationMs,
                  exitCode: segment.item.exitCode,
                  id: segment.item.id,
                  outcome: getThreadCommandExecutionOutcome(segment.item.status, segment.item.exitCode),
                  output: segment.item.aggregatedOutput ?? "",
                }}
              />
            );
          case "threadTitle":
            return (
              <ThreadTitleCommandItem
                failureText={segment.item.aggregatedOutput}
                key={`thread-title:${segment.item.id}`}
                outcome={getThreadCommandExecutionOutcome(segment.item.status, segment.item.exitCode)}
                title={segment.title}
              />
            );
          case "threadStatus":
            return (
              <ThreadStatusCommandItem
                failureText={segment.item.aggregatedOutput}
                key={`thread-status:${segment.item.id}`}
                outcome={getThreadCommandExecutionOutcome(segment.item.status, segment.item.exitCode)}
                status={segment.status}
              />
            );
          case "gitArc":
          case "message":
          case "subagent":
            return (
              <ThreadCommandExecutionDetails
                activeStartedAtMs={getActiveItemStartedAtMs(segment.item, itemTimeline)}
                item={segment.item}
                key={`${segment.kind}:${segment.item.id}`}
              />
            );
          case "subagentQueueCheck":
          case "ownRow":
            return (
              <ThreadRegularCommandItem
                item={segment.item}
                itemTimeline={itemTimeline}
                key={`${segment.kind}:${segment.item.id}`}
              />
            );
          case "subagentWait":
            return (
              <ThreadCommandExecutionDetails
                item={segment.group.anchor.item}
                key={`subagent-wait:${segment.group.anchor.item.id}`}
                subagentWaitTiming={getThreadSubagentWaitTiming(segment.group, itemTimeline ?? [])}
              />
            );
          case "sleep":
            return (
              <ThreadSleepItem
                durationMs={segment.durationMs}
                ended={segment.item.status !== "inProgress"}
                key={`sleep:${segment.item.id}`}
                timeline={findWorkbenchThreadItemTimelineEntry(segment.item.id, itemTimeline)}
                turnStatus={turn.status}
              />
            );
          default:
            return (
              <ThreadRegularCommandSequence
                itemTimeline={itemTimeline}
                items={segment.items}
                key={`commands:${segment.items[0]?.id ?? index}`}
              />
            );
        }
      })}
    </div>
  );
}
