/*
 * Keywords: thread recall, narrative, native attribution, SQLite, stable refs.
 * Exports:
 * - WorkbenchThreadRecallRecord/WorkbenchThreadRecallMatch/WorkbenchThreadRecallSearchResult/WorkbenchThreadRecallExpansion/WorkbenchThreadRecallCursor/SqliteWorkbenchThreadRecallRef: recall projection, paging, cursor, and SQLite ref contracts. Keywords: thread recall, search, expansion, cursor, SQLite.
 * - buildWorkbenchThreadRecallRecords/buildSqliteWorkbenchThreadRecallRecords/selectWorkbenchThreadRecallRecords: project and filter ordered narrative records without embedded-plan duplication. Keywords: recall, narrative, kinds, plan, SQLite.
 * - searchWorkbenchThreadRecall/expandWorkbenchThreadRecall: page search matches and resolve one record-content page target. Keywords: search, pagination, cursor.
 * - createWorkbenchThreadRecallCursor/readWorkbenchThreadRecallCursor: encode and decode stable record-offset cursors. Keywords: cursor, offset, stable.
 * - createSqliteWorkbenchThreadRecallRef/readSqliteWorkbenchThreadRecallRef: encode and decode turn-owning SQLite record refs. Keywords: SQLite, ref, turn.
 */

import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type {
  WorkbenchQuestionnaireHistoryEntry,
  WorkbenchThreadContextBundle,
  WorkbenchThreadRecallKind,
} from "workbench-shared/types";
import type { WorkbenchTranscriptSnapshot } from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import {
  projectWorkbenchTranscriptItems,
  type WorkbenchProjectedInteractionItem,
} from "workbench-shared/workbench/database/transcript/workbench-transcript-item-projection";
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
import { readWorkbenchAgentMessageInput, readWorkbenchAgentMessageItem } from "workbench-shared/workbench/thread/thread-agent-message";
import { isAgentScreenshotSteerUserMessage } from "workbench-shared/workbench/thread/thread-steer-markers";
import { unwrapWorkbenchSteerDisplayInput } from "workbench-shared/workbench/thread/thread-steer-display";
import { isWorkbenchHiddenSystemSteerInput } from "workbench-shared/workbench/thread/thread-recovery-message";

const SEARCH_SNIPPET_CHARACTERS = 500;
const CURSOR_PREFIX = "recall-v1:";
const SQLITE_REF_PREFIX = "sqlite-recall-v1:";

export interface SqliteWorkbenchThreadRecallRef {
  blockIndex: number | null;
  itemId: string;
  turnId: string;
}

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

export function createSqliteWorkbenchThreadRecallRef({
  blockIndex = null,
  itemId,
  turnId,
}: {
  blockIndex?: number | null;
  itemId: string;
  turnId: string;
}) {
  return `${SQLITE_REF_PREFIX}${Buffer.from(JSON.stringify([turnId, itemId, blockIndex]), "utf8").toString("base64url")}`;
}

export function readSqliteWorkbenchThreadRecallRef(value: string): SqliteWorkbenchThreadRecallRef | null {
  if (!value.startsWith(SQLITE_REF_PREFIX)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(SQLITE_REF_PREFIX.length), "base64url").toString("utf8")) as unknown;
    if (
      !Array.isArray(parsed)
      || parsed.length !== 3
      || typeof parsed[0] !== "string"
      || !parsed[0]
      || typeof parsed[1] !== "string"
      || !parsed[1]
      || (parsed[2] !== null && (!Number.isSafeInteger(parsed[2]) || (parsed[2] as number) < 0))
    ) {
      return null;
    }
    return {
      blockIndex: parsed[2] as number | null,
      itemId: parsed[1],
      turnId: parsed[0],
    };
  } catch {
    return null;
  }
}

function stripOuterPlanTag(value: string) {
  const normalized = value.trim();
  const match = /^<plan>\s*\n?([\s\S]*?)\n?\s*<\/plan>$/iu.exec(normalized);
  return match?.[1]?.trim() ?? normalized;
}

function contextPieceKind(piece: WorkbenchThreadContextPiece): WorkbenchThreadRecallKind {
  switch (piece.kind) {
    case "agentMessage":
      return "agent-message";
    case "userMessage":
      if (readWorkbenchAgentMessageInput(piece.input)) return "agent-message";
      return "user-message";
    case "userSteer":
      if (readWorkbenchAgentMessageInput(piece.input)) return "agent-message";
      return "user-steer";
    case "questionnaire":
      return "questionnaire";
    case "planBlock":
      return "plan";
  }
}

