/*
 * Exports:
 * - default WorkbenchTranscriptRepository: own atomic settlement, provider replacement, reset, and bounded reads. Keywords: transcript, repository, provider, replacement, transaction.
 * Local helpers: classify timestamps, provider projection items, and one transaction-local canonical item index. Keywords: transcript, item, timeline, projection, index.
 */
import type Database from "better-sqlite3";

import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import {
  mergeThreadItem,
  reconcileCompleteThreadItems,
} from "workbench-shared/codex/thread-item-normalization";
import { SYNTHETIC_STEER_HISTORY_ITEM_ID_PREFIX } from "workbench-shared/workbench/thread/thread-steer-history";
import type { WorkbenchFileChangeItem } from "workbench-shared/workbench/thread/workbench-file-change";
import type { WorkbenchThreadItemTimelineEntry } from "workbench-shared/workbench/thread/thread-item-timeline";
import {
  projectWorkbenchTranscriptItems,
  type WorkbenchProjectedTranscriptItem,
} from "workbench-shared/workbench/database/transcript/workbench-transcript-item-projection";
import type {
  ColumnDefinition,
  CurrentTableDefinition,
  SelectRow,
} from "workbench-shared/database/schema/schema-definition";
import {
  coreTables,
  evidenceTables,
  interactionTables,
  itemTables,
  operationSourceTables,
  workbenchDatabaseTables,
} from "../workbench-database-schema.ts";
import {
  compileWorkbenchDatabaseStatement,
  deleteRows,
  insertRow,
  selectRows,
  updateRows,
  upsertRow,
  type WorkbenchDatabaseMutation,
  type WorkbenchDatabaseQuery,
  type WorkbenchDatabaseRow,
  type WorkbenchDatabaseRowInFilter,
} from "workbench-shared/database/workbench-database-statements";
import {
  resolveQuestionnaireTranscriptSourceId,
  resolveSteerTranscriptSourceId,
  transformQuestionnaireEntry,
  transformSteerEntry,
} from "./workbench-transcript-interaction-transformers.ts";
import {
  transformWorkbenchTranscriptItem,
  type WorkbenchTranscriptItemTransform,
} from "./workbench-transcript-transform-registry.ts";
import type {
  WorkbenchTranscriptAtomicObservation,
  WorkbenchTranscriptCaptureGapObservation,
  WorkbenchTranscriptObservation,
  WorkbenchTranscriptReadRequest,
  WorkbenchTranscriptSettlement,
  WorkbenchTranscriptSnapshot,
  WorkbenchTranscriptSnapshotRows,
} from "./workbench-transcript-types.ts";

const CURRENT_TRANSCRIPT_CONTENT_VERSION = 3;
const SQLITE_ITEM_ID_BATCH_SIZE = 500;

type TableRow<Table extends CurrentTableDefinition> = SelectRow<Table>;
type TranscriptThreadRow = TableRow<typeof coreTables.workbenchThreads>;
type TranscriptTurnRow = TableRow<typeof coreTables.threadTurns>;
type TranscriptItemRow = TableRow<typeof itemTables.threadItems>;
type TranscriptTimelineRow = TableRow<typeof itemTables.threadItemTimelines>;

interface CanonicalSettlementIndex {
  readonly itemsBySourceId: Map<string, TranscriptItemRow>;
  readonly itemsByTurnId: Map<string, Map<number, TranscriptItemRow>>;
  readonly materializedTurnIds: Set<string>;
  readonly operationRevisionsByItemId: Map<number, number>;
  thread: TranscriptThreadRow;
  readonly timelineAliasesByItemId: Map<number, string[]>;
  readonly timelinesByItemId: Map<number, TranscriptTimelineRow>;
  readonly turnsById: Map<string, TranscriptTurnRow>;
}

