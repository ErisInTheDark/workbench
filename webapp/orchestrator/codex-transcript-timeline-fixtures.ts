/*
 * Exports:
 * - No production exports; typechecked manual fixtures for transcript timeline helpers. Keywords: codex, transcript, fixtures.
 */
import type { ThreadItem } from "../lib/codex/generated/app-server/v2/ThreadItem";
import { mergeThreadItem } from "./codex-transcript-item-merge";
import { orderMergedItemsByTimeline, rememberTimelineItem } from "./codex-transcript-timeline";
import type { CodexTranscriptTurnTimelineEntry } from "./codex-transcript-types";

const agentMessage = {
  id: "agent-1",
  memoryCitation: null,
  phase: "commentary",
  text: "Working",
  type: "agentMessage",
} satisfies ThreadItem;

const commandExecution = {
  aggregatedOutput: "done",
  command: "pnpm typecheck",
  commandActions: [],
  cwd: "C:/git/web/workbench/webapp",
  durationMs: 12,
  exitCode: 0,
  id: "cmd-1",
  processId: null,
  source: "agent",
  status: "completed",
  type: "commandExecution",
} satisfies ThreadItem;

const timeline = rememberTimelineItem({
  itemOrder: [],
  itemTimeline: [],
  turn: {
    completedAt: null,
    durationMs: null,
    error: null,
    id: "turn-1",
    items: [agentMessage],
    itemsView: "full",
    startedAt: null,
    status: "inProgress",
  },
}, agentMessage.id, "anchor");

const timelineWithCommand = rememberTimelineItem({
  itemOrder: [],
  itemTimeline: timeline,
  turn: {
    completedAt: null,
    durationMs: null,
    error: null,
    id: "turn-1",
    items: [agentMessage, commandExecution],
    itemsView: "full",
    startedAt: null,
    status: "inProgress",
  },
}, commandExecution.id, "non-anchor");

const orderedItems = orderMergedItemsByTimeline([commandExecution, agentMessage], timelineWithCommand);
const mergedCommand = mergeThreadItem({ ...commandExecution, aggregatedOutput: null, status: "inProgress" }, commandExecution);

void ([
  timeline,
  timelineWithCommand,
  orderedItems,
  mergedCommand,
] satisfies [CodexTranscriptTurnTimelineEntry[], CodexTranscriptTurnTimelineEntry[], ThreadItem[], ThreadItem]);

// Manual checklist:
// - `orderedItems` should be `[agentMessage, commandExecution]`, proving command/tool items stay after their anchor.
// - `mergedCommand` should keep stored command output and completed status.
// - Partial `itemTimeline` + legacy `itemOrder` cases should be added here when implementing migrations.
