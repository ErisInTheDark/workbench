/*
 * Exports:
 * - No production exports; typechecked manual fixtures for transcript timeline helpers. Keywords: codex, transcript, fixtures.
 */
import type { ThreadItem } from "../lib/codex/generated/app-server/v2/ThreadItem";
import { normalizeThreadItems } from "../lib/codex/thread-item-normalization";
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

const granularReasoningA = {
  content: [],
  id: "rs-a",
  summary: ["**Considering context skills**\n\nI need to focus on the context skill."],
  type: "reasoning",
} satisfies ThreadItem;

const granularReasoningB = {
  content: [],
  id: "rs-b",
  summary: ["**Investigating project guidance**\n\nI need to locate the project guidance."],
  type: "reasoning",
} satisfies ThreadItem;

const cumulativeSnapshotReasoning = {
  content: [],
  id: "item-5",
  summary: [
    granularReasoningA.summary[0],
    granularReasoningB.summary[0],
  ],
  type: "reasoning",
} satisfies ThreadItem;

const indexedGenericSnapshotReasoning = {
  content: [],
  id: "item-6",
  summary: [
    "",
    granularReasoningA.summary[0],
    "Unique generic snapshot segment",
  ],
  type: "reasoning",
} satisfies ThreadItem;

const repeatedCanonicalReasoningA = {
  content: [],
  id: "rs-c",
  summary: [granularReasoningA.summary[0]],
  type: "reasoning",
} satisfies ThreadItem;

const canonicalUserMessage = {
  content: [{
    text: "/iterate duplicate user message",
    text_elements: [],
    type: "text",
  }],
  id: "user-canonical",
  clientId: null,
  type: "userMessage",
} satisfies ThreadItem;

const genericSnapshotUserMessage = {
  content: [{
    text_elements: [],
    text: "/iterate duplicate user message",
    type: "text",
  }],
  id: "item-1",
  clientId: null,
  type: "userMessage",
} satisfies ThreadItem;

const inlineImageUserMessage = {
  content: [
    {
      text: "same image prompt",
      text_elements: [],
      type: "text",
    },
    {
      type: "image",
      url: "data:image/png;base64,iVBORw0KGgo=",
    },
  ],
  id: "optimistic-user-message:initial:sent:1",
  clientId: null,
  type: "userMessage",
} satisfies ThreadItem;

const transcriptAssetImageUserMessage = {
  content: [
    {
      text: "same image prompt",
      text_elements: [],
      type: "text",
    },
    {
      type: "image",
      url: "/api/transcript-assets/codex/thread-1/hash.png",
    },
  ],
  id: "item-image-canonical",
  clientId: null,
  type: "userMessage",
} satisfies ThreadItem;

const normalizedReasoningItems = normalizeThreadItems([
  granularReasoningA,
  granularReasoningB,
  cumulativeSnapshotReasoning,
]);
const normalizedReasoningItemsFromGenericFirst = normalizeThreadItems([
  cumulativeSnapshotReasoning,
  granularReasoningA,
  granularReasoningB,
]);
const normalizedIndexedGenericSnapshotReasoning = normalizeThreadItems([
  granularReasoningA,
  indexedGenericSnapshotReasoning,
]);
const normalizedRepeatedCanonicalReasoning = normalizeThreadItems([
  granularReasoningA,
  repeatedCanonicalReasoningA,
]);
const normalizedDuplicateUserMessages = normalizeThreadItems([
  canonicalUserMessage,
  agentMessage,
  genericSnapshotUserMessage,
]);
const normalizedDuplicateImageUserMessages = normalizeThreadItems([
  inlineImageUserMessage,
  agentMessage,
  transcriptAssetImageUserMessage,
], { mergeDuplicateItems: mergeThreadItem });

const contextCompaction = {
  id: "compaction-live-a",
  type: "contextCompaction",
} satisfies ThreadItem;

const snapshotContextCompaction = {
  id: "item-97",
  type: "contextCompaction",
} satisfies ThreadItem;