function contextPieceLabel(piece: WorkbenchThreadContextPiece) {
  if (piece.kind === "userMessage" || piece.kind === "userSteer") {
    const agentMessage = readWorkbenchAgentMessageInput(piece.input);
    if (agentMessage) return `Agent message from ${agentMessage.senderName}`;
  }
  switch (piece.kind) {
    case "agentMessage":
      return `Agent message from ${piece.message.senderName}`;
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

function projectedInteractionPiece(
  item: WorkbenchProjectedInteractionItem,
  root: WorkbenchTranscriptSnapshot["rows"]["threadItems"][number],
  sortKey: string,
  sequence: number,
): Extract<WorkbenchThreadContextPiece, { kind: "questionnaire" }> {
  const entry: WorkbenchQuestionnaireHistoryEntry = {
    insertAfterItemId: null,
    insertAfterItemIndex: root.item_position,
    itemId: item.id,
    request: item.request,
    requestKey: item.requestKey,
    resolvedAt: item.resolvedAt,
    response: item.response,
    threadId: root.thread_id,
    turnId: root.turn_id,
  };
  return {
    entry,
    itemId: item.id,
    kind: "questionnaire",
    sequence,
    sortKey,
    turnId: root.turn_id,
  };
}

function sqliteRecord({
  blockIndex,
  itemId,
  kind,
  label,
  parentRef = null,
  sequence,
  sortKey,
  text,
  turnId,
}: {
  blockIndex?: number | null;
  itemId: string;
  kind: WorkbenchThreadRecallKind;
  label: string;
  parentRef?: string | null;
  sequence: number;
  sortKey: string;
  text: string;
  turnId: string;
}): WorkbenchThreadRecallRecord | null {
  const normalizedText = kind === "plan" ? stripOuterPlanTag(text) : text.trim();
  if (!normalizedText) return null;
  return {
    kind,
    label,
    parentRef,
    ref: createSqliteWorkbenchThreadRecallRef({ blockIndex, itemId, turnId }),
    sequence,
    sortKey,
    text: normalizedText,
    turnId,
  };
}

export function buildSqliteWorkbenchThreadRecallRecords(
  snapshot: WorkbenchTranscriptSnapshot,
): WorkbenchThreadRecallRecord[] {
  const projection = projectWorkbenchTranscriptItems(snapshot.rows);
  if ("issues" in projection) {
    const issue = projection.issues[0];
    throw new Error(`Unable to project SQLite Thread Recall: ${issue?.code ?? "unknown"} in ${issue?.table ?? "rows"}.`);
  }
  const turnIndexes = new Map(snapshot.turns.map((turn) => [turn.id, turn.turn_index]));
  const userMessageRowsByItemId = new Map(
    snapshot.rows.threadItemUserMessages.map((row) => [row.item_id, row]),
  );
  const projectedUserMessages = projection.data.filter((row) => row.item.type === "userMessage");
  const firstVisibleUserMessageByTurn = new Map<string, string>();
  for (const { item, root } of projectedUserMessages) {
    if (
      item.type !== "userMessage"
      || isAgentScreenshotSteerUserMessage(item)
      || isWorkbenchHiddenSystemSteerInput(item.content)
      || readWorkbenchAgentMessageInput(item.content)
      || unwrapWorkbenchSteerDisplayInput(item.content).length === 0
    ) {
      continue;
    }
    if (!firstVisibleUserMessageByTurn.has(root.turn_id)) {
      firstVisibleUserMessageByTurn.set(root.turn_id, item.id);
    }
  }

  const records: WorkbenchThreadRecallRecord[] = [];
  let sequence = 0;
  for (const { item, root } of projection.data) {
    const turnIndex = turnIndexes.get(root.turn_id);
    if (turnIndex === undefined) {
      throw new Error(`SQLite Thread Recall item ${root.source_id} references an unknown turn.`);
    }
    const sortKey = createWorkbenchThreadContextSortKey(
      turnIndex,
      root.item_position,
      20,
      sequence,
    );
    if (item.type === "userMessage") {
      if (
        isAgentScreenshotSteerUserMessage(item)
        || isWorkbenchHiddenSystemSteerInput(item.content)
      ) {
        continue;
      }
      const displayInput = unwrapWorkbenchSteerDisplayInput(item.content);
      if (!displayInput.length) continue;
      const agentMessage = readWorkbenchAgentMessageInput(item.content);
      const owner = userMessageRowsByItemId.get(root.id);
      if (!owner) {
        throw new Error(`SQLite Thread Recall user message ${item.id} has no durable payload row.`);
      }
      const isSteer = owner.input_kind === "steer"
        || firstVisibleUserMessageByTurn.get(root.turn_id) !== item.id;
      const piece: WorkbenchThreadContextPiece = isSteer
        ? {
          displayInput,
          entry: {
            attemptedAt: root.created_at,
            canonicalItemId: item.id,
            clientUserMessageId: item.clientId,
            entryKey: item.id,
            error: owner.error_text,
            input: item.content,
            requestId: item.id,
            resolvedAt: root.updated_at,
            status: owner.delivery_state === "delivered"
              ? "sent"
              : owner.delivery_state,
            threadId: root.thread_id,
            turnId: root.turn_id,
          },
          input: item.content,
          itemId: item.id,
          kind: "userSteer",
          sequence,
          sortKey,
          turnId: root.turn_id,
        }
        : {
          displayInput,
          input: item.content,
          itemId: item.id,
          kind: "userMessage",
          sequence,
          sortKey,
          turnId: root.turn_id,
        };
      const record = sqliteRecord({
        itemId: item.id,
        kind: agentMessage ? "agent-message" : isSteer ? "user-steer" : "user-message",
        label: agentMessage ? `Agent message from ${agentMessage.senderName}` : isSteer ? "User steer" : "User message",
        sequence,
        sortKey,
        text: renderWorkbenchThreadContextPieceMarkdown(piece),
        turnId: root.turn_id,
      });
      if (record) records.push(record);
      sequence += 1;
      continue;
    }
    if (item.type === "functionCallOutput") {
      const message = readWorkbenchAgentMessageItem(item);
      if (!message) continue;
      const piece: WorkbenchThreadContextPiece = {
        itemId: item.id, kind: "agentMessage", message, sequence, sortKey, turnId: root.turn_id,
      };
      const record = sqliteRecord({
        itemId: item.id,
        kind: contextPieceKind(piece),
        label: contextPieceLabel(piece),
        sequence,
        sortKey,
        text: renderWorkbenchThreadContextPieceMarkdown(piece),
        turnId: root.turn_id,
      });
      if (record) records.push(record);
      sequence += 1;
      continue;
    }
    if (item.type === "questionnaire" || item.type === "approval") {
      const piece = projectedInteractionPiece(item, root, sortKey, sequence);
      const record = sqliteRecord({
        itemId: item.id,
        kind: "questionnaire",
        label: "Questionnaire response",
        sequence,
        sortKey,
        text: renderWorkbenchThreadContextPieceMarkdown(piece),
        turnId: root.turn_id,
      });
      if (record) records.push(record);
      sequence += 1;
      continue;
    }
    if (item.type === "agentMessage" && item.text.trim()) {
      const parentRef = createSqliteWorkbenchThreadRecallRef({ itemId: item.id, turnId: root.turn_id });
      const record = sqliteRecord({
        itemId: item.id,
        kind: agentMessageKind(item),
        label: agentMessageLabel(item),
        sequence,
        sortKey,
        text: item.text,
        turnId: root.turn_id,
      });
      if (record) records.push(record);
      sequence += 1;
      extractThreadPlanBlocks(item.text).forEach((planMarkdown, blockIndex) => {
        const planRecord = sqliteRecord({
          blockIndex,
          itemId: item.id,
          kind: "plan",
          label: "Plan",
          parentRef,
          sequence,
          sortKey: createWorkbenchThreadContextSortKey(
            turnIndex,
            root.item_position,
            20,
            blockIndex,
          ),
          text: planMarkdown,
          turnId: root.turn_id,
        });
        if (planRecord) records.push(planRecord);
        sequence += 1;
      });
      continue;
    }
    if (item.type === "plan" && item.text.trim()) {
      const record = sqliteRecord({
        itemId: item.id,
        kind: "plan",
        label: "Plan",
        sequence,
        sortKey,
        text: item.text,
        turnId: root.turn_id,
      });
      if (record) records.push(record);
      sequence += 1;
    }
  }
  records.sort((left, right) => left.sortKey.localeCompare(right.sortKey) || left.sequence - right.sequence);
  const refs = new Set<string>();
  for (const record of records) {
    if (refs.has(record.ref)) throw new Error(`Duplicate Thread Recall ref: ${record.ref}`);
    refs.add(record.ref);
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
