/*
 * Exports:
 * - WorkbenchThreadRecallRecord/WorkbenchThreadRecallSearchResult/WorkbenchThreadRecallExpansion: pure recall projection result contracts. Keywords: thread recall, search, expansion.
 * - buildWorkbenchThreadRecallRecords: project one thread bundle into ordered searchable narrative records. Keywords: thread recall, narrative, projection.
 * - searchWorkbenchThreadRecall: find bounded literal matches across recall records. Keywords: thread recall, search, snippet.
 * - expandWorkbenchThreadRecall: select one stable ref and its chronological neighbors. Keywords: thread recall, expand, context.
 */

import type { ThreadItem } from "../../codex/generated/app-server/v2/ThreadItem";
import type {
  WorkbenchThreadContextBundle,
  WorkbenchThreadRecallKind,
} from "../../types";
import {
  getWorkbenchThreadContextPieceRef,
  renderWorkbenchThreadContextPieceMarkdown,
} from "./thread-context-markdown.ts";
import {
  buildWorkbenchThreadContextPieces,
  createWorkbenchThreadContextSortKey,
  extractThreadPlanBlocks,
  type WorkbenchThreadContextPiece,
} from "./thread-context-projection.ts";

const SEARCH_SNIPPET_CHARACTERS = 500;

export interface WorkbenchThreadRecallRecord {
  kind: WorkbenchThreadRecallKind;
  label: string;
  ref: string;
  sequence: number;
  sortKey: string;
  text: string;
  turnId: string;
}

export interface WorkbenchThreadRecallMatch {
  record: WorkbenchThreadRecallRecord;
  snippet: string;
}

export interface WorkbenchThreadRecallSearchResult {
  kinds: WorkbenchThreadRecallKind[];
  matches: WorkbenchThreadRecallMatch[];
  query: string;
  totalMatches: number;
}

export interface WorkbenchThreadRecallExpansion {
  records: WorkbenchThreadRecallRecord[];
  targetRef: string;
}

function contextPieceKind(piece: WorkbenchThreadContextPiece): WorkbenchThreadRecallKind {
  switch (piece.kind) {
    case "userMessage":
      return "user";
    case "userSteer":
      return "steer";
    case "questionnaire":
      return "questionnaire";
    case "planBlock":
      return "plan";
  }
}

function contextPieceLabel(piece: WorkbenchThreadContextPiece) {
  switch (piece.kind) {
    case "userMessage":
      return "User message";
    case "userSteer":
      return "User steer";
    case "questionnaire":
      return "Questionnaire response";
    case "planBlock":
      return "Plan";
  }
}

function contextPieceRecord(piece: WorkbenchThreadContextPiece): WorkbenchThreadRecallRecord | null {
  const text = renderWorkbenchThreadContextPieceMarkdown(piece).trim();
  if (!text) {
    return null;
  }
  return {
    kind: contextPieceKind(piece),
    label: contextPieceLabel(piece),
    ref: getWorkbenchThreadContextPieceRef(piece),
    sequence: piece.sequence,
    sortKey: piece.sortKey,
    text,
    turnId: piece.turnId,
  };
}

function isPurePlanAgentMessage(item: Extract<ThreadItem, { type: "agentMessage" }>) {
  const blocks = extractThreadPlanBlocks(item.text);
  return blocks.length > 0 && item.text.trim() === blocks.join("\n\n").trim();
}

function agentMessageLabel(item: Extract<ThreadItem, { type: "agentMessage" }>) {
  switch (item.phase) {
    case "commentary":
      return "Agent commentary";
    case "final_answer":
      return "Agent final answer";
    default:
      return "Agent message";
  }
}