function earliestTimestamp(left: number | null, right: number | null) {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

function latestTimestamp(left: number | null, right: number | null) {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

function isProviderProjectionItem(item: WorkbenchProjectedTranscriptItem): item is ThreadItem | WorkbenchFileChangeItem {
  return item.type !== "approval" && item.type !== "questionnaire" && item.type !== "unknown";
}

export default class WorkbenchTranscriptRepository {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  reset() {
    this.#database.transaction(() => {
      this.#database.prepare("DELETE FROM transcript_native_records").run();
      this.#database.prepare("DELETE FROM workbench_threads").run();
      this.#database.prepare("DELETE FROM transcript_assets").run();
      this.#database.prepare("DELETE FROM workbench_harnesses").run();
    })();
  }

  settle(observations: readonly WorkbenchTranscriptObservation[]): WorkbenchTranscriptSettlement {
    const changedThreadIds = new Set<string>();
    this.#database.transaction(() => {
      for (const observation of observations) {
        const threadId = observation.kind === "canonicalWindow"
          ? this.#settleCanonicalWindow(observation)
          : observation.kind === "providerTurnScope"
            ? this.#settleProviderTurnScope(observation)
          : this.#settleObservation(observation);
        if (threadId) changedThreadIds.add(threadId);
      }
    })();
    return { changedThreadIds: [...changedThreadIds] };
  }

  read(request: WorkbenchTranscriptReadRequest): WorkbenchTranscriptSnapshot | null {
    if (!Number.isInteger(request.turnLimit) || request.turnLimit <= 0) {
      throw new Error("Transcript turnLimit must be a positive integer");
    }
    return this.#database.transaction(() => {
      const thread = this.#one(selectRows(coreTables.workbenchThreads, {
        where: { id: request.threadId },
      }));
      if (!thread) return null;
      const turns = this.#all(selectRows(coreTables.threadTurns, {
        where: { thread_id: request.threadId },
        orderBy: [{ column: "turn_index" }],
      }));
      const eligibleTurns = request.beforeTurnIndex === undefined
        ? turns
        : turns.filter((turn) => turn.turn_index < request.beforeTurnIndex!);
      const requestedTurnIds = request.turnIds ? new Set(request.turnIds) : null;
      const loadedTurns = requestedTurnIds
        ? eligibleTurns.filter((turn) => requestedTurnIds.has(turn.id))
        : eligibleTurns.slice(-request.turnLimit);
      if (requestedTurnIds && loadedTurns.length !== requestedTurnIds.size) {
        const missingTurnIds = [...requestedTurnIds].filter((turnId) => !loadedTurns.some(({ id }) => id === turnId));
        const foreignTurn = missingTurnIds
          .map((turnId) => this.#one(selectRows(coreTables.threadTurns, { where: { id: turnId } })))
          .find((turn) => turn !== null);
        if (!foreignTurn) return null;
        throw new Error(`Transcript turn ${foreignTurn.id} belongs to thread ${foreignTurn.thread_id}, not ${request.threadId}`);
      }
      const loadedTurnIds = loadedTurns.map(({ id }) => id);
      const materializations = this.#all(selectRows(coreTables.threadTurnMaterializations, {
        where: { thread_id: request.threadId },
      }));
      const materializedTurnIds = new Set(materializations.map(({ turn_id }) => turn_id));
      if (loadedTurnIds.some((turnId) => !materializedTurnIds.has(turnId))) return null;
      const firstLoadedTurnIndex = loadedTurns[0]?.turn_index;
      const threadItems = this.#all(selectRows(itemTables.threadItems, {
        whereIn: { turn_id: loadedTurnIds },
        orderBy: [{ column: "item_position" }],
      }));
      const itemIds = threadItems.map(({ id }) => id);
      const rows = this.#readRows(request.threadId, itemIds);
      rows.threadItems = threadItems;
      return {
        thread,
        turns,
        loadedTurnIds,
        hasPreviousTurns: firstLoadedTurnIndex !== undefined
          && turns.some((turn) => turn.turn_index < firstLoadedTurnIndex),
        rows,
      };
    })();
  }

  readMaterializedTurnIds(threadId: string, turnIds: readonly string[]) {
    const requestedTurnIds = [...new Set(turnIds)];
    if (requestedTurnIds.length === 0) return [];
    const materializations = this.#all(selectRows(coreTables.threadTurnMaterializations, {
      where: { thread_id: threadId },
      whereIn: { turn_id: requestedTurnIds },
    }));
    const materializedTurnIds = new Set(materializations.map(({ turn_id }) => turn_id));
    return requestedTurnIds.filter((turnId) => materializedTurnIds.has(turnId));
  }

  #createCanonicalSettlementIndex(threadId: string): CanonicalSettlementIndex {
    const thread = this.#requiredThread(threadId);
    const turns = this.#all(selectRows(coreTables.threadTurns, { where: { thread_id: threadId } }));
    const items = this.#all(selectRows(itemTables.threadItems, { where: { thread_id: threadId } }));
    const itemIds = items.map(({ id }) => id);
    const operations = this.#rowsByItemIds(operationSourceTables.threadItemOperations, itemIds);
    const timelines = this.#rowsByItemIds(itemTables.threadItemTimelines, itemIds);
    const aliases = this.#rowsByItemIds(itemTables.threadItemTimelineAliases, itemIds);
    const itemsByTurnId = new Map<string, Map<number, TranscriptItemRow>>();
    for (const item of items) {
      const turnItems = itemsByTurnId.get(item.turn_id) ?? new Map<number, TranscriptItemRow>();
      turnItems.set(item.id, item);
      itemsByTurnId.set(item.turn_id, turnItems);
    }
    const timelineAliasesByItemId = new Map<number, string[]>();
    for (const alias of aliases) {
      const itemAliases = timelineAliasesByItemId.get(alias.item_id) ?? [];
      itemAliases.push(alias.alias);
      timelineAliasesByItemId.set(alias.item_id, itemAliases);
    }
    return {
      itemsBySourceId: new Map(items.map((item) => [item.source_id, item])),
      itemsByTurnId,
      materializedTurnIds: new Set(this.#all(selectRows(coreTables.threadTurnMaterializations, {
        where: { thread_id: threadId },
      })).map(({ turn_id }) => turn_id)),
      operationRevisionsByItemId: new Map(operations.map((operation) => [
        operation.item_id,
        operation.source_revision,
      ])),
      thread,
      timelineAliasesByItemId,
      timelinesByItemId: new Map(timelines.map((timeline) => [timeline.item_id, timeline])),
      turnsById: new Map(turns.map((turn) => [turn.id, turn])),
    };
  }

  #replaceCanonicalItem(
    index: CanonicalSettlementIndex,
    existing: TranscriptItemRow,
    changes: Partial<TranscriptItemRow>,
  ) {
    const replacement = { ...existing, ...changes };
    index.itemsBySourceId.set(replacement.source_id, replacement);
    if (existing.turn_id !== replacement.turn_id) {
      index.itemsByTurnId.get(existing.turn_id)?.delete(existing.id);
    }
    const turnItems = index.itemsByTurnId.get(replacement.turn_id) ?? new Map<number, TranscriptItemRow>();
    turnItems.set(replacement.id, replacement);
    index.itemsByTurnId.set(replacement.turn_id, turnItems);
    return replacement;
  }

  #deleteCanonicalItem(index: CanonicalSettlementIndex, item: TranscriptItemRow) {
    this.#run(deleteRows(itemTables.threadItems, { id: item.id }));
    index.itemsBySourceId.delete(item.source_id);
    index.itemsByTurnId.get(item.turn_id)?.delete(item.id);
    index.operationRevisionsByItemId.delete(item.id);
    index.timelinesByItemId.delete(item.id);
    index.timelineAliasesByItemId.delete(item.id);
  }

  #providerReplacementProtectedItemIds(existingItems: readonly TranscriptItemRow[]) {
    const itemIds = existingItems.map(({ id }) => id);
    const sourceIdByItemId = new Map(existingItems.map(({ id, source_id }) => [id, source_id]));
    const protectedItemIds = new Set(existingItems
      .filter(({ source_id, type }) => (
        type === "questionnaire"
        || type === "approval"
        || source_id.startsWith(SYNTHETIC_STEER_HISTORY_ITEM_ID_PREFIX)
      ))
      .map(({ id }) => id));
    for (const row of this.#rowsByItemIds(itemTables.threadItemUserMessages, itemIds)) {
      const sourceId = sourceIdByItemId.get(row.item_id);
      if (row.client_id && sourceId && !/^item-\d+$/u.test(sourceId)) {
        protectedItemIds.add(row.item_id);
      }
    }
    for (const row of this.#rowsByItemIds(itemTables.threadItemFileChanges, itemIds)) {
      if (row.workbench_failure_kind) protectedItemIds.add(row.item_id);
    }
    for (const row of this.#rowsByItemIds(itemTables.threadItemUnknown, itemIds)) {
      if (row.native_type === "workbenchSteer") protectedItemIds.add(row.item_id);
    }
    for (const row of this.#rowsByItemIds(evidenceTables.threadBrowseEntries, itemIds)) {
      protectedItemIds.add(row.item_id);
    }
    return protectedItemIds;
  }

  #providerReplacementTimeline(
    index: CanonicalSettlementIndex,
    itemId: string,
    observation: Extract<WorkbenchTranscriptAtomicObservation, { kind: "item" }>,
    aliases: readonly string[],
  ): WorkbenchThreadItemTimelineEntry | undefined {
    const existingItem = index.itemsBySourceId.get(itemId);
    const existingTimeline = existingItem ? index.timelinesByItemId.get(existingItem.id) : undefined;
    const existingAliases = existingItem ? index.timelineAliasesByItemId.get(existingItem.id) ?? [] : [];
    const mergedAliases = Array.from(new Set([
      ...existingAliases,
      ...(observation.timeline?.aliases ?? []),
      ...aliases,
    ])).filter((alias) => alias !== itemId);
    if (!existingTimeline && !observation.timeline && mergedAliases.length === 0) {
      return undefined;
    }
    return {
      ...(mergedAliases.length ? { aliases: mergedAliases } : {}),
      completedAt: latestTimestamp(
        existingTimeline?.completed_at ?? null,
        observation.timeline?.completedAt ?? (
          existingTimeline
            ? null
            : observation.lifecycle === "completed"
              ? observation.observedAt
              : null
        ),
      ),
      firstSeenAt: earliestTimestamp(
        existingTimeline?.first_seen_at ?? null,
        observation.timeline?.firstSeenAt ?? (existingTimeline ? null : observation.observedAt),
      ) ?? observation.observedAt,
      itemId,
      lastSeenAt: latestTimestamp(
        existingTimeline?.last_seen_at ?? null,
        observation.timeline?.lastSeenAt ?? (existingTimeline ? null : observation.observedAt),
      ) ?? observation.observedAt,
      startedAt: earliestTimestamp(
        existingTimeline?.started_at ?? null,
        observation.timeline?.startedAt ?? null,
      ),
    };
  }

  #settleProviderTurnScope(
    scope: Extract<WorkbenchTranscriptObservation, { kind: "providerTurnScope" }>,
  ) {
    if (new Set(scope.completeTurnIds).size !== scope.completeTurnIds.length) {
      throw new Error("Complete provider scope contains duplicate turn ids");
    }
    for (const observation of scope.observations) {
      if (observation.kind !== "thread" && observation.kind !== "turn" && observation.kind !== "item") {
        throw new Error(`Complete provider scope contains unsupported ${observation.kind} observation`);
      }
      if (observation.threadId !== scope.threadId) {
        throw new Error(`Complete provider scope crossed thread ownership: ${observation.threadId}`);
      }
    }
    const turnObservations = scope.observations.filter((
      observation,
    ): observation is Extract<WorkbenchTranscriptAtomicObservation, { kind: "turn" }> => observation.kind === "turn");
    const turnsById = new Map(turnObservations.map((observation) => [observation.turnId, observation]));
    for (const turnId of scope.completeTurnIds) {
      if (!turnsById.has(turnId)) {
        throw new Error(`Complete provider scope references unknown turn ${turnId}`);
      }
    }
    const completeTurnIds = new Set(scope.completeTurnIds);
    for (const observation of scope.observations) {
      if (observation.kind === "item" && !completeTurnIds.has(observation.turnId)) {
        throw new Error(`Complete provider item ${observation.item.id} references incomplete turn ${observation.turnId}`);
      }
    }

    for (const observation of scope.observations) {
      if (observation.kind !== "item") this.#settleObservation(observation, true);
    }
    const index = this.#createCanonicalSettlementIndex(scope.threadId);
    for (const turnId of scope.completeTurnIds) {
      const itemObservations = scope.observations.filter((
        observation,
      ): observation is Extract<WorkbenchTranscriptAtomicObservation, { kind: "item" }> => (
        observation.kind === "item" && observation.turnId === turnId
      ));
      const incomingSourceIds = itemObservations.map(({ item }) => item.id);
      if (new Set(incomingSourceIds).size !== incomingSourceIds.length) {
        throw new Error(`Complete provider turn ${turnId} contains duplicate item ids`);
      }
      const existingItems = [...(index.itemsByTurnId.get(turnId)?.values() ?? [])]
        .sort((left, right) => left.item_position - right.item_position);
      const protectedItemIds = this.#providerReplacementProtectedItemIds(existingItems);
      const rows = this.#readRows(scope.threadId, existingItems.map(({ id }) => id));
      rows.threadItems = existingItems;
      const projection = projectWorkbenchTranscriptItems(rows);
      if ("issues" in projection) {
        const issues = projection.issues.map(({ code, itemId, table }) => (
          `${code}:${table}${itemId ? `:${itemId}` : ""}`
        )).join(", ");
        throw new Error(`Complete provider turn ${turnId} could not project current items: ${issues}`);
      }
      const projectedBySourceId = new Map(projection.data.map(({ item, root }) => [root.source_id, item]));
      const currentProviderItems = projection.data.flatMap(({ item, root }) => (
        isProviderProjectionItem(item)
        && !root.source_id.startsWith(SYNTHETIC_STEER_HISTORY_ITEM_ID_PREFIX)
          ? [item]
          : []
      ));
      const incomingObservationById = new Map(itemObservations.map((observation) => [
        observation.item.id,
        observation,
      ]));
      const reconciledItems = reconcileCompleteThreadItems(
        currentProviderItems,
        itemObservations.map(({ item }) => item),
        { mergeDuplicateItems: mergeThreadItem },
      ).map((entry) => {
        const existingRoot = index.itemsBySourceId.get(entry.item.id);
        if (!existingRoot || !protectedItemIds.has(existingRoot.id)) return entry;
        const existingItem = projectedBySourceId.get(existingRoot.source_id);
        if (
          existingItem?.type === "userMessage"
          && entry.item.type === "userMessage"
          && existingItem.clientId
        ) {
          return {
            ...entry,
            item: { ...entry.item, clientId: existingItem.clientId },
          };
        }
        if (
          existingItem?.type === "fileChange"
          && entry.item.type === "fileChange"
          && "workbenchFailureKind" in existingItem
          && existingItem.workbenchFailureKind
        ) {
          return {
            ...entry,
            item: {
              ...entry.item,
              workbenchFailureKind: existingItem.workbenchFailureKind,
            },
          };
        }
        return entry;
      });
      const desiredSourceIds = reconciledItems.map(({ item }) => item.id);
      if (new Set(desiredSourceIds).size !== desiredSourceIds.length) {
        throw new Error(`Complete provider turn ${turnId} reconciled duplicate item ids`);
      }
      const desiredSourceIdSet = new Set(desiredSourceIds);
      const survivingSourceIdByEvidenceId = new Map<string, string>();
      for (const entry of reconciledItems) {
        survivingSourceIdByEvidenceId.set(entry.item.id, entry.item.id);
        survivingSourceIdByEvidenceId.set(entry.incomingItemId, entry.item.id);
        for (const alias of entry.aliases) {
          survivingSourceIdByEvidenceId.set(alias, entry.item.id);
        }
      }
      const protectedAfterSourceId = new Map<string | null, TranscriptItemRow[]>();
      let precedingProviderSourceId: string | null = null;
      for (const existingItem of existingItems) {
        const survivingSourceId = survivingSourceIdByEvidenceId.get(existingItem.source_id);
        if (survivingSourceId) {
          precedingProviderSourceId = survivingSourceId;
          continue;
        }
        if (!protectedItemIds.has(existingItem.id) || desiredSourceIdSet.has(existingItem.source_id)) continue;
        const protectedItems = protectedAfterSourceId.get(precedingProviderSourceId) ?? [];
        protectedItems.push(existingItem);
        protectedAfterSourceId.set(precedingProviderSourceId, protectedItems);
      }

      for (const existingItem of existingItems) {
        if (!desiredSourceIdSet.has(existingItem.source_id) && !protectedItemIds.has(existingItem.id)) {
          this.#deleteCanonicalItem(index, existingItem);
        }
      }
      const finalEntries: Array<
        | {
          entry: (typeof reconciledItems)[number];
          kind: "provider";
          observation: Extract<WorkbenchTranscriptAtomicObservation, { kind: "item" }>;
        }
        | { item: TranscriptItemRow; kind: "protected" }
      > = [];
      for (const item of protectedAfterSourceId.get(null) ?? []) {
        finalEntries.push({ item, kind: "protected" });
      }
      for (const entry of reconciledItems) {
        const observation = incomingObservationById.get(entry.incomingItemId);
        if (!observation) {
          throw new Error(`Complete provider turn ${turnId} lost incoming item ${entry.incomingItemId}`);
        }
        finalEntries.push({ entry, kind: "provider", observation });
        for (const item of protectedAfterSourceId.get(entry.item.id) ?? []) {
          finalEntries.push({ item, kind: "protected" });
        }
      }
      const retainedExistingItems = existingItems.filter((item) => (
        desiredSourceIdSet.has(item.source_id) || protectedItemIds.has(item.id)
      ));
      const temporaryPositionBase = Math.max(
        finalEntries.length,
        ...retainedExistingItems.map(({ item_position }) => item_position + 1),
      );
      for (const [offset, existingItem] of retainedExistingItems.entries()) {
        this.#run(updateRows(itemTables.threadItems, {
          item_position: temporaryPositionBase + offset,
        }, { id: existingItem.id }));
        this.#replaceCanonicalItem(index, existingItem, {
          item_position: temporaryPositionBase + offset,
        });
      }
      for (const [itemPosition, entry] of finalEntries.entries()) {
        if (entry.kind === "provider") {
          const timeline = this.#providerReplacementTimeline(
            index,
            entry.entry.item.id,
            entry.observation,
            entry.entry.aliases,
          );
          this.#settleObservation(
            {
              ...entry.observation,
              item: entry.entry.item,
              itemPosition,
              ...(timeline ? { timeline } : {}),
            },
            true,
            index,
          );
          continue;
        }
        this.#run(updateRows(itemTables.threadItems, {
          item_position: itemPosition,
        }, { id: entry.item.id }));
        this.#replaceCanonicalItem(index, index.itemsBySourceId.get(entry.item.source_id) ?? entry.item, {
          item_position: itemPosition,
        });
      }
      this.#materializeTurn(scope.threadId, turnId, index);
    }
    return scope.threadId;
  }

  #settleCanonicalWindow(
    window: Extract<WorkbenchTranscriptObservation, { kind: "canonicalWindow" }>,
  ) {
    if (window.contentVersion !== CURRENT_TRANSCRIPT_CONTENT_VERSION) {
      throw new Error(`Unsupported transcript content version: ${window.contentVersion}`);
    }
    if (!window.observations.length || window.observations[0]?.kind !== "thread") {
      throw new Error("Canonical transcript window must begin with its thread");
    }
    if (new Set(window.materializedTurnIds).size !== window.materializedTurnIds.length) {
      throw new Error("Canonical transcript window contains duplicate materialized turn ids");
    }
    for (const observation of window.observations) {
      const observationThreadId = observation.kind === "questionnaire" || observation.kind === "steer"
        ? observation.entry.threadId
        : observation.kind === "browse"
          ? observation.entry.threadId
          : observation.threadId;
      if (observationThreadId !== window.threadId) {
        throw new Error(`Canonical transcript window crossed thread ownership: ${observationThreadId}`);
      }
    }
    const turnObservations = window.observations.filter((
      observation,
    ): observation is Extract<WorkbenchTranscriptAtomicObservation, { kind: "turn" }> => observation.kind === "turn");
    const turnsById = new Map(turnObservations.map((observation) => [observation.turnId, observation]));
    for (const turnId of window.materializedTurnIds) {
      if (!turnsById.has(turnId)) {
        throw new Error(`Canonical transcript window materializes unknown turn ${turnId}`);
      }
    }
    const materializedTurnIds = new Set(window.materializedTurnIds);
    for (const observation of window.observations) {
      const turnId = this.#itemObservationTurnId(observation);
      if (turnId && !materializedTurnIds.has(turnId)) {
        throw new Error(`Canonical transcript window item references unloaded turn ${turnId}`);
      }
    }

    const existing = this.#one(selectRows(coreTables.workbenchThreads, { where: { id: window.threadId } }));
    if (existing && existing.transcript_content_version < CURRENT_TRANSCRIPT_CONTENT_VERSION) {
      this.#run(deleteRows(coreTables.workbenchThreads, { id: window.threadId }));
    }
    this.#settleObservation(window.observations[0]!, true);
    for (const observation of turnObservations) this.#settleObservation(observation, true);
    const index = this.#createCanonicalSettlementIndex(window.threadId);

    for (const turnId of window.materializedTurnIds) {
      const itemObservations = window.observations.filter((observation) => (
        this.#itemObservationTurnId(observation) === turnId
      ));
      const identifiedItems = itemObservations.flatMap((observation) => {
        const itemId = this.#itemObservationId(observation);
        return itemId ? [{ itemId, observation }] : [];
      });
      const desiredSourceIds = identifiedItems.map(({ itemId }) => itemId);
      if (new Set(desiredSourceIds).size !== desiredSourceIds.length) {
        throw new Error(`Canonical transcript turn ${turnId} contains duplicate item ids`);
      }
      const desiredSourceIdSet = new Set(desiredSourceIds);
      const existingItems = [...(index.itemsByTurnId.get(turnId)?.values() ?? [])];
      for (const existingItem of existingItems) {
        if (!desiredSourceIdSet.has(existingItem.source_id)) {
          this.#deleteCanonicalItem(index, existingItem);
        }
      }
      const temporaryPositionBase = Math.max(
        desiredSourceIds.length,
        ...existingItems.map(({ item_position }) => item_position + 1),
      );
      for (const [offset, existingItem] of existingItems
        .filter(({ source_id }) => desiredSourceIdSet.has(source_id))
        .entries()) {
        this.#run(updateRows(itemTables.threadItems, {
          item_position: temporaryPositionBase + offset,
        }, { id: existingItem.id }));
        this.#replaceCanonicalItem(index, existingItem, {
          item_position: temporaryPositionBase + offset,
        });
      }
      for (const [itemPosition, { observation }] of identifiedItems.entries()) {
        this.#settleObservation(this.#withItemPosition(observation, itemPosition), true, index);
      }
      this.#materializeTurn(window.threadId, turnId, index);
    }

    for (const observation of window.observations) {
      if (
        observation.kind !== "thread"
        && observation.kind !== "turn"
        && !this.#itemObservationTurnId(observation)
      ) {
        this.#settleObservation(observation, true, index);
      }
    }
    this.#run(updateRows(coreTables.workbenchThreads, {
      transcript_content_version: CURRENT_TRANSCRIPT_CONTENT_VERSION,
    }, { id: window.threadId }));
    return window.threadId;
  }

  #settleObservation(
    observation: WorkbenchTranscriptAtomicObservation | WorkbenchTranscriptCaptureGapObservation,
    insideCanonicalWindow = false,
    canonicalIndex?: CanonicalSettlementIndex,
  ) {
    if (observation.kind === "thread") {
      this.#run(upsertRow(coreTables.workbenchThreads, {
        id: observation.threadId,
        project_id: observation.projectId,
        project_root: observation.projectRoot,
        title: observation.title,
        transcript_content_version: 0,
        created_at: observation.createdAt,
        updated_at: observation.updatedAt,
        activity_at: observation.activityAt,
      }, {
        conflictColumns: ["id"],
        updateColumns: ["project_id", "project_root", "title", "updated_at", "activity_at"],
      }));
      return observation.threadId;
    }
    if (observation.kind === "turn") {
      this.#ensureHarness(observation.harnessId);
      const existing = this.#one(selectRows(coreTables.threadTurns, { where: { id: observation.turnId } }));
      if (existing && existing.thread_id !== observation.threadId) {
        throw new Error(`Transcript turn ${observation.turnId} changed Workbench thread owner`);
      }
      let turnIndex = existing?.turn_index ?? observation.turnIndex;
      if (turnIndex === undefined) {
        const thread = this.#requiredThread(observation.threadId);
        turnIndex = thread.next_turn_index;
      }
      const thread = this.#requiredThread(observation.threadId);
      if (!existing) {
        this.#run(updateRows(coreTables.workbenchThreads, {
          next_turn_index: Math.max(thread.next_turn_index, turnIndex + 1),
          updated_at: Math.max(thread.updated_at, observation.createdAt),
          activity_at: Math.max(thread.activity_at, observation.createdAt),
        }, { id: observation.threadId }));
      }
      const preservesTerminalState = !insideCanonicalWindow
        && existing
        && existing.state !== "admitted"
        && existing.state !== "inProgress"
        && (observation.state === "admitted" || observation.state === "inProgress");
      this.#run(upsertRow(coreTables.threadTurns, {
        id: observation.turnId,
        thread_id: observation.threadId,
        turn_index: turnIndex,
        harness_id: observation.harnessId,
        native_location: observation.nativeLocation,
        native_thread_id: observation.nativeThreadId,
        native_turn_id: observation.nativeTurnId,
        state: preservesTerminalState ? existing.state : observation.state,
        created_at: observation.createdAt,
        started_at: insideCanonicalWindow ? observation.startedAt : observation.startedAt ?? existing?.started_at ?? null,
        ended_at: insideCanonicalWindow ? observation.endedAt : observation.endedAt ?? existing?.ended_at ?? null,
        duration_ms: insideCanonicalWindow ? observation.durationMs : observation.durationMs ?? existing?.duration_ms ?? null,
      }, {
        conflictColumns: ["id"],
        updateColumns: ["native_turn_id", "state", "started_at", "ended_at", "duration_ms"],
      }));
      if (!insideCanonicalWindow) this.#materializeTurn(observation.threadId, observation.turnId);
      return observation.threadId;
    }
    if (observation.kind === "item") {
      this.#writeItem({
        createTransform: (itemId, sourceRevision) => transformWorkbenchTranscriptItem({
          item: observation.item,
          itemId,
          lifecycle: observation.lifecycle,
          sourceRevision,
        }),
        itemPosition: observation.itemPosition,
        observedAt: observation.observedAt,
        replaceTimeline: insideCanonicalWindow,
        sourceId: observation.item.id,
        timeline: observation.timeline,
        threadId: observation.threadId,
        turnId: observation.turnId,
        allowUnmaterializedTurn: insideCanonicalWindow,
        canonicalIndex,
      });
      return observation.threadId;
    }
    if (observation.kind === "questionnaire") {
      this.#writeItem({
        createTransform: (itemId) => transformQuestionnaireEntry(observation.entry, itemId),
        itemPosition: observation.itemPosition,
        observedAt: observation.observedAt,
        replaceTimeline: insideCanonicalWindow,
        sourceId: resolveQuestionnaireTranscriptSourceId(observation.entry),
        threadId: observation.entry.threadId,
        turnId: observation.entry.turnId,
        allowUnmaterializedTurn: insideCanonicalWindow,
        canonicalIndex,
      });
      return observation.entry.threadId;
    }
    if (observation.kind === "steer") {
      if (observation.entry.status === "pending") return null;
      this.#writeItem({
        createTransform: (itemId) => {
          const transform = transformSteerEntry(observation.entry, itemId);
          if (!transform) throw new Error("Settled steer did not produce a transcript item");
          return transform;
        },
        itemPosition: observation.itemPosition,
        observedAt: observation.observedAt,
        replaceTimeline: insideCanonicalWindow,
        sourceId: resolveSteerTranscriptSourceId(observation.entry),
        threadId: observation.entry.threadId,
        turnId: observation.entry.turnId,
        allowUnmaterializedTurn: insideCanonicalWindow,
        canonicalIndex,
      });
      return observation.entry.threadId;
    }
    if (observation.kind === "browse") {
      this.#writeBrowseEntry(observation, insideCanonicalWindow, canonicalIndex);
      return observation.entry.threadId;
    }
    if (observation.kind === "captureGap") {
      this.#requiredThread(observation.threadId);
      this.#run(upsertRow(evidenceTables.transcriptCaptureGaps, {
        id: observation.gapId,
        thread_id: observation.threadId,
        turn_id: observation.turnId,
        state: observation.state,
        reason: observation.reason,
        opened_at: observation.openedAt,
        closed_at: observation.closedAt,
        error_text: observation.errorText,
      }, {
        conflictColumns: ["id"],
        updateColumns: ["state", "reason", "closed_at", "error_text"],
      }));
      return observation.threadId;
    }
    this.#writeNativeEvidence(observation, canonicalIndex);
    return observation.threadId;
  }

  #writeItem({
    createTransform,
    itemPosition,
    observedAt,
    replaceTimeline,
    sourceId,
    timeline,
    threadId,
    turnId,
    allowUnmaterializedTurn = false,
    canonicalIndex,
  }: {
    allowUnmaterializedTurn?: boolean;
    canonicalIndex?: CanonicalSettlementIndex;
    createTransform: (itemId: number, sourceRevision: number) => WorkbenchTranscriptItemTransform;
    itemPosition?: number;
    observedAt: number;
    replaceTimeline: boolean;
    sourceId: string;
    timeline?: Extract<WorkbenchTranscriptAtomicObservation, { kind: "item" }>["timeline"];
    threadId: string;
    turnId: string;
  }) {
    const turn = canonicalIndex
      ? canonicalIndex.turnsById.get(turnId) ?? null
      : this.#one(selectRows(coreTables.threadTurns, { where: { id: turnId } }));
    if (!turn || turn.thread_id !== threadId) {
      throw new Error(`Transcript item ${sourceId} references an unknown turn owner`);
    }
    const isTurnMaterialized = canonicalIndex
      ? canonicalIndex.materializedTurnIds.has(turnId)
      : this.#isTurnMaterialized(threadId, turnId);
    if (!allowUnmaterializedTurn && !isTurnMaterialized) {
      throw new Error(`Transcript item ${sourceId} references an unmaterialized turn`);
    }
    const existing = canonicalIndex
      ? canonicalIndex.itemsBySourceId.get(sourceId) ?? null
      : this.#one(selectRows(itemTables.threadItems, {
        where: { source_id: sourceId, thread_id: threadId },
      }));
    const existingOwnerTurn = existing?.turn_id === turnId
      ? turn
      : existing
        ? canonicalIndex
          ? canonicalIndex.turnsById.get(existing.turn_id) ?? null
          : this.#one(selectRows(coreTables.threadTurns, { where: { id: existing.turn_id } }))
        : null;
    const stableTurnId = existingOwnerTurn && existingOwnerTurn.turn_index <= turn.turn_index
      ? existingOwnerTurn.id
      : turnId;
    const stableItemPosition = existing
      && stableTurnId === existing.turn_id
      && (turnId !== stableTurnId || itemPosition === undefined)
      ? existing.item_position
      : itemPosition ?? (() => {
      const turnItems = canonicalIndex
        ? [...(canonicalIndex.itemsByTurnId.get(stableTurnId)?.values() ?? [])]
        : this.#all(selectRows(itemTables.threadItems, {
          where: { turn_id: stableTurnId },
          orderBy: [{ column: "item_position" }],
        }));
      return Math.max(-1, ...turnItems.map(({ item_position }) => item_position)) + 1;
    })();
    if (!existing) {
      const thread = canonicalIndex?.thread ?? this.#requiredThread(threadId);
      const updatedAt = Math.max(thread.updated_at, observedAt);
      const activityAt = Math.max(thread.activity_at, observedAt);
      this.#run(updateRows(coreTables.workbenchThreads, {
        updated_at: updatedAt,
        activity_at: activityAt,
      }, { id: threadId }));
      if (canonicalIndex) {
        canonicalIndex.thread = { ...thread, updated_at: updatedAt, activity_at: activityAt };
      }
    }
    let indexedItem = existing;
    const itemId = existing?.id ?? (() => {
      const result = this.#run(insertRow(itemTables.threadItems, {
        source_id: sourceId,
        thread_id: threadId,
        turn_id: stableTurnId,
        item_position: stableItemPosition,
        type: "unknown",
        created_at: observedAt,
        updated_at: observedAt,
      }));
      const allocatedId = Number(result.lastInsertRowid);
      if (!Number.isSafeInteger(allocatedId) || allocatedId <= 0) {
        throw new Error(`Transcript item ${sourceId} received an invalid relational id`);
      }
      if (canonicalIndex) {
        indexedItem = this.#replaceCanonicalItem(canonicalIndex, {
          id: allocatedId,
          source_id: sourceId,
          thread_id: threadId,
          turn_id: stableTurnId,
          item_position: stableItemPosition,
          type: "unknown",
          created_at: observedAt,
          updated_at: observedAt,
        }, {});
      }
      return allocatedId;
    })();
    const existingOperationRevision = canonicalIndex
      ? canonicalIndex.operationRevisionsByItemId.get(itemId) ?? null
      : this.#one(selectRows(operationSourceTables.threadItemOperations, {
        where: { item_id: itemId },
      }))?.source_revision ?? null;
    const transform = createTransform(itemId, (existingOperationRevision ?? -1) + 1);
    if (existing && existing.type !== transform.itemType) {
      throw new Error(`Transcript item ${sourceId} changed type from ${existing.type} to ${transform.itemType}`);
    }
    this.#run(updateRows(itemTables.threadItems, {
      turn_id: stableTurnId,
      item_position: stableItemPosition,
      type: transform.itemType,
      updated_at: observedAt,
    }, { id: itemId }));
    if (canonicalIndex && indexedItem) {
      indexedItem = this.#replaceCanonicalItem(canonicalIndex, indexedItem, {
        turn_id: stableTurnId,
        item_position: stableItemPosition,
        type: transform.itemType,
        updated_at: observedAt,
      });
    }
    this.#writeItemTimeline(itemId, timeline, replaceTimeline, canonicalIndex);
    this.#runAll(transform.cleanup);
    this.#runAll(transform.mutations);
    if (canonicalIndex) {
      for (const mutation of transform.mutations) {
        if (
          mutation.tableName === operationSourceTables.threadItemOperations.name
          && (mutation.kind === "insert" || mutation.kind === "upsert")
        ) {
          const revision = mutation.values.find(([column]) => column === "source_revision")?.[1];
          if (typeof revision === "number") {
            canonicalIndex.operationRevisionsByItemId.set(itemId, revision);
          }
          break;
        }
      }
    }
  }

  #writeItemTimeline(
    itemId: number,
    timeline: Extract<WorkbenchTranscriptAtomicObservation, { kind: "item" }>["timeline"],
    replace: boolean,
    canonicalIndex?: CanonicalSettlementIndex,
  ) {
    if (!timeline && !replace) return;
    const existing = canonicalIndex
      ? canonicalIndex.timelinesByItemId.get(itemId) ?? null
      : this.#one(selectRows(itemTables.threadItemTimelines, { where: { item_id: itemId } }));
    const existingAliases = existing
      ? canonicalIndex
        ? canonicalIndex.timelineAliasesByItemId.get(itemId) ?? []
        : this.#all(selectRows(itemTables.threadItemTimelineAliases, { where: { item_id: itemId } }))
          .map(({ alias }) => alias)
      : [];
    this.#run(deleteRows(itemTables.threadItemTimelines, { item_id: itemId }));
    canonicalIndex?.timelinesByItemId.delete(itemId);
    canonicalIndex?.timelineAliasesByItemId.delete(itemId);
    if (!timeline) return;
    const merged = replace || !existing
      ? {
        completedAt: timeline.completedAt,
        firstSeenAt: timeline.firstSeenAt,
        lastSeenAt: timeline.lastSeenAt,
        startedAt: timeline.startedAt,
      }
      : {
        completedAt: latestTimestamp(existing.completed_at, timeline.completedAt),
        firstSeenAt: earliestTimestamp(existing.first_seen_at, timeline.firstSeenAt),
        lastSeenAt: latestTimestamp(existing.last_seen_at, timeline.lastSeenAt),
        startedAt: earliestTimestamp(existing.started_at, timeline.startedAt),
      };
    this.#run(insertRow(itemTables.threadItemTimelines, {
      item_id: itemId,
      first_seen_at: merged.firstSeenAt,
      last_seen_at: merged.lastSeenAt,
      started_at: merged.startedAt,
      completed_at: merged.completedAt,
    }));
    canonicalIndex?.timelinesByItemId.set(itemId, {
      item_id: itemId,
      first_seen_at: merged.firstSeenAt,
      last_seen_at: merged.lastSeenAt,
      started_at: merged.startedAt,
      completed_at: merged.completedAt,
    });
    const aliases = replace
      ? timeline.aliases ?? []
      : Array.from(new Set([...existingAliases, ...(timeline.aliases ?? [])]));
    for (const alias of aliases) {
      this.#run(insertRow(itemTables.threadItemTimelineAliases, {
        item_id: itemId,
        alias,
      }));
    }
    canonicalIndex?.timelineAliasesByItemId.set(itemId, aliases);
  }

  #writeBrowseEntry(
    observation: Extract<WorkbenchTranscriptObservation, { kind: "browse" }>,
    allowUnmaterializedTurn = false,
    canonicalIndex?: CanonicalSettlementIndex,
  ) {
    const { asset, entry } = observation;
    const turn = canonicalIndex
      ? canonicalIndex.turnsById.get(entry.turnId) ?? null
      : this.#one(selectRows(coreTables.threadTurns, { where: { id: entry.turnId } }));
    if (!turn || turn.thread_id !== entry.threadId) {
      throw new Error(`Browse entry ${entry.entryKey} references an unknown turn owner`);
    }
    const isTurnMaterialized = canonicalIndex
      ? canonicalIndex.materializedTurnIds.has(entry.turnId)
      : this.#isTurnMaterialized(entry.threadId, entry.turnId);
    if (!allowUnmaterializedTurn && !isTurnMaterialized) {
      throw new Error(`Browse entry ${entry.entryKey} references an unmaterialized turn`);
    }
    if (asset) {
      const existingAsset = this.#one(selectRows(evidenceTables.transcriptAssets, { where: { digest: asset.digest } }));
      if (existingAsset && (
        existingAsset.byte_length !== asset.byteLength
        || existingAsset.mime_type !== asset.mimeType
        || existingAsset.storage_key !== asset.storageKey
      )) {
        throw new Error(`Transcript asset ${asset.digest} changed content-addressed metadata`);
      }
      if (!existingAsset) {
        this.#run(insertRow(evidenceTables.transcriptAssets, {
          digest: asset.digest,
          mime_type: asset.mimeType,
          byte_length: asset.byteLength,
          storage_key: asset.storageKey,
          created_at: entry.recordedAt,
        }));
      }
    }
    const sourceItem = entry.commandItemId
      ? canonicalIndex
        ? canonicalIndex.itemsBySourceId.get(entry.commandItemId) ?? null
        : this.#one(selectRows(itemTables.threadItems, {
          where: { source_id: entry.commandItemId, thread_id: entry.threadId },
        }))
      : null;
    const operation = sourceItem
      ? canonicalIndex
        ? canonicalIndex.operationRevisionsByItemId.has(sourceItem.id)
        : this.#one(selectRows(operationSourceTables.threadItemOperations, { where: { item_id: sourceItem.id } }))
      : null;
    if (!entry.commandItemId || !sourceItem || !operation) {
      this.#writeNativeEvidence({
        kind: "nativeEvidence",
        harnessId: turn.harness_id,
        nativeLocation: turn.native_location,
        nativeThreadId: turn.native_thread_id,
        nativeTurnId: turn.native_turn_id,
        nativeItemId: entry.commandItemId,
        nativeEventId: entry.entryKey,
        clientId: null,
        nativeSequence: String(entry.actionIndex),
        recordKind: "event",
        payloadJson: JSON.stringify(entry),
        recordedAt: entry.recordedAt,
        threadId: entry.threadId,
        turnId: entry.turnId,
        itemId: null,
      });
      return;
    }
    this.#run(upsertRow(evidenceTables.threadBrowseEntries, {
      entry_key: entry.entryKey,
      item_id: sourceItem.id,
      action_index: entry.actionIndex,
      action: entry.action,
      state: entry.state,
      session_name: entry.session,
      detail_kind: entry.detailKind ?? null,
      detail_label: entry.detailLabel ?? null,
      detail_text: entry.detailText ?? null,
      duration_ms: entry.durationMs,
      asset_digest: asset?.digest ?? null,
      recorded_at: entry.recordedAt,
    }, {
      conflictColumns: ["entry_key"],
      updateColumns: [
        "state",
        "session_name",
        "detail_kind",
        "detail_label",
        "detail_text",
        "duration_ms",
        "asset_digest",
        "recorded_at",
      ],
    }));
  }

  #writeNativeEvidence(
    observation: Extract<WorkbenchTranscriptObservation, { kind: "nativeEvidence" }>,
    canonicalIndex?: CanonicalSettlementIndex,
  ) {
    this.#ensureHarness(observation.harnessId);
    const linkKind = observation.itemId ? "item" : observation.turnId ? "turn" : "orphan";
    const item = observation.itemId && observation.threadId
      ? canonicalIndex
        ? canonicalIndex.itemsBySourceId.get(observation.itemId) ?? null
        : this.#one(selectRows(itemTables.threadItems, {
          where: { source_id: observation.itemId, thread_id: observation.threadId },
        }))
      : null;
    if (linkKind === "item" && !item) {
      throw new Error(`Native transcript evidence references unknown item ${observation.itemId}`);
    }
    this.#run(insertRow(evidenceTables.transcriptNativeRecords, {
      link_kind: linkKind,
      thread_id: observation.threadId,
      turn_id: observation.turnId,
      item_id: item?.id ?? null,
      harness_id: observation.harnessId,
      native_location: observation.nativeLocation,
      native_thread_id: observation.nativeThreadId,
      record_kind: observation.recordKind,
      orphan_native_turn_id: linkKind === "orphan" ? observation.nativeTurnId : null,
      native_item_id: observation.nativeItemId,
      native_event_id: observation.nativeEventId,
      client_id: observation.clientId,
      native_sequence: observation.nativeSequence,
      payload_json: observation.payloadJson,
      recorded_at: observation.recordedAt,
    }));
  }

  #readRows(threadId: string, itemIds: number[]): WorkbenchTranscriptSnapshotRows {
    const itemRows = <
      Table extends CurrentTableDefinition & {
        columns: { item_id: ColumnDefinition<number, boolean, boolean> };
      },
    >(table: Table) => this.#rowsByItemIds(table, itemIds);
    const transcriptAssetRefs = [
      ...this.#all(selectRows(evidenceTables.transcriptAssetRefs, { where: { thread_id: threadId } })),
      ...itemRows(evidenceTables.transcriptAssetRefs),
    ];
    const assetDigests = new Set(
      transcriptAssetRefs.map(({ asset_digest }) => asset_digest),
    );
    const threadBrowseEntries = itemRows(evidenceTables.threadBrowseEntries);
    for (const { asset_digest } of threadBrowseEntries) {
      if (asset_digest) assetDigests.add(asset_digest);
    }
    return {
      threadItems: [],
      threadItemTimelines: itemRows(itemTables.threadItemTimelines),
      threadItemTimelineAliases: itemRows(itemTables.threadItemTimelineAliases),
      threadItemUserMessages: itemRows(itemTables.threadItemUserMessages),
      threadUserMessageParts: itemRows(itemTables.threadUserMessageParts),
      threadItemAssistantMessages: itemRows(itemTables.threadItemAssistantMessages),
      threadItemPlans: itemRows(itemTables.threadItemPlans),
      threadItemReasoning: itemRows(itemTables.threadItemReasoning),
      threadReasoningSections: itemRows(itemTables.threadReasoningSections),
      threadItemFileChanges: itemRows(itemTables.threadItemFileChanges),
      threadFileChanges: itemRows(itemTables.threadFileChanges),
      threadItemContextCompactions: itemRows(itemTables.threadItemContextCompactions),
      threadItemUnknown: itemRows(itemTables.threadItemUnknown),
      threadItemOperations: itemRows(operationSourceTables.threadItemOperations),
      threadOperationProcessSources: itemRows(operationSourceTables.threadOperationProcessSources),
      threadProcessCommandActions: itemRows(operationSourceTables.threadProcessCommandActions),
      threadOperationToolSources: itemRows(operationSourceTables.threadOperationToolSources),
      threadOperationCallableToolSources: itemRows(operationSourceTables.threadOperationCallableToolSources),
      threadCallableDynamicContent: itemRows(operationSourceTables.threadCallableDynamicContent),
      threadCallableMcpResults: itemRows(operationSourceTables.threadCallableMcpResults),
      threadCallableMcpResultContent: itemRows(operationSourceTables.threadCallableMcpResultContent),
      threadOperationCollaborationToolSources: itemRows(operationSourceTables.threadOperationCollaborationToolSources),
      threadCollaborationReceivers: itemRows(operationSourceTables.threadCollaborationReceivers),
      threadCollaborationAgentStates: itemRows(operationSourceTables.threadCollaborationAgentStates),
      threadItemWebSearches: itemRows(interactionTables.threadItemWebSearches),
      threadWebSearchQueries: itemRows(interactionTables.threadWebSearchQueries),
      threadWebSearchResults: itemRows(interactionTables.threadWebSearchResults),
      threadItemInteractions: itemRows(interactionTables.threadItemInteractions),
      threadInteractionQuestions: itemRows(interactionTables.threadInteractionQuestions),
      threadInteractionOptions: itemRows(interactionTables.threadInteractionOptions),
      threadInteractionAnswers: itemRows(interactionTables.threadInteractionAnswers),
      threadApprovalCommandContexts: itemRows(interactionTables.threadApprovalCommandContexts),
      threadApprovalCommandActions: itemRows(interactionTables.threadApprovalCommandActions),
      threadBrowseEntries,
      transcriptAssetRefs,
      transcriptAssets: this.#all(selectRows(evidenceTables.transcriptAssets, {
        whereIn: { digest: [...assetDigests] },
      })),
    };
  }

  #rowsByItemIds<
    Table extends CurrentTableDefinition & {
      columns: { item_id: ColumnDefinition<number, boolean, boolean> };
    },
  >(table: Table, itemIds: number[]) {
    const rows: SelectRow<Table>[] = [];
    for (let offset = 0; offset < itemIds.length; offset += SQLITE_ITEM_ID_BATCH_SIZE) {
      rows.push(...this.#all(selectRows(table, {
        whereIn: {
          item_id: itemIds.slice(offset, offset + SQLITE_ITEM_ID_BATCH_SIZE),
        } as WorkbenchDatabaseRowInFilter<Table>,
      })));
    }
    return rows;
  }

  #ensureHarness(harnessId: string) {
    const existing = this.#one(selectRows(coreTables.workbenchHarnesses, { where: { id: harnessId } }));
    if (!existing) this.#run(insertRow(coreTables.workbenchHarnesses, { id: harnessId }));
  }

  #requiredThread(threadId: string) {
    const thread = this.#one(selectRows(coreTables.workbenchThreads, { where: { id: threadId } }));
    if (!thread) throw new Error(`Unknown Workbench transcript thread: ${threadId}`);
    return thread;
  }

  #requiredTurn(turnId: string) {
    const turn = this.#one(selectRows(coreTables.threadTurns, { where: { id: turnId } }));
    if (!turn) throw new Error(`Unknown Workbench transcript turn: ${turnId}`);
    return turn;
  }

  #isTurnMaterialized(threadId: string, turnId: string) {
    return this.#one(selectRows(coreTables.threadTurnMaterializations, {
      where: { thread_id: threadId, turn_id: turnId },
    })) !== null;
  }

  #materializeTurn(
    threadId: string,
    turnId: string,
    canonicalIndex?: CanonicalSettlementIndex,
  ) {
    this.#run(upsertRow(coreTables.threadTurnMaterializations, {
      turn_id: turnId,
      thread_id: threadId,
      materialized_at: Date.now(),
    }, {
      conflictColumns: ["turn_id"],
      updateColumns: ["materialized_at"],
    }));
    canonicalIndex?.materializedTurnIds.add(turnId);
  }

  #itemObservationId(observation: WorkbenchTranscriptAtomicObservation) {
    if (observation.kind === "item") return observation.item.id;
    if (observation.kind === "questionnaire") return resolveQuestionnaireTranscriptSourceId(observation.entry);
    if (observation.kind === "steer") {
      return observation.entry.status === "pending"
        ? null
        : resolveSteerTranscriptSourceId(observation.entry);
    }
    return null;
  }

  #itemObservationTurnId(observation: WorkbenchTranscriptAtomicObservation) {
    if (observation.kind === "item") return observation.turnId;
    if (observation.kind === "questionnaire" || observation.kind === "steer") return observation.entry.turnId;
    return null;
  }

  #withItemPosition(
    observation: WorkbenchTranscriptAtomicObservation,
    itemPosition: number,
  ): WorkbenchTranscriptAtomicObservation {
    if (
      observation.kind === "item"
      || observation.kind === "questionnaire"
      || observation.kind === "steer"
    ) {
      return { ...observation, itemPosition };
    }
    throw new Error(`Transcript observation ${observation.kind} is not an item`);
  }

  #runAll(statements: readonly WorkbenchDatabaseMutation[]) {
    for (const statement of statements) this.#run(statement);
  }

  #run(statement: WorkbenchDatabaseMutation) {
    const compiled = compileWorkbenchDatabaseStatement(workbenchDatabaseTables, statement);
    return this.#database.prepare(compiled.sql).run(...compiled.parameters);
  }

  #all<Row extends WorkbenchDatabaseRow>(statement: WorkbenchDatabaseQuery<Row>): Row[] {
    const compiled = compileWorkbenchDatabaseStatement(workbenchDatabaseTables, statement);
    return this.#database.prepare(compiled.sql).all(...compiled.parameters) as Row[];
  }

  #one<Row extends WorkbenchDatabaseRow>(statement: WorkbenchDatabaseQuery<Row>): Row | null {
    return this.#all(statement)[0] ?? null;
  }
}
