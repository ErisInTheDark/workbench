/*
 * transcriptSnapshotTables/WorkbenchTranscriptSnapshotRows: one table-selection owner for transcript snapshot types and conformance. Keywords: transcript, database, schema, snapshot.
 * WorkbenchTranscriptSnapshot/conformWorkbenchTranscriptSnapshot: shared relational transcript wire shape and schema-derived browser conformance. Keywords: transcript, browser, compatibility.
 * WorkbenchTranscriptOperation/workbenchTranscriptOperations: shared typed request and response operation registry. Keywords: transcript, websocket, protocol.
 * WorkbenchTranscriptConformanceReport/WorkbenchTranscriptParityDiagnostic: bounded structural and semantic mismatch evidence safe for browser-to-orchestrator logging. Keywords: transcript, conformance, parity, diagnostic.
 * WorkbenchTranscriptRequest/decodeWorkbenchTranscriptRequest: exact server dispatch union decoded by the shared registry. Keywords: transcript, websocket, request.
 * workbenchTranscriptNotifications/conformWorkbenchTranscriptCapabilities/conformWorkbenchTranscriptUpdated: shared notification identities and payload conformance. Keywords: transcript, websocket, capability, notification.
 */
import { coreTables } from "../schema/core-schema.ts";
import { evidenceTables } from "../schema/evidence-schema.ts";
import { interactionTables } from "../schema/interaction-schema.ts";
import { itemTables } from "../schema/item-schema.ts";
import { operationSourceTables } from "../schema/operation-source-schema.ts";
import {
  conformSelectedRow,
  type DatabaseConformanceIssue,
  type DatabaseConformancePath,
  type DatabaseConformanceResult,
} from "workbench-shared/database/schema/schema-conformance";
import type { SelectRow, TableDefinition } from "workbench-shared/database/schema/schema-definition";

