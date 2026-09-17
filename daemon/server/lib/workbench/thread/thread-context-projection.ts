/*
 * Exports:
 * - WorkbenchThreadContextPiece: semantic context piece for client and Markdown projections.
 * - WorkbenchThreadContextAgentMessagePiece: attributed native incoming message.
 * - WorkbenchThreadContextUserMessagePiece: canonical user input.
 * - WorkbenchThreadContextUserSteerPiece: recorded user steer.
 * - WorkbenchThreadContextQuestionnairePiece: questionnaire response.
 * - WorkbenchThreadContextPlanBlockPiece: extracted plan block.
 * - createWorkbenchThreadContextSortKey: build a shared chronological sort key.
 * - extractThreadPlanBlocks: collect outer plan blocks from agent messages.
 * - buildWorkbenchThreadContextPieces: build ordered reorientation pieces.
 */

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import type { UserInput } from "workbench-shared/workbench/thread/workbench-thread-items";
import { areUserInputsEquivalentForUserMessageDedupe } from "workbench-shared/workbench/thread/thread-item-normalization";
import type {
  WorkbenchQuestionnaireHistoryEntry,
  WorkbenchSteerHistoryEntry,
  WorkbenchThreadContextBundle,
} from "workbench-shared/types";
import {
  isAgentScreenshotSteerInput,
  isAgentScreenshotSteerUserMessage,
} from "workbench-shared/workbench/thread/thread-steer-markers";
import { unwrapWorkbenchSteerDisplayInput } from "workbench-shared/workbench/thread/thread-steer-display";
import { isWorkbenchHiddenSystemSteerInput } from "workbench-shared/workbench/thread/thread-recovery-message";
import { readWorkbenchAgentMessageItem, type WorkbenchAgentMessage } from "workbench-shared/workbench/thread/thread-agent-message";

type ContextPieceKind = "agentMessage" | "planBlock" | "questionnaire" | "userMessage" | "userSteer";

interface OrderedContextPieceBase {
  itemId: string | null;
  kind: ContextPieceKind;
  sequence: number;
  sortKey: string;
  turnId: string;
}

export interface WorkbenchThreadContextUserMessagePiece extends OrderedContextPieceBase {
  displayInput: UserInput[];
  input: UserInput[];
  itemId: string;
  kind: "userMessage";
}

export interface WorkbenchThreadContextAgentMessagePiece extends OrderedContextPieceBase {
  itemId: string;
  kind: "agentMessage";
  message: WorkbenchAgentMessage;
}

export interface WorkbenchThreadContextUserSteerPiece extends OrderedContextPieceBase {
  displayInput: UserInput[];
  entry: WorkbenchSteerHistoryEntry;
  input: UserInput[];
  kind: "userSteer";
}

export interface WorkbenchThreadContextQuestionnairePiece extends OrderedContextPieceBase {
  entry: WorkbenchQuestionnaireHistoryEntry;
  kind: "questionnaire";
}

export interface WorkbenchThreadContextPlanBlockPiece extends OrderedContextPieceBase {
  blockIndex: number;
  itemId: string;
  kind: "planBlock";
  planMarkdown: string;
}

export type WorkbenchThreadContextPiece =
  | WorkbenchThreadContextAgentMessagePiece
  | WorkbenchThreadContextPlanBlockPiece
  | WorkbenchThreadContextQuestionnairePiece
  | WorkbenchThreadContextUserMessagePiece
  | WorkbenchThreadContextUserSteerPiece;

interface ThreadPosition {
  itemIndex: number;
  turnIndex: number;
}

type MutableContextPiece = WorkbenchThreadContextPiece;

interface CodeFenceOpenLine {
  marker: "`" | "~";
  size: number;
}