const secondContextCompaction = {
  id: "compaction-live-b",
  type: "contextCompaction",
} satisfies ThreadItem;

const secondSnapshotContextCompaction = {
  id: "item-102",
  type: "contextCompaction",
} satisfies ThreadItem;

const extraSnapshotContextCompaction = {
  id: "item-103",
  type: "contextCompaction",
} satisfies ThreadItem;

const postCompactionAgentMessage = {
  id: "agent-after-compaction",
  memoryCitation: null,
  phase: "commentary",
  text: "After compaction",
  type: "agentMessage",
} satisfies ThreadItem;

const timelineWithAliasedContextCompaction = [
  {
    anchorItemId: agentMessage.id,
    itemId: agentMessage.id,
    sequence: 1,
  },
  {
    aliases: [snapshotContextCompaction.id],
    anchorItemId: agentMessage.id,
    completedAt: 3000,
    firstSeenAt: 1000,
    itemId: contextCompaction.id,
    lastSeenAt: 3000,
    sequence: 2,
    startedAt: 1000,
  },
  {
    aliases: [secondSnapshotContextCompaction.id],
    anchorItemId: agentMessage.id,
    completedAt: 5000,
    firstSeenAt: 4000,
    itemId: secondContextCompaction.id,
    lastSeenAt: 5000,
    sequence: 3,
    startedAt: 4000,
  },
  {
    anchorItemId: postCompactionAgentMessage.id,
    itemId: postCompactionAgentMessage.id,
    sequence: 4,
  },
] satisfies CodexTranscriptTurnTimelineEntry[];
const orderedItemsWithAliasedContextCompaction = orderMergedItemsByTimeline([
  agentMessage,
  postCompactionAgentMessage,
  contextCompaction,
  snapshotContextCompaction,
  secondContextCompaction,
  secondSnapshotContextCompaction,
  extraSnapshotContextCompaction,
], timelineWithAliasedContextCompaction);

void ([
  timeline,
  timelineWithCommand,
  orderedItems,
  mergedCommand,
  normalizedReasoningItems,
  normalizedReasoningItemsFromGenericFirst,
  normalizedIndexedGenericSnapshotReasoning,
  normalizedRepeatedCanonicalReasoning,
  normalizedDuplicateUserMessages,
  normalizedDuplicateImageUserMessages,
  orderedItemsWithAliasedContextCompaction,
] satisfies [CodexTranscriptTurnTimelineEntry[], CodexTranscriptTurnTimelineEntry[], ThreadItem[], ThreadItem, ThreadItem[], ThreadItem[], ThreadItem[], ThreadItem[], ThreadItem[], ThreadItem[], ThreadItem[]]);

// Manual checklist:
// - `orderedItems` should be `[agentMessage, commandExecution]`, proving command/tool items stay after their anchor.
// - `mergedCommand` should keep stored command output and completed status.
// - `normalizedReasoningItems` should keep `rs-a` and `rs-b`, then drop duplicate cumulative snapshot item `item-5`.
// - `normalizedReasoningItemsFromGenericFirst` should still prefer granular `rs-*` items when the generic snapshot item appears first.
// - `normalizedIndexedGenericSnapshotReasoning` should preserve the generic snapshot summary indexes while blanking only duplicated segments.
// - `normalizedRepeatedCanonicalReasoning` should keep both canonical `rs-*` reasoning items even when their text matches.
// - `normalizedDuplicateUserMessages` should keep the canonical turn-start user item and remove the generic snapshot duplicate.
// - `normalizedDuplicateImageUserMessages` should keep one top-position user item when an optimistic inline image is later represented as a transcript asset URL.
// - `orderedItemsWithAliasedContextCompaction` should keep one item per aliased compaction between the surrounding messages and leave the unmatched extra compaction at the end.
// - Partial `itemTimeline` + legacy `itemOrder` cases should be added here when implementing migrations.