export const transcriptSnapshotTables = Object.freeze({
  threadItems: itemTables.threadItems,
  threadItemTimelines: itemTables.threadItemTimelines,
  threadItemTimelineAliases: itemTables.threadItemTimelineAliases,
  threadItemUserMessages: itemTables.threadItemUserMessages,
  threadUserMessageParts: itemTables.threadUserMessageParts,
  threadItemAssistantMessages: itemTables.threadItemAssistantMessages,
  threadItemPlans: itemTables.threadItemPlans,
  threadItemReasoning: itemTables.threadItemReasoning,
  threadReasoningSections: itemTables.threadReasoningSections,
  threadItemFileChanges: itemTables.threadItemFileChanges,
  threadFileChanges: itemTables.threadFileChanges,
  threadItemContextCompactions: itemTables.threadItemContextCompactions,
  threadItemUnknown: itemTables.threadItemUnknown,
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
  threadId: string;
  turnIds?: string[];
  turnLimit: number;
}

export type WorkbenchTranscriptParityScope =
  | "browse"
  | "display"
  | "item"
  | "projection"
  | "timeline"
  | "turn";

export type WorkbenchTranscriptParityMismatch =
  | "extra"
  | "missing"
  | "order"
  | "ownership"
  | "payload"
  | "projectionFailure"
  | "segment"
  | "type";

export interface WorkbenchTranscriptParityContextEntry {
  id: string;
  index: number;
  kind: "browse" | "item" | "segment" | "turn";
  payloadSignature: string;
  turnId: string | null;
  type: string;
}

export interface WorkbenchTranscriptParityDiagnostic {
  jsonContext: WorkbenchTranscriptParityContextEntry[];
  mismatch: WorkbenchTranscriptParityMismatch;
  scope: WorkbenchTranscriptParityScope;
  sqliteContext: WorkbenchTranscriptParityContextEntry[];
  threadId: string;
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

function conformRows<Table extends TableDefinition>(
  table: Table,
  value: unknown,
  path: DatabaseConformancePath,
) {
  if (!Array.isArray(value)) {
    return { issues: [invalidValue(path)], repairedPaths: [], success: false } satisfies DatabaseConformanceResult<SelectRow<Table>[]>;
  }
  const data: SelectRow<Table>[] = [];
  const issues: DatabaseConformanceIssue[] = [];
  const repairedPaths: DatabaseConformancePath[] = [];
  value.forEach((row, index) => {
    const result = conformSelectedRow(table, row, [...path, index]);
    repairedPaths.push(...result.repairedPaths);
    if ("data" in result) data.push(result.data);
    else issues.push(...result.issues);
  });
  return issues.length
    ? { issues, repairedPaths, success: false } as const
    : { data, repairedPaths, success: true } as const;
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

  const turns = conformRows(coreTables.threadTurns, value.turns, ["turns"]);
  repairedPaths.push(...turns.repairedPaths);
  if (!turns.success) issues.push(...turns.issues);

  const loadedTurnIds = value.loadedTurnIds;
  if (!Array.isArray(loadedTurnIds) || loadedTurnIds.some((id) => typeof id !== "string")) {
    issues.push(invalidValue(["loadedTurnIds"]));
  }
  if (typeof value.hasPreviousTurns !== "boolean") issues.push(invalidValue(["hasPreviousTurns"]));

  const rowsValue = isRecord(value.rows) ? value.rows : {};
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
    const result = conformRows(table, rowsValue[name], ["rows", name]);
    repairedPaths.push(...result.repairedPaths);
    if (result.success) {
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

const PARITY_CONTEXT_LIMIT = 7;
const PARITY_TEXT_LIMIT = 200;
const CONFORMANCE_ENTRY_LIMIT = 64;
const CONFORMANCE_PATH_LIMIT = 8;
const conformanceIssueCodes = new Set<DatabaseConformanceIssue["code"]>([
  "invalidRow",
  "invalidValue",
  "missingRequired",
]);
const parityScopes = new Set<WorkbenchTranscriptParityScope>(["browse", "display", "item", "projection", "timeline", "turn"]);
const parityMismatches = new Set<WorkbenchTranscriptParityMismatch>(["extra", "missing", "order", "ownership", "payload", "projectionFailure", "segment", "type"]);

function boundedDiagnosticText(value: unknown) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= PARITY_TEXT_LIMIT
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

function decodeParityContext(value: unknown): DecodeResult<WorkbenchTranscriptParityContextEntry[]> {
  if (!Array.isArray(value) || value.length > PARITY_CONTEXT_LIMIT) {
    return { success: false, message: "Transcript parity context must be a bounded array." };
  }
  const entries: WorkbenchTranscriptParityContextEntry[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) return { success: false, message: "Transcript parity context entries must be objects." };
    const id = boundedDiagnosticText(candidate.id);
    const payloadSignature = boundedDiagnosticText(candidate.payloadSignature);
    const type = boundedDiagnosticText(candidate.type);
    const turnId = candidate.turnId === null
      ? null
      : boundedDiagnosticText(candidate.turnId) ?? undefined;
    const index = candidate.index;
    const kind = candidate.kind;
    if (
      id === null
      || payloadSignature === null
      || type === null
      || turnId === undefined
      || typeof index !== "number"
      || !Number.isSafeInteger(index)
      || index < 0
      || (kind !== "browse" && kind !== "item" && kind !== "segment" && kind !== "turn")
    ) {
      return { success: false, message: "Transcript parity context contains an invalid entry." };
    }
    entries.push({ id, index, kind, payloadSignature, turnId, type });
  }
  return { success: true, data: entries };
}

function decodeParityDiagnostic(value: unknown): DecodeResult<WorkbenchTranscriptParityDiagnostic> {
  if (!isRecord(value)) return { success: false, message: "Transcript parity params must be an object." };
  const threadId = boundedDiagnosticText(value.threadId);
  const scope = value.scope;
  const mismatch = value.mismatch;
  const jsonContext = decodeParityContext(value.jsonContext);
  const sqliteContext = decodeParityContext(value.sqliteContext);
  if (
    threadId === null
    || typeof scope !== "string"
    || !parityScopes.has(scope as WorkbenchTranscriptParityScope)
    || typeof mismatch !== "string"
    || !parityMismatches.has(mismatch as WorkbenchTranscriptParityMismatch)
    || !jsonContext.success
    || !sqliteContext.success
  ) {
    return { success: false, message: "Transcript parity params are invalid or unbounded." };
  }
  return {
    success: true,
    data: {
      threadId,
      scope: scope as WorkbenchTranscriptParityScope,
      mismatch: mismatch as WorkbenchTranscriptParityMismatch,
      jsonContext: jsonContext.data,
      sqliteContext: sqliteContext.data,
    },
  };
}
function decodeReadParams(value: unknown): DecodeResult<WorkbenchTranscriptReadRequest> {
  if (!isRecord(value)) return { success: false, message: "Transcript read params must be an object." };
  const threadId = typeof value.threadId === "string" ? value.threadId.trim() : "";
  const turnLimit = value.turnLimit;
  const beforeTurnIndex = value.beforeTurnIndex;
  const turnIds = value.turnIds;
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
const reportParityOperation = Object.freeze({
  kind: "reportParity",
  method: "workbench/transcript/parity/report",
  decodeParams: decodeParityDiagnostic,
  conformResult: conformLiteralResult("reported"),
}) satisfies WorkbenchTranscriptOperation<"reportParity", "workbench/transcript/parity/report", WorkbenchTranscriptParityDiagnostic, { reported: true }>;
const unsubscribeOperation = Object.freeze({
  kind: "unsubscribe",
  method: "workbench/transcript/unsubscribe",
  decodeParams: decodeUnsubscribeParams,
  conformResult: conformLiteralResult("unsubscribed"),
}) satisfies WorkbenchTranscriptOperation<"unsubscribe", "workbench/transcript/unsubscribe", WorkbenchTranscriptUnsubscribeParams, { unsubscribed: true }>;

export const workbenchTranscriptOperations = Object.freeze({
  read: readOperation,
  reportConformance: reportConformanceOperation,
  reportParity: reportParityOperation,
  subscribe: subscribeOperation,
  unsubscribe: unsubscribeOperation,
});

export type WorkbenchTranscriptRequest =
  | { kind: "read"; operation: typeof readOperation; params: WorkbenchTranscriptReadRequest }
  | { kind: "reportConformance"; operation: typeof reportConformanceOperation; params: WorkbenchTranscriptConformanceReport }
  | { kind: "reportParity"; operation: typeof reportParityOperation; params: WorkbenchTranscriptParityDiagnostic }
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
  if (operation.kind === "reportParity") {
    const decoded = operation.decodeParams(params);
    return "data" in decoded
      ? { success: true, data: { kind: "reportParity", operation, params: decoded.data } }
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

export const WORKBENCH_TRANSCRIPT_PROTOCOL_VERSION = 1;

export interface WorkbenchTranscriptCapabilities {
  protocolVersion: number;
}

export const workbenchTranscriptNotifications = Object.freeze({
  capabilities: Object.freeze({ method: "workbench/transcript/capabilities" as const }),
  updated: Object.freeze({ method: "workbench/transcript/updated" as const }),
});

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