export function createWorkbenchThreadContextSortKey(
  turnIndex: number,
  itemIndex: number,
  slot: number,
  subIndex: number,
  timestamp = 0,
) {
  return [
    turnIndex.toString().padStart(8, "0"),
    itemIndex.toString().padStart(8, "0"),
    slot.toString().padStart(4, "0"),
    timestamp.toString().padStart(16, "0"),
    subIndex.toString().padStart(8, "0"),
  ].join(":");
}

function sortContextPieces(pieces: MutableContextPiece[]) {
  return [...pieces].sort((left, right) => {
    const order = left.sortKey.localeCompare(right.sortKey);
    return order || left.sequence - right.sequence;
  });
}

function createTurnIndexes(turns: readonly Turn[]) {
  return new Map(turns.map((turn, index) => [turn.id, index]));
}

function createItemPositions(turns: readonly Turn[]) {
  const positions = new Map<string, ThreadPosition>();
  turns.forEach((turn, turnIndex) => {
    turn.items.forEach((item, itemIndex) => {
      positions.set(item.id, { itemIndex, turnIndex });
    });
  });
  return positions;
}

function createClientItemPositions(turns: readonly Turn[]) {
  const positions = new Map<string, ThreadPosition>();
  turns.forEach((turn, turnIndex) => {
    turn.items.forEach((item, itemIndex) => {
      if (item.type === "userMessage" && item.clientId) {
        positions.set(item.clientId, { itemIndex, turnIndex });
      }
    });
  });
  return positions;
}

function createTurnItemCounts(turns: readonly Turn[]) {
  return new Map(turns.map((turn) => [turn.id, turn.items.length]));
}

function isSteerEntryForUserMessage(
  item: Extract<ThreadItem, { type: "userMessage" }>,
  steerEntries: readonly WorkbenchSteerHistoryEntry[],
) {
  return steerEntries.some((entry) => {
    if (entry.canonicalItemId || entry.clientUserMessageId) {
      return entry.canonicalItemId === item.id
        || entry.clientUserMessageId === item.clientId;
    }
    return areUserInputsEquivalentForUserMessageDedupe(entry.input, item.content);
  });
}

function shouldIncludeUserMessage(
  item: Extract<ThreadItem, { type: "userMessage" }>,
  steerEntries: readonly WorkbenchSteerHistoryEntry[],
) {
  return !isAgentScreenshotSteerUserMessage(item)
    && !isWorkbenchHiddenSystemSteerInput(item.content)
    && !isSteerEntryForUserMessage(item, steerEntries);
}

function shouldIncludeSteerEntry(entry: WorkbenchSteerHistoryEntry) {
  return !isWorkbenchHiddenSystemSteerInput(entry.input)
    && !entry.input.some(isAgentScreenshotSteerInput);
}

function parseCodeFenceOpenLine(line: string): CodeFenceOpenLine | null {
  const match = /^(?: {0,3})(`{3,}|~{3,})/u.exec(line);
  if (!match?.[1]) {
    return null;
  }

  return {
    marker: match[1][0] as "`" | "~",
    size: match[1].length,
  };
}

function isCodeFenceCloseLine(line: string, opener: CodeFenceOpenLine) {
  const escapedMarker = opener.marker === "`" ? "`" : "~";
  const pattern = new RegExp(`^(?: {0,3})${escapedMarker}{${opener.size},}\\s*$`, "u");
  return pattern.test(line);
}

function isPlanOpenLine(line: string) {
  return /^<plan>\s*$/iu.test(line.trim());
}

function isPlanCloseLine(line: string) {
  return /^<\/plan>\s*$/iu.test(line.trim());
}