function pushNarrativeThreadItemRecords(
  records: WorkbenchThreadRecallRecord[],
  bundle: WorkbenchThreadContextBundle,
  sequence: { value: number },
) {
  bundle.thread.turns.forEach((turn, turnIndex) => {
    turn.items.forEach((item, itemIndex) => {
      if (item.type === "agentMessage" && item.text.trim() && !isPurePlanAgentMessage(item)) {
        records.push({
          kind: "agent",
          label: agentMessageLabel(item),
          ref: `agent:${item.id}`,
          sequence: sequence.value,
          sortKey: createWorkbenchThreadContextSortKey(turnIndex, itemIndex, 20, sequence.value),
          text: item.text.trim(),
          turnId: turn.id,
        });
        sequence.value += 1;
      }
      if (item.type === "plan" && item.text.trim()) {
        records.push({
          kind: "plan",
          label: "Plan",
          ref: `plan:${item.id}`,
          sequence: sequence.value,
          sortKey: createWorkbenchThreadContextSortKey(turnIndex, itemIndex, 20, sequence.value),
          text: item.text.trim(),
          turnId: turn.id,
        });
        sequence.value += 1;
      }
    });
  });
}

export function buildWorkbenchThreadRecallRecords(bundle: WorkbenchThreadContextBundle): WorkbenchThreadRecallRecord[] {
  const records = buildWorkbenchThreadContextPieces(bundle)
    .map(contextPieceRecord)
    .filter((record): record is WorkbenchThreadRecallRecord => record !== null);
  const sequence = { value: records.length };
  pushNarrativeThreadItemRecords(records, bundle, sequence);
  records.sort((left, right) => left.sortKey.localeCompare(right.sortKey) || left.sequence - right.sequence);

  const seenRefs = new Set<string>();
  for (const record of records) {
    if (seenRefs.has(record.ref)) {
      throw new Error(`Duplicate Thread Recall ref: ${record.ref}`);
    }
    seenRefs.add(record.ref);
  }
  return records;
}

function normalizeSearchText(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function createSnippet(value: string, query: string) {
  const normalized = normalizeSearchText(value);
  const matchIndex = normalized.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (matchIndex < 0 || normalized.length <= SEARCH_SNIPPET_CHARACTERS) {
    return normalized;
  }
  const half = Math.floor(SEARCH_SNIPPET_CHARACTERS / 2);
  const start = Math.max(0, Math.min(matchIndex - half, normalized.length - SEARCH_SNIPPET_CHARACTERS));
  const end = Math.min(normalized.length, start + SEARCH_SNIPPET_CHARACTERS);
  return `${start ? "…" : ""}${normalized.slice(start, end)}${end < normalized.length ? "…" : ""}`;
}

export function searchWorkbenchThreadRecall(
  records: readonly WorkbenchThreadRecallRecord[],
  {
    kinds,
    limit,
    query,
  }: {
    kinds: readonly WorkbenchThreadRecallKind[];
    limit: number;
    query: string;
  },
): WorkbenchThreadRecallSearchResult {
  const normalizedQuery = normalizeSearchText(query);
  const kindSet = new Set(kinds);
  const matchingRecords = records.filter((record) => (
    kindSet.has(record.kind)
    && normalizeSearchText(record.text).toLocaleLowerCase().includes(normalizedQuery.toLocaleLowerCase())
  ));
  const matches = [...matchingRecords].reverse().slice(0, limit).map((record) => ({
    record,
    snippet: createSnippet(record.text, normalizedQuery),
  }));
  return {
    kinds: [...kinds],
    matches,
    query: normalizedQuery,
    totalMatches: matchingRecords.length,
  };
}

export function expandWorkbenchThreadRecall(
  records: readonly WorkbenchThreadRecallRecord[],
  {
    after,
    before,
    ref,
  }: {
    after: number;
    before: number;
    ref: string;
  },
): WorkbenchThreadRecallExpansion {
  const targetIndex = records.findIndex((record) => record.ref === ref);
  if (targetIndex < 0) {
    throw new Error(`Unknown Thread Recall ref: ${ref}`);
  }
  return {
    records: records.slice(Math.max(0, targetIndex - before), targetIndex + after + 1),
    targetRef: ref,
  };
}
