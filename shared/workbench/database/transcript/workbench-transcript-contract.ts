/*
 * Exports:
 * - transcriptSnapshotTables/WorkbenchTranscriptSnapshotRows: transcript table selection and row types.
 * - WorkbenchTranscriptSnapshot/conformWorkbenchTranscriptSnapshot: relational transcript wire shape and conformance.
 * - WorkbenchTranscriptOperation/workbenchTranscriptOperations: typed request and response operation registry.
 * - WorkbenchTranscriptConformanceReport: bounded structural mismatch evidence.
 * - WorkbenchTranscriptRequest/decodeWorkbenchTranscriptRequest: decoded server dispatch union.
 * - workbenchTranscriptNotifications/conformWorkbenchTranscriptCapabilities/conformWorkbenchTranscriptUpdated: notification contracts.
 * - WorkbenchTranscriptStreamedParams/conformWorkbenchTranscriptStreamed: incremental presentation notifications.
 */
import { coreTables } from "../schema/core-schema.ts";
import { evidenceTables } from "../schema/evidence-schema.ts";
import { interactionTables } from "../schema/interaction-schema.ts";
import { itemTables } from "../schema/item-schema.ts";
import { operationSourceTables } from "../schema/operation-source-schema.ts";
import { transcriptIdentityTables } from "../schema/transcript-identity-schema.ts";
import {
  conformSelectedRow,
  conformSelectedRows,
  type DatabaseConformanceIssue,
  type DatabaseConformancePath,
  type DatabaseConformanceResult,
} from "../../../database/schema/schema-conformance.ts";
import type { SelectRow } from "../../../database/schema/schema-definition.ts";
import type {
  TranscriptLayout, TranscriptLayoutPatch, TranscriptSequenceEdit, TranscriptStreamUpdate, TranscriptTextField, TranscriptPatchUpdate,
} from "../../transcript/thread-transcript-stream.ts";

export const transcriptSnapshotTables = Object.freeze({
  itemIdentities: transcriptIdentityTables.itemIdentities,
  itemSourceAliases: transcriptIdentityTables.itemSourceAliases,
  threadItems: itemTables.threadItems,
  threadItemTimelines: itemTables.threadItemTimelines,
  threadItemTimelineAliases: itemTables.threadItemTimelineAliases,
  threadItemUserMessages: itemTables.threadItemUserMessages,
  threadUserMessageParts: itemTables.threadUserMessageParts,
  threadItemAssistantMessages: itemTables.threadItemAssistantMessages,
  threadItemReasoning: itemTables.threadItemReasoning,
  threadReasoningSections: itemTables.threadReasoningSections,
  threadItemFileChanges: itemTables.threadItemFileChanges,
  threadFileChanges: itemTables.threadFileChanges,
  threadFileChangeHunks: itemTables.threadFileChangeHunks,
  threadFileChangeCandidates: itemTables.threadFileChangeCandidates,
  threadItemContextCompactions: itemTables.threadItemContextCompactions,
  threadItemUnknown: itemTables.threadItemUnknown,
  threadItemToolOutputs: itemTables.threadItemToolOutputs,
  threadToolOutputParts: itemTables.threadToolOutputParts,
  threadItemOperations: operationSourceTables.threadItemOperations,
  threadOperationProcessSources: operationSourceTables.threadOperationProcessSources,
  threadProcessCommandActions: operationSourceTables.threadProcessCommandActions,
  threadOperationToolSources: operationSourceTables.threadOperationToolSources,
  threadOperationCallableToolSources: operationSourceTables.threadOperationCallableToolSources,
  threadCallableDynamicContent: operationSourceTables.threadCallableDynamicContent,
  threadCallableMcpResults: operationSourceTables.threadCallableMcpResults,
  threadCallableMcpResultContent: operationSourceTables.threadCallableMcpResultContent,
  threadOperationCollaborationToolSources: operationSourceTables.threadOperationCollaborationToolSources,
  threadCollaborationReceivers: operationSourceTables.threadCollaborationReceivers,
  threadCollaborationAgentStates: operationSourceTables.threadCollaborationAgentStates,
  threadItemWebSearches: interactionTables.threadItemWebSearches,
  threadWebSearchQueries: interactionTables.threadWebSearchQueries,
  threadWebSearchResults: interactionTables.threadWebSearchResults,
  threadItemInteractions: interactionTables.threadItemInteractions,
  threadInteractionQuestions: interactionTables.threadInteractionQuestions,
  threadInteractionOptions: interactionTables.threadInteractionOptions,
  threadInteractionAnswers: interactionTables.threadInteractionAnswers,
  threadApprovalCommandContexts: interactionTables.threadApprovalCommandContexts,
  threadApprovalCommandActions: interactionTables.threadApprovalCommandActions,
  threadBrowseEntries: evidenceTables.threadBrowseEntries,
  transcriptAssetRefs: evidenceTables.transcriptAssetRefs,
  transcriptAssets: evidenceTables.transcriptAssets,
});