export function extractThreadPlanBlocks(markdown: string) {
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  const blocks: string[] = [];
  let codeFenceOpener: CodeFenceOpenLine | null = null;
  let planStartIndex: number | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (codeFenceOpener) {
      if (isCodeFenceCloseLine(line, codeFenceOpener)) {
        codeFenceOpener = null;
      }
      continue;
    }

    const fenceOpener = parseCodeFenceOpenLine(line);
    if (fenceOpener) {
      codeFenceOpener = fenceOpener;
      continue;
    }

    if (planStartIndex === null) {
      if (isPlanOpenLine(line)) {
        planStartIndex = index;
      }
      continue;
    }

    if (isPlanCloseLine(line)) {
      blocks.push(lines.slice(planStartIndex, index + 1).join("\n").trim());
      planStartIndex = null;
    }
  }

  return blocks;
}

function pushIncomingMessagePieces(
  pieces: MutableContextPiece[],
  bundle: WorkbenchThreadContextBundle,
  sequence: { value: number },
) {
  bundle.thread.turns.forEach((turn, turnIndex) => {
    turn.items.forEach((item, itemIndex) => {
      if (item.type === "functionCallOutput") {
        const message = readWorkbenchAgentMessageItem(item);
        if (message) {
          pieces.push({
            itemId: item.id,
            kind: "agentMessage",
            message,
            sequence: sequence.value,
            sortKey: createWorkbenchThreadContextSortKey(turnIndex, itemIndex, 0, sequence.value),
            turnId: turn.id,
          });
          sequence.value += 1;
        }
        return;
      }
      if (item.type !== "userMessage" || !shouldIncludeUserMessage(item, bundle.steerEntries)) {
        return;
      }
      const displayInput = unwrapWorkbenchSteerDisplayInput(item.content);
      if (!displayInput.length) {
        return;
      }

      pieces.push({
        displayInput,
        input: item.content,
        itemId: item.id,
        kind: "userMessage",
        sequence: sequence.value,
        sortKey: createWorkbenchThreadContextSortKey(turnIndex, itemIndex, 0, sequence.value),
        turnId: turn.id,
      });
      sequence.value += 1;
    });
  });
}

function pushPlanBlockPieces(
  pieces: MutableContextPiece[],
  bundle: WorkbenchThreadContextBundle,
  sequence: { value: number },
) {
  bundle.thread.turns.forEach((turn, turnIndex) => {
    turn.items.forEach((item, itemIndex) => {
      if (item.type !== "agentMessage" || !item.text.trim()) {
        return;
      }

      extractThreadPlanBlocks(item.text).forEach((planMarkdown, blockIndex) => {
        pieces.push({
          blockIndex,
          itemId: item.id,
          kind: "planBlock",
          planMarkdown,
          sequence: sequence.value,
          sortKey: createWorkbenchThreadContextSortKey(turnIndex, itemIndex, 20, blockIndex),
          turnId: turn.id,
        });
        sequence.value += 1;
      });
    });
  });
}

function resolveQuestionnairePosition(
  entry: WorkbenchQuestionnaireHistoryEntry,
  itemPositions: ReadonlyMap<string, ThreadPosition>,
  turnIndexes: ReadonlyMap<string, number>,
  turnItemCounts: ReadonlyMap<string, number>,
) {
  if (entry.insertAfterItemId) {
    const anchorPosition = itemPositions.get(entry.insertAfterItemId);
    if (anchorPosition) {
      return {
        itemIndex: anchorPosition.itemIndex,
        turnIndex: anchorPosition.turnIndex,
      };
    }
  }

  const turnIndex = turnIndexes.get(entry.turnId) ?? Number.MAX_SAFE_INTEGER;
  if (entry.insertAfterItemIndex !== null && entry.insertAfterItemIndex >= 0) {
    return {
      itemIndex: entry.insertAfterItemIndex,
      turnIndex,
    };
  }

  return {
    itemIndex: turnItemCounts.get(entry.turnId) ?? Number.MAX_SAFE_INTEGER,
    turnIndex,
  };
}

