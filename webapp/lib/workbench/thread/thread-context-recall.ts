/*
 * Exports:
 * - WorkbenchThreadRecallRecord/WorkbenchThreadRecallSearchResult/WorkbenchThreadRecallExpansion: recall projection and paging contracts. Keywords: thread recall, search, expansion.
 * - buildWorkbenchThreadRecallRecords/selectWorkbenchThreadRecallRecords: project and filter ordered narrative records without embedded-plan duplication. Keywords: recall, narrative, kinds, plan.
 * - searchWorkbenchThreadRecall/expandWorkbenchThreadRecall: page search matches and resolve one record-content page target. Keywords: search, pagination, cursor.
 * - createWorkbenchThreadRecallCursor/readWorkbenchThreadRecallCursor: encode and decode stable record-offset cursors. Keywords: cursor, offset, stable.
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
  type WorkbenchThreadContextPiece,
} from "./thread-context-projection.ts";
import { readWorkbenchSubagentMessageInput } from "./thread-subagent-message.ts";

const SEARCH_SNIPPET_CHARACTERS = 500;
const CURSOR_PREFIX = "recall-v1:";

export interface WorkbenchThreadRecallRecord {
  kind: WorkbenchThreadRecallKind;
  label: string;
  parentRef: string | null;
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
  before: string | null;
  hasOlderMatches: boolean;
  kinds: WorkbenchThreadRecallKind[];
  limit: number;
  matches: WorkbenchThreadRecallMatch[];
  query: string;
  totalMatches: number;
}

export interface WorkbenchThreadRecallExpansion {
  cursor: number;
  record: WorkbenchThreadRecallRecord;
}

export interface WorkbenchThreadRecallCursor {
  offset: number;
  ref: string;
}

function stripOuterPlanTag(value: string) {
  const normalized = value.trim();
  const match = /^<plan>\s*\n?([\s\S]*?)\n?\s*<\/plan>$/iu.exec(normalized);
  return match?.[1]?.trim() ?? normalized;
}

function contextPieceKind(piece: WorkbenchThreadContextPiece): WorkbenchThreadRecallKind {
  switch (piece.kind) {
    case "userMessage":
      return "user-message";
    case "userSteer":
      return "user-steer";
    case "questionnaire":
      return "questionnaire";
    case "planBlock":
      return "plan";
  }
}

function contextPieceLabel(piece: WorkbenchThreadContextPiece) {
  if (piece.kind === "userMessage" || piece.kind === "userSteer") {
    const subagentMessage = readWorkbenchSubagentMessageInput(piece.input);
    if (subagentMessage) return `Subagent message from ${subagentMessage.name}`;
  }
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

function agentMessageKind(item: Extract<ThreadItem, { type: "agentMessage" }>): WorkbenchThreadRecallKind {
  switch (item.phase) {
    case "commentary":
      return "commentary";
    case "final_answer":
      return "final-answer";
    default:
      return "agent-message";
  }
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

function contextPieceRecord(piece: WorkbenchThreadContextPiece): WorkbenchThreadRecallRecord | null {
  const renderedText = renderWorkbenchThreadContextPieceMarkdown(piece).trim();
  const text = piece.kind === "planBlock" ? stripOuterPlanTag(renderedText) : renderedText;
  if (!text) {
    return null;
  }
  return {
    kind: contextPieceKind(piece),
    label: contextPieceLabel(piece),
    parentRef: piece.kind === "planBlock" ? `agent:${piece.itemId}` : null,
    ref: getWorkbenchThreadContextPieceRef(piece),
    sequence: piece.sequence,
    sortKey: piece.sortKey,
    text,
    turnId: piece.turnId,
  };
}

function pushNarrativeThreadItemRecords(
  records: WorkbenchThreadRecallRecord[],
  bundle: WorkbenchThreadContextBundle,
  sequence: { value: number },
) {
  bundle.thread.turns.forEach((turn, turnIndex) => {
    turn.items.forEach((item, itemIndex) => {
      if (item.type === "agentMessage" && item.text.trim()) {
        records.push({
          kind: agentMessageKind(item),
          label: agentMessageLabel(item),
          parentRef: null,
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
          parentRef: null,
          ref: `plan:${item.id}`,
          sequence: sequence.value,
          sortKey: createWorkbenchThreadContextSortKey(turnIndex, itemIndex, 20, sequence.value),
          text: stripOuterPlanTag(item.text),
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

export function selectWorkbenchThreadRecallRecords(
  records: readonly WorkbenchThreadRecallRecord[],
  kinds: readonly WorkbenchThreadRecallKind[],
) {
  const kindSet = new Set(kinds);
  const selectedParentRefs = new Set(records
    .filter((record) => kindSet.has(record.kind) && record.kind !== "plan")
    .map((record) => record.ref));
  return records.filter((record) => (
    kindSet.has(record.kind)
    && !(record.kind === "plan" && record.parentRef && selectedParentRefs.has(record.parentRef))
  ));
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
    before,
    kinds,
    limit,
    query,
  }: {
    before: string | null;
    kinds: readonly WorkbenchThreadRecallKind[];
    limit: number;
    query: string;
  },
): WorkbenchThreadRecallSearchResult {
  const normalizedQuery = normalizeSearchText(query);
  const matchingRecords = selectWorkbenchThreadRecallRecords(records, kinds).filter((record) => (
    normalizeSearchText(record.text).toLocaleLowerCase().includes(normalizedQuery.toLocaleLowerCase())
  ));
  const endExclusive = before === null
    ? matchingRecords.length
    : matchingRecords.findIndex((record) => record.ref === before);
  if (endExclusive < 0) {
    throw new Error(`Unknown Thread Recall search ref: ${before}`);
  }
  const startIndex = Math.max(0, endExclusive - limit);
  const matches = matchingRecords.slice(startIndex, endExclusive).reverse().map((record) => ({
    record,
    snippet: createSnippet(record.text, normalizedQuery),
  }));
  return {
    before,
    hasOlderMatches: startIndex > 0,
    kinds: [...kinds],
    limit,
    matches,
    query: normalizedQuery,
    totalMatches: matchingRecords.length,
  };
}

export function createWorkbenchThreadRecallCursor(ref: string, offset: number) {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("Thread Recall cursor offset must be a non-negative integer.");
  }
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify({ offset, ref }), "utf8").toString("base64url")}`;
}

export function readWorkbenchThreadRecallCursor(value: string): WorkbenchThreadRecallCursor | null {
  if (!value.startsWith(CURSOR_PREFIX)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(CURSOR_PREFIX.length), "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.ref !== "string" || !record.ref || !Number.isSafeInteger(record.offset) || (record.offset as number) < 0) {
      return null;
    }
    return { offset: record.offset as number, ref: record.ref };
  } catch {
    return null;
  }
}

export function expandWorkbenchThreadRecall(
  records: readonly WorkbenchThreadRecallRecord[],
  {
    cursor,
    ref,
  }: {
    cursor: string | null;
    ref: string;
  },
): WorkbenchThreadRecallExpansion {
  const record = records.find((candidate) => candidate.ref === ref);
  if (!record) {
    throw new Error(`Unknown Thread Recall ref: ${ref}`);
  }
  const decodedCursor = cursor ? readWorkbenchThreadRecallCursor(cursor) : null;
  if (cursor && (!decodedCursor || decodedCursor.ref !== ref)) {
    throw new Error("Thread Recall expansion cursor does not belong to the requested ref.");
  }
  const offset = decodedCursor?.offset ?? 0;
  if (offset > record.text.length) {
    throw new Error("Thread Recall expansion cursor is beyond the end of the requested record.");
  }
  return { cursor: offset, record };
}
