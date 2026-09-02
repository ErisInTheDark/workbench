/*
 * WorkbenchTranscriptComparisonItem/WorkbenchTranscriptComparisonRow: renderer-ready JSON and SQLite item alignment values. Keywords: transcript, comparison, item, identity.
 * WorkbenchTranscriptParityResult: exact semantic equality result or one bounded diagnostic safe for orchestrator logs. Keywords: transcript, parity, diagnostic.
 * compareWorkbenchTranscriptParity: compare the JSON renderer oracle with the relational projection at turn, display, item, timeline, and Browse boundaries. Keywords: transcript, SQLite, equality, browser.
 * createWorkbenchTranscriptProjectionFailureDiagnostic: describe a fail-closed relational projection without exposing row values. Keywords: transcript, projection, failure.
 * planWorkbenchTranscriptItemComparison: align renderer-ready JSON and SQLite items by canonical identity without hiding inserts or reorders. Keywords: transcript, comparison, alignment.
 */
import type { ThreadItem } from "../../codex/generated/app-server/v2/ThreadItem";
import type { ThreadPayload, WorkbenchBrowseResultEntry } from "../../types";
import type {
  WorkbenchTranscriptParityContextEntry,
  WorkbenchTranscriptParityDiagnostic,
  WorkbenchTranscriptParityMismatch,
  WorkbenchTranscriptParityScope,
} from "../database/transcript/workbench-transcript-contract";
import { areDeeplyEqual } from "../deep-equality";
import {
  readSyntheticQuestionnaireHistoryItemId,
} from "../thread/thread-questionnaire-identity";
import type { WorkbenchFileChangeItem } from "../thread/workbench-file-change";
import {
  planCanonicalTranscriptDisplay,
  type CanonicalTranscriptDisplayPlan,
} from "./thread-transcript-display-planner";
import type {
  WorkbenchProjectedInteractionItem,
  WorkbenchProjectedTranscriptItem,
  WorkbenchProjectedUnknownItem,
  WorkbenchTranscriptProjection,
  WorkbenchTranscriptProjectionIssue,
} from "./workbench-transcript-projection";

interface SemanticItem {
  id: string;
  payload: unknown;
  type: string;
}

interface ComparedEntry extends WorkbenchTranscriptParityContextEntry {
  payload: unknown;
}

export interface WorkbenchTranscriptComparisonItem {
  identity: string;
  item: WorkbenchProjectedTranscriptItem;
  sourceItemId: string;
  turnId: string;
  type: string;
}

export interface WorkbenchTranscriptComparisonRow {
  json: WorkbenchTranscriptComparisonItem | null;
  sqlite: WorkbenchTranscriptComparisonItem | null;
}