function pushQuestionnairePieces(
  pieces: MutableContextPiece[],
  bundle: WorkbenchThreadContextBundle,
  itemPositions: ReadonlyMap<string, ThreadPosition>,
  turnIndexes: ReadonlyMap<string, number>,
  turnItemCounts: ReadonlyMap<string, number>,
  sequence: { value: number },
) {
  for (const entry of bundle.questionnaireEntries) {
    const position = resolveQuestionnairePosition(entry, itemPositions, turnIndexes, turnItemCounts);
    pieces.push({
      entry,
      itemId: entry.itemId,
      kind: "questionnaire",
      sequence: sequence.value,
      sortKey: createWorkbenchThreadContextSortKey(
        position.turnIndex,
        position.itemIndex,
        40,
        sequence.value,
        entry.resolvedAt,
      ),
      turnId: entry.turnId,
    });
    sequence.value += 1;
  }
}

function resolveSteerPosition(
  entry: WorkbenchSteerHistoryEntry,
  itemPositions: ReadonlyMap<string, ThreadPosition>,
  clientItemPositions: ReadonlyMap<string, ThreadPosition>,
  turnIndexes: ReadonlyMap<string, number>,
  turnItemCounts: ReadonlyMap<string, number>,
) {
  if (entry.canonicalItemId) {
    const canonicalPosition = itemPositions.get(entry.canonicalItemId);
    if (canonicalPosition) {
      return canonicalPosition;
    }
  }

  if (entry.clientUserMessageId) {
    const clientPosition = clientItemPositions.get(entry.clientUserMessageId);
    if (clientPosition) {
      return clientPosition;
    }
  }

  return {
    itemIndex: turnItemCounts.get(entry.turnId) ?? Number.MAX_SAFE_INTEGER,
    turnIndex: turnIndexes.get(entry.turnId) ?? Number.MAX_SAFE_INTEGER,
  };
}

function pushSteerPieces(
  pieces: MutableContextPiece[],
  bundle: WorkbenchThreadContextBundle,
  itemPositions: ReadonlyMap<string, ThreadPosition>,
  clientItemPositions: ReadonlyMap<string, ThreadPosition>,
  turnIndexes: ReadonlyMap<string, number>,
  turnItemCounts: ReadonlyMap<string, number>,
  sequence: { value: number },
) {
  for (const entry of bundle.steerEntries) {
    if (!shouldIncludeSteerEntry(entry)) {
      continue;
    }
    const displayInput = unwrapWorkbenchSteerDisplayInput(entry.input);
    if (!displayInput.length) {
      continue;
    }

    const position = resolveSteerPosition(entry, itemPositions, clientItemPositions, turnIndexes, turnItemCounts);
    pieces.push({
      displayInput,
      entry,
      input: entry.input,
      itemId: entry.canonicalItemId,
      kind: "userSteer",
      sequence: sequence.value,
      sortKey: createWorkbenchThreadContextSortKey(
        position.turnIndex,
        position.itemIndex,
        10,
        sequence.value,
        entry.attemptedAt,
      ),
      turnId: entry.turnId,
    });
    sequence.value += 1;
  }
}

export function buildWorkbenchThreadContextPieces(bundle: WorkbenchThreadContextBundle): WorkbenchThreadContextPiece[] {
  const itemPositions = createItemPositions(bundle.thread.turns);
  const clientItemPositions = createClientItemPositions(bundle.thread.turns);
  const turnIndexes = createTurnIndexes(bundle.thread.turns);
  const turnItemCounts = createTurnItemCounts(bundle.thread.turns);
  const pieces: MutableContextPiece[] = [];
  const sequence = { value: 0 };

  pushIncomingMessagePieces(pieces, bundle, sequence);
  pushSteerPieces(pieces, bundle, itemPositions, clientItemPositions, turnIndexes, turnItemCounts, sequence);
  pushQuestionnairePieces(pieces, bundle, itemPositions, turnIndexes, turnItemCounts, sequence);
  pushPlanBlockPieces(pieces, bundle, sequence);

  return sortContextPieces(pieces);
}