type TranscriptSnapshotTableMap = typeof transcriptSnapshotTables;

export type WorkbenchTranscriptSnapshotRows = {
  -readonly [Name in keyof TranscriptSnapshotTableMap]: SelectRow<TranscriptSnapshotTableMap[Name]>[];
};

export interface WorkbenchTranscriptReadRequest {
  beforeTurnIndex?: number;
  protocolVersion?: 1 | 2 | 3 | 4;
  threadId: string;
  turnIds?: string[];
  turnLimit: number;
}

export interface WorkbenchTranscriptConformanceReport {
  issues: DatabaseConformanceIssue[];
  method: string;
  repairedPaths: DatabaseConformancePath[];
}

export interface WorkbenchTranscriptSnapshot {
  hasPreviousTurns: boolean;
  loadedTurnIds: string[];
  rows: WorkbenchTranscriptSnapshotRows;
  thread: SelectRow<typeof coreTables.workbenchThreads>;
  turns: SelectRow<typeof coreTables.threadTurns>[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidValue(path: DatabaseConformancePath): DatabaseConformanceIssue {
  return { code: "invalidValue", path };
}

export function conformWorkbenchTranscriptSnapshot(
  value: unknown,
): DatabaseConformanceResult<WorkbenchTranscriptSnapshot> {
  if (!isRecord(value)) {
    return { issues: [{ code: "invalidRow", path: [] }], repairedPaths: [], success: false };
  }

  const repairedPaths: DatabaseConformancePath[] = [];
  const issues: DatabaseConformanceIssue[] = [];
  const knownRootKeys = new Set(["thread", "turns", "loadedTurnIds", "hasPreviousTurns", "rows"]);
  for (const key of Object.keys(value)) if (!knownRootKeys.has(key)) repairedPaths.push([key]);

  const thread = conformSelectedRow(coreTables.workbenchThreads, value.thread, ["thread"]);
  repairedPaths.push(...thread.repairedPaths);
  if ("issues" in thread && thread.issues) issues.push(...thread.issues);

  const turns = conformSelectedRows(coreTables.threadTurns, value.turns, ["turns"]);
  repairedPaths.push(...turns.repairedPaths);
  if ("issues" in turns) issues.push(...turns.issues);

  const loadedTurnIds = value.loadedTurnIds;
  if (!Array.isArray(loadedTurnIds) || loadedTurnIds.some((id) => typeof id !== "string")) {
    issues.push(invalidValue(["loadedTurnIds"]));
  }
  if (typeof value.hasPreviousTurns !== "boolean") issues.push(invalidValue(["hasPreviousTurns"]));

  const rawRowsValue = isRecord(value.rows) ? value.rows : {};
  const rowsValue = normalizeLegacyTranscriptRows(rawRowsValue, repairedPaths);
  if (!isRecord(value.rows)) issues.push(invalidValue(["rows"]));
  for (const key of Object.keys(rowsValue)) {
    if (!(key in transcriptSnapshotTables)) repairedPaths.push(["rows", key]);
  }

  const rows: Partial<WorkbenchTranscriptSnapshotRows> = {};
  for (const [name, table] of Object.entries(transcriptSnapshotTables)) {
    if (!(name in rowsValue)) {
      rows[name as keyof WorkbenchTranscriptSnapshotRows] = [];
      repairedPaths.push(["rows", name]);
      continue;
    }
    const result = conformSelectedRows(table, rowsValue[name], ["rows", name]);
    repairedPaths.push(...result.repairedPaths);
    if ("data" in result) {
      rows[name as keyof WorkbenchTranscriptSnapshotRows] = result.data as never;
    } else {
      issues.push(...result.issues);
    }
  }

  if (issues.length || !thread.success || !turns.success) return { issues, repairedPaths, success: false };
  return {
    data: {
      thread: thread.data,
      turns: turns.data,
      loadedTurnIds: loadedTurnIds as string[],
      hasPreviousTurns: value.hasPreviousTurns as boolean,
      rows: rows as WorkbenchTranscriptSnapshotRows,
    },
    repairedPaths,
    success: true,
  };
}

interface DecodeSuccess<Value> {
  success: true;
  data: Value;
}

interface DecodeFailure {
  success: false;
  message: string;
}

type DecodeResult<Value> = DecodeSuccess<Value> | DecodeFailure;

export interface WorkbenchTranscriptOperation<
  Kind extends string,
  Method extends string,
  Params,
  Result,
> {
  readonly kind: Kind;
  readonly method: Method;
  readonly decodeParams: (value: unknown) => DecodeResult<Params>;
  readonly conformResult: (value: unknown) => DatabaseConformanceResult<Result>;
}

const DIAGNOSTIC_TEXT_LIMIT = 200;
const CONFORMANCE_ENTRY_LIMIT = 64;
const CONFORMANCE_PATH_LIMIT = 8;
const conformanceIssueCodes = new Set<DatabaseConformanceIssue["code"]>([
  "invalidRow",
  "invalidValue",
  "missingRequired",
]);

function boundedDiagnosticText(value: unknown) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= DIAGNOSTIC_TEXT_LIMIT
    && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

function decodeConformancePath(value: unknown): DecodeResult<DatabaseConformancePath> {
  if (!Array.isArray(value) || value.length === 0 || value.length > CONFORMANCE_PATH_LIMIT) {
    return { success: false, message: "Transcript conformance path must be a bounded array." };
  }
  const path: Array<number | string> = [];
  for (const part of value) {
    if (typeof part === "number" && Number.isSafeInteger(part) && part >= 0) {
      path.push(part);
      continue;
    }
    const text = boundedDiagnosticText(part);
    if (text === null) return { success: false, message: "Transcript conformance path contains an invalid part." };
    path.push(text);
  }
  return { success: true, data: path };
}

function decodeConformancePaths(value: unknown): DecodeResult<DatabaseConformancePath[]> {
  if (!Array.isArray(value) || value.length > CONFORMANCE_ENTRY_LIMIT) {
    return { success: false, message: "Transcript conformance paths must be a bounded array." };
  }
  const paths: DatabaseConformancePath[] = [];
  for (const candidate of value) {
    const path = decodeConformancePath(candidate);
    if ("message" in path) return { success: false, message: path.message };
    paths.push(path.data);
  }
  return { success: true, data: paths };
}

function decodeConformanceReport(value: unknown): DecodeResult<WorkbenchTranscriptConformanceReport> {
  if (!isRecord(value)) return { success: false, message: "Transcript conformance report must be an object." };
  const method = boundedDiagnosticText(value.method);
  const repairedPaths = decodeConformancePaths(value.repairedPaths);
  if (
    method === null
    || !repairedPaths.success
    || !Array.isArray(value.issues)
    || value.issues.length > CONFORMANCE_ENTRY_LIMIT
  ) {
    return { success: false, message: "Transcript conformance report is invalid or unbounded." };
  }
  const issues: DatabaseConformanceIssue[] = [];
  for (const candidate of value.issues) {
    if (!isRecord(candidate) || !conformanceIssueCodes.has(candidate.code as DatabaseConformanceIssue["code"])) {
      return { success: false, message: "Transcript conformance report contains an invalid issue." };
    }
    const path = decodeConformancePath(candidate.path);
    if ("message" in path) return { success: false, message: path.message };
    issues.push({
      code: candidate.code as DatabaseConformanceIssue["code"],
      path: path.data,
    });
  }
  return {
    success: true,
    data: {
      issues,
      method,
      repairedPaths: repairedPaths.data,
    },
  };
}

function decodeReadParams(value: unknown): DecodeResult<WorkbenchTranscriptReadRequest> {
  if (!isRecord(value)) return { success: false, message: "Transcript read params must be an object." };
  const threadId = typeof value.threadId === "string" ? value.threadId.trim() : "";
  const turnLimit = value.turnLimit;
  const beforeTurnIndex = value.beforeTurnIndex;
  const turnIds = value.turnIds;
  if (
    value.protocolVersion !== undefined
    && value.protocolVersion !== 1
    && value.protocolVersion !== 2
    && value.protocolVersion !== 3
    && value.protocolVersion !== 4
  ) {
    return { success: false, message: "Unsupported transcript protocol version." };
  }
  if (!threadId || typeof turnLimit !== "number" || !Number.isSafeInteger(turnLimit) || turnLimit <= 0) {
    return { success: false, message: "Transcript read requires threadId and a positive turnLimit." };
  }
  if (beforeTurnIndex !== undefined
    && (typeof beforeTurnIndex !== "number" || !Number.isSafeInteger(beforeTurnIndex) || beforeTurnIndex < 0)) {
    return { success: false, message: "Transcript beforeTurnIndex must be a non-negative integer." };
  }
  if (turnIds !== undefined && (
    !Array.isArray(turnIds)
    || turnIds.some((turnId) => typeof turnId !== "string" || !turnId.trim())
    || new Set(turnIds).size !== turnIds.length
  )) {
    return { success: false, message: "Transcript turnIds must be unique non-empty strings." };
  }
  if (beforeTurnIndex !== undefined && turnIds !== undefined) {
    return { success: false, message: "Transcript read cannot combine beforeTurnIndex and turnIds." };
  }
  const data: WorkbenchTranscriptReadRequest = { threadId, turnLimit };
  if (typeof beforeTurnIndex === "number") data.beforeTurnIndex = beforeTurnIndex;
  if (Array.isArray(turnIds)) data.turnIds = turnIds;
  if (
    value.protocolVersion === 1
    || value.protocolVersion === 2
    || value.protocolVersion === 3
    || value.protocolVersion === 4
  ) data.protocolVersion = value.protocolVersion;
  return { success: true, data };
}

interface TranscriptSubscriptionParams {
  subscriptionId: string;
}

export interface WorkbenchTranscriptSubscribeParams
  extends TranscriptSubscriptionParams, WorkbenchTranscriptReadRequest {}

export type WorkbenchTranscriptUnsubscribeParams = TranscriptSubscriptionParams;

function decodeSubscribeParams(value: unknown): DecodeResult<WorkbenchTranscriptSubscribeParams> {
  const read = decodeReadParams(value);
  if ("message" in read) return { success: false, message: read.message };
  const subscriptionId = isRecord(value) && typeof value.subscriptionId === "string" ? value.subscriptionId.trim() : "";
  if (!subscriptionId) return { success: false, message: "Transcript subscription requires subscriptionId." };
  return { success: true, data: { ...read.data, subscriptionId } };
}

function decodeUnsubscribeParams(value: unknown): DecodeResult<WorkbenchTranscriptUnsubscribeParams> {
  const subscriptionId = isRecord(value) && typeof value.subscriptionId === "string" ? value.subscriptionId.trim() : "";
  return subscriptionId
    ? { success: true, data: { subscriptionId } }
    : { success: false, message: "Transcript subscription requires subscriptionId." };
}

function conformSnapshotResult(value: unknown) {
  if (!isRecord(value)) {
    return { issues: [{ code: "invalidRow" as const, path: [] }], repairedPaths: [], success: false as const };
  }
  if (value.snapshot === null) {
    return {
      data: { snapshot: null },
      repairedPaths: Object.keys(value).filter((key) => key !== "snapshot").map((key) => [key]),
      success: true as const,
    };
  }
  const snapshot = conformWorkbenchTranscriptSnapshot(value.snapshot);
  const repairedPaths = snapshot.repairedPaths.map((path) => ["snapshot", ...path]);
  for (const key of Object.keys(value)) if (key !== "snapshot") repairedPaths.push([key]);
  return "data" in snapshot
    ? { data: { snapshot: snapshot.data }, repairedPaths, success: true as const }
    : {
      issues: snapshot.issues.map((issue) => ({ ...issue, path: ["snapshot", ...issue.path] })),
      repairedPaths,
      success: false as const,
    };
}

function conformLiteralResult<Key extends string>(key: Key) {
  return (value: unknown): DatabaseConformanceResult<Record<Key, true>> => {
    if (!isRecord(value) || value[key] !== true) {
      return { issues: [invalidValue([key])], repairedPaths: [], success: false };
    }
    return {
      data: { [key]: true } as Record<Key, true>,
      repairedPaths: Object.keys(value).filter((name) => name !== key).map((name) => [name]),
      success: true,
    };
  };
}

const readOperation: WorkbenchTranscriptOperation<
  "read",
  "workbench/transcript/read",
  WorkbenchTranscriptReadRequest,
  { snapshot: WorkbenchTranscriptSnapshot | null }
> = Object.freeze({
  kind: "read",
  method: "workbench/transcript/read",
  decodeParams: decodeReadParams,
  conformResult: conformSnapshotResult,
});

const subscribeOperation = Object.freeze({
  kind: "subscribe",
  method: "workbench/transcript/subscribe",
  decodeParams: decodeSubscribeParams,
  conformResult: conformLiteralResult("subscribed"),
}) satisfies WorkbenchTranscriptOperation<"subscribe", "workbench/transcript/subscribe", WorkbenchTranscriptSubscribeParams, { subscribed: true }>;

const reportConformanceOperation = Object.freeze({
  kind: "reportConformance",
  method: "workbench/transcript/conformance/report",
  decodeParams: decodeConformanceReport,
  conformResult: conformLiteralResult("reported"),
}) satisfies WorkbenchTranscriptOperation<
  "reportConformance",
  "workbench/transcript/conformance/report",
  WorkbenchTranscriptConformanceReport,
  { reported: true }
>;
const unsubscribeOperation = Object.freeze({
  kind: "unsubscribe",
  method: "workbench/transcript/unsubscribe",
  decodeParams: decodeUnsubscribeParams,
  conformResult: conformLiteralResult("unsubscribed"),
}) satisfies WorkbenchTranscriptOperation<"unsubscribe", "workbench/transcript/unsubscribe", WorkbenchTranscriptUnsubscribeParams, { unsubscribed: true }>;

export const workbenchTranscriptOperations = Object.freeze({
  read: readOperation,
  reportConformance: reportConformanceOperation,
  subscribe: subscribeOperation,
  unsubscribe: unsubscribeOperation,
});

export type WorkbenchTranscriptRequest =
  | { kind: "read"; operation: typeof readOperation; params: WorkbenchTranscriptReadRequest }
  | { kind: "reportConformance"; operation: typeof reportConformanceOperation; params: WorkbenchTranscriptConformanceReport }
  | { kind: "subscribe"; operation: typeof subscribeOperation; params: WorkbenchTranscriptSubscribeParams }
  | { kind: "unsubscribe"; operation: typeof unsubscribeOperation; params: WorkbenchTranscriptUnsubscribeParams };

const operationsByMethod = new Map<string, WorkbenchTranscriptRequest["operation"]>(
  Object.values(workbenchTranscriptOperations).map((operation) => [operation.method, operation]),
);

export function decodeWorkbenchTranscriptRequest(
  method: string,
  params: unknown,
): DecodeResult<WorkbenchTranscriptRequest> | null {
  const operation = operationsByMethod.get(method);
  if (!operation) return null;
  if (operation.kind === "read") {
    const decoded = operation.decodeParams(params);
    return "data" in decoded
      ? { success: true, data: { kind: "read", operation, params: decoded.data } }
      : { success: false, message: decoded.message };
  }
  if (operation.kind === "reportConformance") {
    const decoded = operation.decodeParams(params);
    return "data" in decoded
      ? { success: true, data: { kind: "reportConformance", operation, params: decoded.data } }
      : { success: false, message: decoded.message };
  }
  if (operation.kind === "subscribe") {
    const decoded = operation.decodeParams(params);
    return "data" in decoded
      ? { success: true, data: { kind: "subscribe", operation, params: decoded.data } }
      : { success: false, message: decoded.message };
  }
  const decoded = operation.decodeParams(params);
  return "data" in decoded
    ? { success: true, data: { kind: "unsubscribe", operation, params: decoded.data } }
    : { success: false, message: decoded.message };
}

export interface WorkbenchTranscriptUpdatedParams {
  snapshot: WorkbenchTranscriptSnapshot | null;
  stream: "workbench:transcript";
  subscriptionId: string;
}

export const WORKBENCH_TRANSCRIPT_PROTOCOL_VERSION = 4;

export interface WorkbenchTranscriptCapabilities {
  protocolVersion: number;
}

export const workbenchTranscriptNotifications = Object.freeze({
  capabilities: Object.freeze({ method: "workbench/transcript/capabilities" as const }),
  updated: Object.freeze({ method: "workbench/transcript/updated" as const }),
  streamed: Object.freeze({ method: "workbench/transcript/streamed" as const }),
});

export interface WorkbenchTranscriptStreamedParams {
  subscriptionId: string;
  update: TranscriptStreamUpdate;
}

function normalizeLegacyTranscriptRows(
  rows: Record<string, unknown>,
  repairedPaths: DatabaseConformancePath[],
): Record<string, unknown> {
  const sourceRows = rows.itemSourceAliases;
  if (!Array.isArray(sourceRows)) return rows;
  let repaired = false;
  const itemSourceAliases = sourceRows.map((row, index) => {
    if (!isRecord(row) || typeof row.source_id !== "string" || "reference" in row) return row;
    repaired = true;
    repairedPaths.push(["rows", "itemSourceAliases", index, "source_id"]);
    const { source_id: reference, ...rest } = row;
    return {
      ...rest,
      id: index + 1,
      reference,
      component_kind: "item",
      component_index: 0,
    };
  });
  return repaired ? { ...rows, itemSourceAliases } : rows;
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isSequenceEdit<Value>(
  value: unknown, isValue: (entry: unknown) => entry is Value,
): value is TranscriptSequenceEdit<Value> {
  return isRecord(value) && isNonnegativeInteger(value.offset) && isNonnegativeInteger(value.deleteCount)
    && Array.isArray(value.values) && value.values.every(isValue);
}

function isLayoutItem(value: unknown): value is TranscriptLayout["items"][number] {
  return isRecord(value) && isString(value.itemId) && isString(value.turnId) && isNonnegativeInteger(value.itemIndex);
}

function isLayoutSegment(value: unknown): value is TranscriptLayout["segments"][number] {
  return isRecord(value) && isString(value.id) && isString(value.turnId)
    && isNonnegativeInteger(value.offset) && isNonnegativeInteger(value.count)
    && typeof value.isFirstForTurn === "boolean" && typeof value.isLastForTurn === "boolean"
    && typeof value.ownsCanonicalTerminal === "boolean" && (value.kind === "canonical" || value.kind === "virtual");
}

function isLayoutPatch(value: unknown): value is TranscriptLayoutPatch {
  return isRecord(value)
    && (value.turns === undefined || isSequenceEdit(value.turns, isString))
    && (value.history === undefined || isSequenceEdit(value.history, isString))
    && (value.items === undefined || isSequenceEdit(value.items, isLayoutItem))
    && (value.segments === undefined || isSequenceEdit(value.segments, isLayoutSegment));
}

function isTextField(value: unknown): value is TranscriptTextField {
  return value === "agentMessageText" || value === "commandExecutionOutput"
    || value === "reasoningContent" || value === "reasoningSummary";
}

function isFilePatch(value: unknown): value is TranscriptPatchUpdate["changes"][number] {
  return isRecord(value) && isString(value.path) && isString(value.diff) && isRecord(value.kind)
    && (value.kind.type === "add" || value.kind.type === "delete"
      || (value.kind.type === "update" && (value.kind.move_path === null || isString(value.kind.move_path))));
}

export function conformWorkbenchTranscriptStreamed(value: unknown): DatabaseConformanceResult<WorkbenchTranscriptStreamedParams> {
  const invalid = (): DatabaseConformanceResult<WorkbenchTranscriptStreamedParams> => ({
    success: false, repairedPaths: [], issues: [invalidValue(["update"])],
  });
  if (!isRecord(value) || !isString(value.subscriptionId) || !isRecord(value.update)) return invalid();
  const update = value.update;
  if (update.kind === "absent") {
    return { success: true, repairedPaths: [], data: { subscriptionId: value.subscriptionId, update: { kind: "absent" } } };
  }
  if (update.kind === "patch" && isString(update.threadId) && isString(update.turnId) && isString(update.itemId)
    && Array.isArray(update.changes) && update.changes.every(isFilePatch)) {
    return { success: true, repairedPaths: [], data: { subscriptionId: value.subscriptionId, update: {
      kind: "patch", threadId: update.threadId, turnId: update.turnId, itemId: update.itemId, changes: update.changes,
    } } };
  }
  if (update.kind === "text" && isString(update.threadId) && isString(update.turnId) && isString(update.itemId)
    && isString(update.text) && isTextField(update.field) && typeof update.append === "boolean"
    && (update.index === null || isNonnegativeInteger(update.index))) {
    return {
      success: true, repairedPaths: [],
      data: { subscriptionId: value.subscriptionId, update: {
        kind: "text", threadId: update.threadId, turnId: update.turnId, itemId: update.itemId,
        text: update.text, field: update.field, append: update.append, index: typeof update.index === "number" ? update.index : null,
      } },
    };
  }
  if (update.kind !== "structure" || typeof update.reset !== "boolean" || typeof update.hasPreviousTurns !== "boolean"
    || !Array.isArray(update.removedItemIds) || !update.removedItemIds.every(isString) || !isLayoutPatch(update.layout)) return invalid();
  const snapshot = conformWorkbenchTranscriptSnapshot(update.snapshot);
  if (!("data" in snapshot)) return { success: false, repairedPaths: snapshot.repairedPaths, issues: snapshot.issues };
  return {
    success: true, repairedPaths: snapshot.repairedPaths.map(path => ["update", "snapshot", ...path]),
    data: { subscriptionId: value.subscriptionId, update: {
      kind: "structure", reset: update.reset, hasPreviousTurns: update.hasPreviousTurns,
      removedItemIds: update.removedItemIds, layout: update.layout, snapshot: snapshot.data,
    } },
  };
}

export function conformWorkbenchTranscriptCapabilities(
  value: unknown,
): DatabaseConformanceResult<WorkbenchTranscriptCapabilities> {
  if (!isRecord(value)
    || typeof value.protocolVersion !== "number"
    || !Number.isSafeInteger(value.protocolVersion)
    || value.protocolVersion < 1) {
    return { issues: [invalidValue(["protocolVersion"])], repairedPaths: [], success: false };
  }
  return {
    data: { protocolVersion: value.protocolVersion },
    repairedPaths: Object.keys(value).filter((key) => key !== "protocolVersion").map((key) => [key]),
    success: true,
  };
}

export function conformWorkbenchTranscriptUpdated(
  value: unknown,
): DatabaseConformanceResult<WorkbenchTranscriptUpdatedParams> {
  if (!isRecord(value)) {
    return { issues: [{ code: "invalidRow", path: [] }], repairedPaths: [], success: false };
  }
  const repairedPaths: DatabaseConformancePath[] = [];
  for (const key of Object.keys(value)) {
    if (key !== "snapshot" && key !== "stream" && key !== "subscriptionId") repairedPaths.push([key]);
  }
  const snapshot = value.snapshot === null ? null : conformWorkbenchTranscriptSnapshot(value.snapshot);
  if (snapshot) repairedPaths.push(...snapshot.repairedPaths.map((path) => ["snapshot", ...path]));
  const issues: DatabaseConformanceIssue[] = snapshot === null || "data" in snapshot
    ? []
    : snapshot.issues.map((issue) => ({ ...issue, path: ["snapshot", ...issue.path] }));
  if (value.stream !== "workbench:transcript") issues.push(invalidValue(["stream"]));
  if (typeof value.subscriptionId !== "string" || !value.subscriptionId.trim()) {
    issues.push(invalidValue(["subscriptionId"]));
  }
  if (issues.length) return { issues, repairedPaths, success: false };
  let conformedSnapshot: WorkbenchTranscriptSnapshot | null = null;
  if (snapshot !== null) {
    if (!("data" in snapshot)) return { issues: snapshot.issues, repairedPaths, success: false };
    conformedSnapshot = snapshot.data;
  }
  return {
    data: {
      snapshot: conformedSnapshot,
      stream: "workbench:transcript",
      subscriptionId: (value.subscriptionId as string).trim(),
    },
    repairedPaths,
    success: true,
  };
}