export type WorkbenchTranscriptParityResult =
  | { equal: true }
  | { diagnostic: WorkbenchTranscriptParityDiagnostic; equal: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableSerialize(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function payloadSignature(value: unknown) {
  const serialized = stableSerialize(value);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${serialized.length}:${(first >>> 0).toString(36)}:${(second >>> 0).toString(36)}`;
}

function normalizeUserContent(item: Extract<ThreadItem, { type: "userMessage" }>) {
  return item.content.map((part) => {
    if (part.type === "text") return { text: part.text, type: part.type };
    if (part.type === "image") return { detail: part.detail ?? null, type: part.type, url: part.url };
    if (part.type === "localImage") return { detail: part.detail ?? null, path: part.path, type: part.type };
    if (part.type === "skill" || part.type === "mention") return { name: part.name, path: part.path, type: part.type };
    return part;
  });
}

function normalizeFileChange(item: Extract<ThreadItem, { type: "fileChange" }> | WorkbenchFileChangeItem) {
  const workbenchItem = item as WorkbenchFileChangeItem;
  return {
    changes: workbenchItem.changes.map((change) => ({
      diff: change.diff,
      kind: change.kind.type === "update"
        ? { movePath: change.kind.move_path ?? null, type: change.kind.type }
        : { type: change.kind.type },
      path: change.path,
      workbenchAdditions: change.workbenchAdditions ?? null,
      workbenchDeletions: change.workbenchDeletions ?? null,
    })),
    status: item.status,
    workbenchFailureKind: workbenchItem.workbenchFailureKind ?? null,
  };
}

function normalizeSupportedItem(item: ThreadItem | WorkbenchFileChangeItem): SemanticItem | null {
  switch (item.type) {
    case "userMessage":
      return { id: item.id, payload: { clientId: item.clientId ?? null, content: normalizeUserContent(item) }, type: item.type };
    case "agentMessage":
      return { id: item.id, payload: { phase: item.phase ?? null, text: item.text }, type: item.type };
    case "reasoning":
      return {
        id: item.id,
        payload: { sections: item.summary.some((section) => section.trim()) ? item.summary : item.content },
        type: item.type,
      };
    case "plan":
      return { id: item.id, payload: { text: item.text }, type: item.type };
    case "commandExecution":
      return {
        id: item.id,
        payload: {
          aggregatedOutput: item.aggregatedOutput ?? null,
          command: item.command,
          commandActions: item.commandActions,
          cwd: item.cwd,
          durationMs: item.durationMs ?? null,
          exitCode: item.exitCode ?? null,
          pluginId: item.pluginId ?? null,
          processId: item.processId ?? null,
          scriptPath: item.scriptPath ?? null,
          status: item.status,
        },
        type: item.type,
      };
    case "fileChange":
      return { id: item.id, payload: normalizeFileChange(item), type: item.type };
    case "mcpToolCall":
      return {
        id: item.id,
        payload: {
          appContext: item.appContext ?? null,
          arguments: item.arguments,
          durationMs: item.durationMs ?? null,
          error: item.error ?? null,
          mcpAppResourceUri: item.mcpAppResourceUri ?? null,
          pluginId: item.pluginId ?? null,
          readOnlyHint: item.readOnlyHint ?? null,
          result: item.result ?? null,
          server: item.server,
          status: item.status,
          tool: item.tool,
        },
        type: item.type,
      };
    case "dynamicToolCall":
      return {
        id: item.id,
        payload: {
          arguments: item.arguments,
          contentItems: item.contentItems ?? null,
          durationMs: item.durationMs ?? null,
          namespace: item.namespace ?? null,
          status: item.status,
          success: item.success ?? null,
          tool: item.tool,
        },
        type: item.type,
      };
    case "collabAgentToolCall":
      return {
        id: item.id,
        payload: {
          agentsStates: item.agentsStates,
          model: item.model ?? null,
          prompt: item.prompt ?? null,
          reasoningEffort: item.reasoningEffort ?? null,
          receiverThreadIds: item.receiverThreadIds,
          senderThreadId: item.senderThreadId,
          status: item.status,
          tool: item.tool,
        },
        type: item.type,
      };
    case "webSearch":
      return {
        id: item.id,
        payload: { action: item.action ?? null, query: item.query, results: item.results ?? null },
        type: item.type,
      };
    case "contextCompaction":
      return { id: item.id, payload: {}, type: item.type };
    case "hookPrompt":
    case "subAgentActivity":
    case "imageView":
    case "sleep":
    case "imageGeneration":
    case "enteredReviewMode":
    case "exitedReviewMode":
      return null;
  }
}

function parseQuestionnaireResponse(item: Extract<ThreadItem, { type: "dynamicToolCall" }>) {
  const content = item.contentItems?.length === 1 ? item.contentItems[0] : null;
  if (content?.type !== "inputText") return null;
  try {
    return JSON.parse(content.text) as unknown;
  } catch {
    return { invalidResponseText: content.text };
  }
}

function normalizeJsonItem(item: ThreadItem): SemanticItem {
  const questionnaireItemId = item.type === "dynamicToolCall"
    ? readSyntheticQuestionnaireHistoryItemId(item.id)
    : null;
  if (item.type === "dynamicToolCall" && questionnaireItemId) {
    const approval = isRecord(item.arguments) && item.arguments.approval !== undefined;
    return {
      id: questionnaireItemId,
      payload: {
        errorText: null,
        request: item.arguments,
        response: parseQuestionnaireResponse(item),
        state: "answered",
      },
      type: approval ? "approval" : "questionnaire",
    };
  }
  const supported = normalizeSupportedItem(item);
  return supported ?? {
    id: item.id,
    payload: { nativeType: item.type, safeValue: item },
    type: "unknown",
  };
}

function normalizeInteraction(item: WorkbenchProjectedInteractionItem): SemanticItem {
  return {
    id: item.id,
    payload: {
      errorText: item.errorText,
      request: item.request,
      response: item.response,
      state: item.state,
    },
    type: item.type,
  };
}

function normalizeUnknown(item: WorkbenchProjectedUnknownItem): SemanticItem {
  return {
    id: item.id,
    payload: { nativeType: item.nativeType, safeValue: item.safeValue },
    type: item.type,
  };
}

function isProjectedInteraction(item: WorkbenchProjectedTranscriptItem): item is WorkbenchProjectedInteractionItem {
  return item.type === "questionnaire" || item.type === "approval";
}

function normalizeProjectedItem(item: WorkbenchProjectedTranscriptItem): SemanticItem {
  if (isProjectedInteraction(item)) return normalizeInteraction(item);
  if (item.type === "unknown") return normalizeUnknown(item);
  return normalizeSupportedItem(item) ?? {
    id: item.id,
    payload: { nativeType: item.type, safeValue: item },
    type: "unknown",
  };
}

function contextEntry(
  entry: Omit<WorkbenchTranscriptParityContextEntry, "payloadSignature"> & { payload: unknown },
): ComparedEntry {
  return { ...entry, payloadSignature: payloadSignature(entry.payload) };
}

function jsonDisplay(thread: ThreadPayload) {
  const turnOrder = new Map(thread.turnHistory.map((entry, index) => [entry.turnId, index]));
  const turns = [...thread.turns].sort((left, right) => (
    (turnOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (turnOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER)
  ));
  let itemIndex = 0;
  const semanticByOriginalId = new Map<string, SemanticItem>();
  const items = turns.flatMap((turn) => turn.items.map((item) => {
    const semantic = normalizeJsonItem(item);
    semanticByOriginalId.set(item.id, semantic);
    return { itemId: semantic.id, itemIndex: itemIndex++, payload: semantic, turnId: turn.id };
  }));
  return {
    display: planCanonicalTranscriptDisplay({
      items,
      turns: turns.map((turn, turnIndex) => ({ turnId: turn.id, turnIndex })),
    }),
    semanticByOriginalId,
    turns,
  };
}

function projectedDisplay(projection: WorkbenchTranscriptProjection) {
  const semanticByOriginalId = new Map<string, SemanticItem>();
  const items = projection.display.orderedItems.map((entry) => {
    const semantic = normalizeProjectedItem(entry.payload);
    semanticByOriginalId.set(entry.payload.id, semantic);
    return { ...entry, itemId: semantic.id, payload: semantic };
  });
  const virtualTail = projection.display.segments
    .filter(({ kind }) => kind === "virtual")
    .flatMap((segment) => segment.items.map((item) => ({ payload: normalizeProjectedItem(item), turnId: segment.turnId })));
  return {
    display: planCanonicalTranscriptDisplay({
      items,
      turns: projection.turns.map(({ id, turnIndex }) => ({ turnId: id, turnIndex })),
      virtualTail,
    }),
    semanticByOriginalId,
  };
}

function jsonComparisonItems(
  thread: ThreadPayload,
  visibleTurnIds?: ReadonlySet<string>,
): WorkbenchTranscriptComparisonItem[] {
  const turnOrder = new Map(thread.turnHistory.map((entry, index) => [entry.turnId, index]));
  return [...thread.turns]
    .filter((turn) => !visibleTurnIds || visibleTurnIds.has(turn.id))
    .sort((left, right) => (
      (turnOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (turnOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    ))
    .flatMap((turn) => turn.items.map((item) => {
      const semantic = normalizeJsonItem(item);
      return {
        identity: semantic.id,
        item,
        sourceItemId: item.id,
        turnId: turn.id,
        type: semantic.type,
      };
    }));
}

function sqliteComparisonItems(
  projection: WorkbenchTranscriptProjection,
  visibleTurnIds?: ReadonlySet<string>,
): WorkbenchTranscriptComparisonItem[] {
  return projection.display.segments
    .filter((segment) => !visibleTurnIds || visibleTurnIds.has(segment.turnId))
    .flatMap((segment) => segment.items.map((item) => {
      const semantic = normalizeProjectedItem(item);
      return {
        identity: semantic.id,
        item,
        sourceItemId: item.id,
        turnId: segment.turnId,
        type: semantic.type,
      };
    }));
}

export function planWorkbenchTranscriptItemComparison({
  jsonThread,
  sqliteProjection,
  visibleTurnIds,
}: {
  jsonThread: ThreadPayload;
  sqliteProjection: WorkbenchTranscriptProjection;
  visibleTurnIds?: ReadonlySet<string>;
}): WorkbenchTranscriptComparisonRow[] {
  const jsonItems = jsonComparisonItems(jsonThread, visibleTurnIds);
  const sqliteItems = sqliteComparisonItems(sqliteProjection, visibleTurnIds);
  const sqliteIndexesByIdentity = new Map(sqliteItems.map((item, index) => [item.identity, index]));
  const rows: WorkbenchTranscriptComparisonRow[] = [];
  let sqliteIndex = 0;

  for (const json of jsonItems) {
    const matchingSqliteIndex = sqliteIndexesByIdentity.get(json.identity);
    if (matchingSqliteIndex === undefined || matchingSqliteIndex < sqliteIndex) {
      rows.push({ json, sqlite: null });
      continue;
    }

    while (sqliteIndex < matchingSqliteIndex) {
      rows.push({ json: null, sqlite: sqliteItems[sqliteIndex] ?? null });
      sqliteIndex += 1;
    }

    rows.push({ json, sqlite: sqliteItems[sqliteIndex] ?? null });
    sqliteIndex += 1;
  }

  while (sqliteIndex < sqliteItems.length) {
    rows.push({ json: null, sqlite: sqliteItems[sqliteIndex] ?? null });
    sqliteIndex += 1;
  }

  return rows;
}

function itemEntries(
  display: CanonicalTranscriptDisplayPlan<SemanticItem>,
): ComparedEntry[] {
  const turnIdByItemId = new Map(display.orderedItems.map(({ itemId, turnId }) => [itemId, turnId]));
  for (const segment of display.segments) {
    if (segment.kind !== "virtual") continue;
    for (const item of segment.items) turnIdByItemId.set(item.id, segment.turnId);
  }
  return display.segments.flatMap((segment) => segment.items.map((item) => contextEntry({
    id: item.id,
    index: 0,
    kind: "item",
    payload: item.payload,
    turnId: turnIdByItemId.get(item.id) ?? segment.turnId,
    type: item.type,
  }))).map((entry, index) => ({ ...entry, index }));
}

function segmentEntries(display: CanonicalTranscriptDisplayPlan<SemanticItem>): ComparedEntry[] {
  return display.segments.map((segment, index) => contextEntry({
    id: segment.id,
    index,
    kind: "segment",
    payload: {
      isFirstForTurn: segment.isFirstForTurn,
      isLastForTurn: segment.isLastForTurn,
      itemIds: segment.items.map(({ id }) => id),
      kind: segment.kind,
      ownsCanonicalTerminal: segment.ownsCanonicalTerminal,
    },
    turnId: segment.turnId,
    type: segment.kind,
  }));
}

function turnEntriesFromJson(thread: ThreadPayload): ComparedEntry[] {
  const historyById = new Map(thread.turnHistory.map((entry) => [entry.turnId, entry]));
  return thread.turns.map((turn, index) => contextEntry({
    id: turn.id,
    index,
    kind: "turn",
    payload: {
      completedAt: turn.completedAt,
      durationMs: turn.durationMs,
      itemsView: turn.itemsView,
      startedAt: turn.startedAt,
      status: turn.status,
    },
    turnId: turn.id,
    type: historyById.get(turn.id)?.loadState ?? "loaded",
  }));
}

function turnEntriesFromProjection(projection: WorkbenchTranscriptProjection): ComparedEntry[] {
  return projection.turns.map((turn, index) => contextEntry({
    id: turn.id,
    index,
    kind: "turn",
    payload: {
      completedAt: turn.completedAt,
      durationMs: turn.durationMs,
      itemsView: turn.itemsView,
      startedAt: turn.startedAt,
      status: turn.status,
    },
    turnId: turn.id,
    type: "loaded",
  }));
}

function timelineEntriesFromJson(
  thread: ThreadPayload,
  semanticByOriginalId: ReadonlyMap<string, SemanticItem>,
): ComparedEntry[] {
  return thread.turns.flatMap((turn) => {
    const history = thread.turnHistory.find(({ turnId }) => turnId === turn.id);
    return (history?.itemTimeline ?? []).map((entry) => ({ entry, turnId: turn.id }));
  }).map(({ entry, turnId }, index) => contextEntry({
    id: semanticByOriginalId.get(entry.itemId)?.id ?? entry.itemId,
    index,
    kind: "item",
    payload: {
      aliases: entry.aliases?.map((alias) => semanticByOriginalId.get(alias)?.id ?? alias) ?? [],
      completedAt: entry.completedAt,
      firstSeenAt: entry.firstSeenAt,
      lastSeenAt: entry.lastSeenAt,
      startedAt: entry.startedAt,
    },
    turnId,
    type: "timeline",
  }));
}

function timelineEntriesFromProjection(
  projection: WorkbenchTranscriptProjection,
  semanticByOriginalId: ReadonlyMap<string, SemanticItem>,
): ComparedEntry[] {
  return projection.turns.flatMap((turn) => turn.itemTimeline.map((entry) => ({ entry, turnId: turn.id })))
    .map(({ entry, turnId }, index) => contextEntry({
      id: semanticByOriginalId.get(entry.itemId)?.id ?? entry.itemId,
      index,
      kind: "item",
      payload: {
        aliases: entry.aliases?.map((alias) => semanticByOriginalId.get(alias)?.id ?? alias) ?? [],
        completedAt: entry.completedAt,
        firstSeenAt: entry.firstSeenAt,
        lastSeenAt: entry.lastSeenAt,
        startedAt: entry.startedAt,
      },
      turnId,
      type: "timeline",
    }));
}

function browseEntries(entries: readonly WorkbenchBrowseResultEntry[]): ComparedEntry[] {
  return [...entries]
    .sort((left, right) => left.recordedAt - right.recordedAt || left.actionIndex - right.actionIndex)
    .map((entry, index) => contextEntry({
      id: entry.entryKey,
      index,
      kind: "browse",
      payload: {
        action: entry.action,
        actionIndex: entry.actionIndex,
        assetUrl: entry.assetUrl,
        commandItemId: entry.commandItemId,
        detailKind: entry.detailKind ?? null,
        detailLabel: entry.detailLabel ?? null,
        detailText: entry.detailText ?? null,
        durationMs: entry.durationMs,
        recordedAt: entry.recordedAt,
        session: entry.session,
        state: entry.state,
      },
      turnId: entry.turnId,
      type: entry.state,
    }));
}

function diagnosticContext(entries: readonly ComparedEntry[], index: number) {
  const start = Math.max(0, index - 3);
  return entries.slice(start, start + 7).map(({ payload: _payload, ...entry }) => entry);
}

function mismatchKind(jsonEntry: ComparedEntry | undefined, sqliteEntry: ComparedEntry | undefined): WorkbenchTranscriptParityMismatch {
  if (!jsonEntry) return "extra";
  if (!sqliteEntry) return "missing";
  if (jsonEntry.id !== sqliteEntry.id) return "order";
  if (jsonEntry.turnId !== sqliteEntry.turnId) return "ownership";
  if (jsonEntry.type !== sqliteEntry.type) return "type";
  return "payload";
}

function compareEntries(
  threadId: string,
  scope: WorkbenchTranscriptParityScope,
  jsonEntries: readonly ComparedEntry[],
  sqliteEntries: readonly ComparedEntry[],
): WorkbenchTranscriptParityResult {
  const length = Math.max(jsonEntries.length, sqliteEntries.length);
  for (let index = 0; index < length; index += 1) {
    const jsonEntry = jsonEntries[index];
    const sqliteEntry = sqliteEntries[index];
    if (
      jsonEntry
      && sqliteEntry
      && jsonEntry.id === sqliteEntry.id
      && jsonEntry.turnId === sqliteEntry.turnId
      && jsonEntry.type === sqliteEntry.type
      && areDeeplyEqual(jsonEntry.payload, sqliteEntry.payload)
    ) {
      continue;
    }
    return {
      equal: false,
      diagnostic: {
        jsonContext: diagnosticContext(jsonEntries, index),
        mismatch: mismatchKind(jsonEntry, sqliteEntry),
        scope,
        sqliteContext: diagnosticContext(sqliteEntries, index),
        threadId,
      },
    };
  }
  return { equal: true };
}

export function createWorkbenchTranscriptProjectionFailureDiagnostic(
  threadId: string,
  issues: readonly WorkbenchTranscriptProjectionIssue[],
): WorkbenchTranscriptParityDiagnostic {
  const first = issues[0];
  return {
    jsonContext: [],
    mismatch: "projectionFailure",
    scope: "projection",
    sqliteContext: first ? [{
      id: first.itemId ?? first.table,
      index: 0,
      kind: "item",
      payloadSignature: payloadSignature({ code: first.code, table: first.table }),
      turnId: null,
      type: first.code,
    }] : [],
    threadId,
  };
}

export function compareWorkbenchTranscriptParity({
  jsonBrowseResultEntries,
  jsonThread,
  sqliteProjection,
}: {
  jsonBrowseResultEntries: readonly WorkbenchBrowseResultEntry[];
  jsonThread: ThreadPayload;
  sqliteProjection: WorkbenchTranscriptProjection;
}): WorkbenchTranscriptParityResult {
  const json = jsonDisplay(jsonThread);
  const sqlite = projectedDisplay(sqliteProjection);
  const comparisons: Array<{
    jsonEntries: ComparedEntry[];
    scope: WorkbenchTranscriptParityScope;
    sqliteEntries: ComparedEntry[];
  }> = [
    { jsonEntries: turnEntriesFromJson(jsonThread), scope: "turn", sqliteEntries: turnEntriesFromProjection(sqliteProjection) },
    { jsonEntries: segmentEntries(json.display), scope: "display", sqliteEntries: segmentEntries(sqlite.display) },
    { jsonEntries: itemEntries(json.display), scope: "item", sqliteEntries: itemEntries(sqlite.display) },
    {
      jsonEntries: timelineEntriesFromJson(jsonThread, json.semanticByOriginalId),
      scope: "timeline",
      sqliteEntries: timelineEntriesFromProjection(sqliteProjection, sqlite.semanticByOriginalId),
    },
    { jsonEntries: browseEntries(jsonBrowseResultEntries), scope: "browse", sqliteEntries: browseEntries(sqliteProjection.browseResultEntries) },
  ];
  for (const comparison of comparisons) {
    const result = compareEntries(jsonThread.id, comparison.scope, comparison.jsonEntries, comparison.sqliteEntries);
    if (!result.equal) return result;
  }
  return { equal: true };
}
