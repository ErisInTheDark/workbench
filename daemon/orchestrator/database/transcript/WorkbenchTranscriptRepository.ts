/*
 * Exports:
 * - default WorkbenchTranscriptRepository: own atomic settlement, cumulative usage facts, provider reconciliation, and bounded reads. Keywords: transcript, repository, usage, provider, transaction.
 * Local helpers: classify timestamps, provider projection items, enrichment, and one transaction-local canonical item index. Keywords: transcript, item, timeline, projection, index.
 */
import type Database from "better-sqlite3";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository.ts";
import WorkbenchTranscriptIdentityRepository from "./WorkbenchTranscriptIdentityRepository.ts";
import { usageTables } from "workbench-shared/workbench/database/schema/usage-schema";
import { transcriptIdentityTables } from "workbench-shared/workbench/database/schema/transcript-identity-schema";

import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import { getCodexItemIdentityKind } from "workbench-shared/codex/thread-item-source";
import {
  mergeThreadItem,
  reconcileCompleteThreadItems,
} from "workbench-shared/codex/thread-item-normalization";
import { SYNTHETIC_STEER_HISTORY_ITEM_ID_PREFIX } from "workbench-shared/workbench/thread/thread-steer-history";
import { SYNTHETIC_QUESTIONNAIRE_HISTORY_ITEM_ID_PREFIX } from "workbench-shared/workbench/thread/thread-questionnaire-identity";
import type { WorkbenchFileChangeItem } from "workbench-shared/workbench/thread/workbench-file-change";
import { readWorkbenchToolOutput } from "workbench-shared/workbench/thread/thread-tool-output";
import type { WorkbenchThreadItemTimelineEntry } from "workbench-shared/workbench/thread/thread-item-timeline";
import {
  projectWorkbenchTranscriptItems,
  projectWorkbenchToolOutput,
  projectWorkbenchFileChange,
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

const SQLITE_ITEM_ID_BATCH_SIZE = 500;

type TableRow<Table extends CurrentTableDefinition> = SelectRow<Table>;
type TranscriptThreadRow = TableRow<typeof coreTables.workbenchThreads>;
type TranscriptTurnRow = TableRow<typeof coreTables.threadTurns>;
type TranscriptItemRow = TableRow<typeof itemTables.threadItems>;
type TranscriptTimelineRow = TableRow<typeof itemTables.threadItemTimelines>;

interface CanonicalSettlementIndex {
  readonly legacyItemsBySourceId: Map<string, TranscriptItemRow>;
  readonly itemsByPublicId: Map<string, TranscriptItemRow>;
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
  readonly #identity: WorkbenchThreadIdentityRepository;
  readonly #itemIdentity: WorkbenchTranscriptIdentityRepository;

  constructor(database: Database.Database, identity = new WorkbenchThreadIdentityRepository(database)) {
    this.#database = database;
    this.#identity = identity;
    this.#itemIdentity = new WorkbenchTranscriptIdentityRepository(database);
  }

  settle(observations: readonly WorkbenchTranscriptObservation[]): WorkbenchTranscriptSettlement {
    const changedThreadIds = new Set<string>();
    this.#database.transaction(() => {
      for (const observation of observations) {
        const threadId = observation.kind === "canonicalWindow"
          ? this.#settleCanonicalWindow(observation)
          : observation.kind === "usageWindow"
            ? this.#settleUsageWindow(observation)
          : observation.kind === "turnCatalog"
            ? this.#settleTurnCatalog(observation)
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
      let thread = this.#one(selectRows(coreTables.workbenchThreads, {
        where: { id: request.threadId },
      }));
      if (!thread) {
        const identity = this.#identity.resolve({ threadId: request.threadId });
        if (identity) thread = this.#requiredThread(identity.threadId);
      }
      if (!thread) return null;
      const threadId = thread.id;
      const turns = this.#all(selectRows(coreTables.threadTurns, {
        where: { thread_id: threadId },
        orderBy: [{ column: "turn_index" }],
      }));
      const eligibleTurns = request.beforeTurnIndex === undefined
        ? turns
        : turns.filter((turn) => turn.turn_index < request.beforeTurnIndex!);
      const currentTurnIds = new Set(turns.map(({ id }) => id));
      const requestedTurnIds = request.turnIds ? new Set(request.turnIds.map((turnId) => (
        thread.identity_origin === "workbench" && !currentTurnIds.has(turnId)
          ? this.#identity.resolveTurn({ threadId, turnId })?.turnId ?? turnId
          : turnId
      ))) : null;
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
      let loadedTurnIds = loadedTurns.map(({ id }) => id);
      const materializations = this.#all(selectRows(coreTables.threadTurnMaterializations, {
        where: { thread_id: threadId },
      }));
      const materializedTurnIds = new Set(materializations.map(({ turn_id }) => turn_id));
      if (loadedTurnIds.some((turnId) => !materializedTurnIds.has(turnId))) return null;
      if (thread.identity_origin === "workbench") {
        const loadedIndexes = new Map(loadedTurns.map(({ id }, index) => [id, index]));
        for (const [index, turn] of turns.entries()) {
          if (turn.identity_origin !== "legacy") continue;
          const identity = this.#identity.resolveTurn({ threadId, turnId: turn.id })!;
          const replacement = { ...turn, id: identity.turnId, identity_origin: "workbench" as const };
          turns[index] = replacement;
          const loadedIndex = loadedIndexes.get(turn.id);
          if (loadedIndex !== undefined) loadedTurns[loadedIndex] = replacement;
        }
        loadedTurnIds = loadedTurns.map(({ id }) => id);
      }
      const firstLoadedTurnIndex = loadedTurns[0]?.turn_index;
      const threadItems = this.#all(selectRows(itemTables.threadItems, {
        whereIn: { turn_id: loadedTurnIds },
        orderBy: [{ column: "item_position" }],
      }));
      this.#promoteLegacyToolOutputs(threadItems);
      if (thread.identity_origin === "workbench") this.#admitRetainedItems(threadItems, loadedTurns);
      const rows = this.#readRows(threadId, threadItems);
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

  #admitRetainedItems(items: TranscriptItemRow[], turns: TranscriptTurnRow[]) {
    const retained = items.flatMap((item, index) => item.public_id === null ? [{ item, index }] : []);
    if (!retained.length) return;
    const turnById = new Map(turns.map((turn) => [turn.id, turn]));
    const ids = retained.map(({ item }) => item.id);
    const userMessages = new Map(this.#rowsByItemIds(itemTables.threadItemUserMessages, ids).map((row) => [row.item_id, row]));
    const aliases = new Map<number, string[]>();
    for (const row of this.#rowsByItemIds(itemTables.threadItemTimelineAliases, ids)) {
      const values = aliases.get(row.item_id) ?? [];
      values.push(row.alias);
      aliases.set(row.item_id, values);
    }
    for (const { item, index } of retained) {
      const turn = turnById.get(item.turn_id)!;
      const userMessage = userMessages.get(item.id);
      const identity = this.#itemIdentity.admit({
        threadId: item.thread_id,
        sources: [
          { turnId: item.turn_id, sourceId: item.source_id,
            kind: turn.harness_id === "codex" ? getCodexItemIdentityKind({ id: item.source_id }) : "stable" },
          ...(userMessage?.client_id ? [{ turnId: item.turn_id, sourceId: userMessage.client_id, kind: "client" as const }] : []),
        ],
        legacyAliases: [...new Set([
          item.source_id,
          ...aliases.get(item.id) ?? [],
          ...(item.type === "questionnaire" || item.type === "approval"
            ? [`${SYNTHETIC_QUESTIONNAIRE_HISTORY_ITEM_ID_PREFIX}${item.source_id}`] : []),
        ])]
          .map((alias) => ({ turnId: item.turn_id, alias })),
      });
      this.#run(updateRows(itemTables.threadItems, { public_id: identity.itemId }, { id: item.id }));
      // Old source formats are interpreted only while converting the retained row.
      if (userMessage && item.source_id.startsWith(SYNTHETIC_STEER_HISTORY_ITEM_ID_PREFIX)) {
        this.#run(updateRows(itemTables.threadItemUserMessages, { input_kind: "steer" }, { item_id: item.id }));
      }
      items[index] = { ...item, public_id: identity.itemId };
    }
  }

  readMaterializedTurnIds(threadId: string, turnIds: readonly string[]) {
    const requestedTurnIds = [...new Set(turnIds)];
    if (requestedTurnIds.length === 0) return [];
    const thread = this.#one(selectRows(coreTables.workbenchThreads, { where: { id: threadId } }));
    if (!thread) threadId = this.#identity.resolve({ threadId })?.threadId ?? threadId;
    const resolvedTurnIds = new Map(requestedTurnIds.map((turnId) => {
      const alias = this.#one(selectRows(transcriptIdentityTables.turnLegacyAliases, { where: { thread_id: threadId, alias: turnId } }));
      return [turnId, alias?.turn_id ?? turnId];
    }));
    const materializations = this.#all(selectRows(coreTables.threadTurnMaterializations, {
      where: { thread_id: threadId },
      whereIn: { turn_id: [...resolvedTurnIds.values()] },
    }));
    const materializedTurnIds = new Set(materializations.map(({ turn_id }) => turn_id));
    return requestedTurnIds.filter((turnId) => materializedTurnIds.has(resolvedTurnIds.get(turnId)!));
  }

  #promoteLegacyToolOutputs(items: TranscriptItemRow[]) {
    const roots = new Map(items.flatMap((item, index) => item.type === "unknown" ? [[item.id, { item, index }] as const] : []));
    for (const row of this.#rowsByItemIds(itemTables.threadItemUnknown, [...roots.keys()])) {
      if (row.native_type !== "functionCallOutput") continue;
      const parsed = readWorkbenchToolOutput(JSON.parse(row.safe_json));
      const { item: root, index } = roots.get(row.item_id)!;
      if (!parsed || parsed.id !== root.source_id) continue;
      this.#settleObservation({
        kind: "item", item: parsed, threadId: root.thread_id, turnId: root.turn_id,
        lifecycle: "completed", observedAt: root.updated_at, itemPosition: root.item_position,
      });
      items[index] = { ...root, type: "functionCallOutput" };
    }
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
      legacyItemsBySourceId: new Map(items.filter((item) => item.public_id === null).map((item) => [item.source_id, item])),
      itemsByPublicId: new Map(items.flatMap((item) => item.public_id === null ? [] : [[item.public_id, item] as const])),
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
    if (existing.public_id === null) index.legacyItemsBySourceId.delete(existing.source_id);
    else index.itemsByPublicId.delete(existing.public_id);
    if (replacement.public_id === null) index.legacyItemsBySourceId.set(replacement.source_id, replacement);
    else index.itemsByPublicId.set(replacement.public_id, replacement);
    if (existing.turn_id !== replacement.turn_id) {
      index.itemsByTurnId.get(existing.turn_id)?.delete(existing.id);
    }
    const turnItems = index.itemsByTurnId.get(replacement.turn_id) ?? new Map<number, TranscriptItemRow>();
    turnItems.set(replacement.id, replacement);
    index.itemsByTurnId.set(replacement.turn_id, turnItems);
    return replacement;
  }

  #deleteCanonicalItem(index: CanonicalSettlementIndex, item: TranscriptItemRow) {
    this.#run(updateRows(evidenceTables.transcriptNativeRecords, {
      link_kind: "turn", item_id: null,
    }, { item_id: item.id }));
    this.#run(deleteRows(itemTables.threadItems, { id: item.id }));
    if (item.public_id === null) index.legacyItemsBySourceId.delete(item.source_id);
    else index.itemsByPublicId.delete(item.public_id);
    index.itemsByTurnId.get(item.turn_id)?.delete(item.id);
    index.operationRevisionsByItemId.delete(item.id);
    index.timelinesByItemId.delete(item.id);
    index.timelineAliasesByItemId.delete(item.id);
  }

  #providerReplacementEnrichedItemIds(existingItems: readonly TranscriptItemRow[]) {
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
      if (row.input_kind === "steer" || (row.client_id && sourceId && !/^item-\d+$/u.test(sourceId))) {
        protectedItemIds.add(row.item_id);
      }
    }
    for (const row of this.#rowsByItemIds(itemTables.threadItemFileChanges, itemIds)) {
      if (row.workbench_failure_kind || row.workbench_policy || row.recovery_state) protectedItemIds.add(row.item_id);
    }
    for (const row of this.#rowsByItemIds(itemTables.threadFileChanges, itemIds)) {
      if (row.analysis_outcome) protectedItemIds.add(row.item_id);
    }
    for (const row of this.#rowsByItemIds(itemTables.threadItemUnknown, itemIds)) {
      if (row.native_type === "workbenchSteer") protectedItemIds.add(row.item_id);
    }
    for (const row of this.#rowsByItemIds(evidenceTables.threadBrowseEntries, itemIds)) {
      protectedItemIds.add(row.item_id);
    }
    for (const row of this.#rowsByItemIds(itemTables.threadItemToolOutputs, itemIds)) {
      if (row.injection_accepted_at !== null) protectedItemIds.add(row.item_id);
    }
    return protectedItemIds;
  }

  #providerReplacementTimeline(
    index: CanonicalSettlementIndex,
    itemId: string,
    observation: Extract<WorkbenchTranscriptAtomicObservation, { kind: "item" }>,
    aliases: readonly string[],
  ): WorkbenchThreadItemTimelineEntry | undefined {
    const existingItem = index.itemsByPublicId.get(itemId) ?? index.legacyItemsBySourceId.get(itemId);
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

  #mergeCanonicalItemIdentity(
    index: CanonicalSettlementIndex,
    threadId: string,
    turnId: string,
    fromItemId: string,
    toItemId: string,
  ) {
    if (fromItemId === toItemId) return;
    const source = index.itemsByPublicId.get(fromItemId);
    const target = index.itemsByPublicId.get(toItemId);
    if (source) {
      if (source.turn_id !== turnId || (target && target.turn_id !== turnId)) {
        throw new Error("Same-fact body reconciliation crossed turn ownership.");
      }
      if (target) {
        this.#run(updateRows(evidenceTables.transcriptNativeRecords, {
          item_id: target.id,
        }, { item_id: source.id }));
        this.#run(updateRows(evidenceTables.transcriptAssetRefs, {
          item_id: target.id,
        }, { item_id: source.id }));
        const timeline = index.timelinesByItemId.get(source.id);
        this.#writeItemTimeline(target.id, {
          itemId: toItemId,
          firstSeenAt: timeline?.first_seen_at ?? source.created_at,
          lastSeenAt: timeline?.last_seen_at ?? source.updated_at,
          startedAt: timeline?.started_at ?? null,
          completedAt: timeline?.completed_at ?? null,
          aliases: [...(index.timelineAliasesByItemId.get(source.id) ?? []), fromItemId],
        }, false, index);
        this.#deleteCanonicalItem(index, source);
      } else {
        this.#run(updateRows(itemTables.threadItems, { public_id: toItemId }, { id: source.id }));
        this.#replaceCanonicalItem(index, source, { public_id: toItemId });
      }
    }
    this.#itemIdentity.merge({ threadId, turnId, fromItemId, toItemId });
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
      )).map((observation) => {
        if (!observation.publicItemId) return observation;
        const identity = this.#itemIdentity.resolve({
          threadId: scope.threadId, turnId, itemId: observation.publicItemId,
        });
        if (!identity) throw new Error("Provider scope references an item identity that was not admitted.");
        return identity.itemId === observation.publicItemId
          ? observation
          : { ...observation, publicItemId: identity.itemId };
      });
      const incomingSourceIds = itemObservations.map(({ item }) => item.id);
      if (new Set(incomingSourceIds).size !== incomingSourceIds.length) {
        throw new Error(`Complete provider turn ${turnId} contains duplicate source item ids`);
      }
      const existingItems = [...(index.itemsByTurnId.get(turnId)?.values() ?? [])]
        .sort((left, right) => left.item_position - right.item_position);
      if (index.thread.identity_origin === "workbench" && existingItems.some((item) => item.public_id === null)) {
        this.#promoteLegacyToolOutputs(existingItems);
        this.#admitRetainedItems(existingItems, [...index.turnsById.values()]);
        for (const item of existingItems) {
          const prior = index.itemsByTurnId.get(turnId)!.get(item.id)!;
          if (prior !== item) this.#replaceCanonicalItem(index, prior, item);
        }
      }
      const enrichedItemIds = this.#providerReplacementEnrichedItemIds(existingItems);
      const rows = this.#readRows(scope.threadId, existingItems);
      const projection = projectWorkbenchTranscriptItems(rows);
      if ("issues" in projection) {
        const issues = projection.issues.map(({ code, itemId, table }) => (
          `${code}:${table}${itemId ? `:${itemId}` : ""}`
        )).join(", ");
        throw new Error(`Complete provider turn ${turnId} could not project current items: ${issues}`);
      }
      const projectedByItemId = new Map(projection.data.map(({ item }) => [item.id, item]));
      const currentProviderItems = projection.data.flatMap(({ item, root }) => (
        isProviderProjectionItem(item)
        && !root.source_id.startsWith(SYNTHETIC_STEER_HISTORY_ITEM_ID_PREFIX)
          ? [item]
          : []
      ));
      const incomingObservationById = new Map(itemObservations.map((observation) => [
        observation.publicItemId ?? observation.item.id,
        observation,
      ]));
      const reconciledItems = reconcileCompleteThreadItems(
        currentProviderItems,
        itemObservations.map(({ item, publicItemId }) => publicItemId ? { ...item, id: publicItemId } : item),
        { mergeDuplicateItems: mergeThreadItem },
      ).map((entry) => {
        const existingRoot = index.itemsByPublicId.get(entry.item.id) ?? index.legacyItemsBySourceId.get(entry.item.id);
        if (!existingRoot || !enrichedItemIds.has(existingRoot.id)) return entry;
        const existingItem = projectedByItemId.get(existingRoot.public_id ?? existingRoot.source_id);
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
      const desiredItemIds = reconciledItems.map(({ item }) => item.id);
      if (new Set(desiredItemIds).size !== desiredItemIds.length) {
        throw new Error(`Complete provider turn ${turnId} reconciled duplicate item ids`);
      }
      const desiredItemIdSet = new Set(desiredItemIds);
      for (const entry of reconciledItems) {
        if (!incomingObservationById.get(entry.incomingItemId)?.publicItemId) continue;
        for (const alias of entry.aliases) {
          const source = this.#itemIdentity.resolve({ threadId: scope.threadId, turnId, itemId: alias });
          if (!source) throw new Error(`Reconciliation alias has no admitted identity: ${alias}`);
          this.#mergeCanonicalItemIdentity(index, scope.threadId, turnId, source.itemId, entry.item.id);
        }
      }
      const survivingItemIdByEvidenceId = new Map<string, string>();
      for (const entry of reconciledItems) {
        survivingItemIdByEvidenceId.set(entry.item.id, entry.item.id);
        survivingItemIdByEvidenceId.set(entry.incomingItemId, entry.item.id);
        for (const alias of entry.aliases) {
          survivingItemIdByEvidenceId.set(alias, entry.item.id);
        }
      }
      for (const existingItem of existingItems) {
        const itemId = existingItem.public_id ?? existingItem.source_id;
        if (
          !desiredItemIdSet.has(itemId)
          && survivingItemIdByEvidenceId.has(itemId)
        ) {
          if (existingItem.public_id) {
            const retained = index.itemsByPublicId.get(existingItem.public_id);
            if (retained) this.#deleteCanonicalItem(index, retained);
          } else {
            this.#deleteCanonicalItem(index, existingItem);
          }
        }
      }
      const existingEntries: Array<
        | {
          entry: (typeof reconciledItems)[number];
          kind: "provider";
          observation: Extract<WorkbenchTranscriptAtomicObservation, { kind: "item" }>;
        }
        | { item: TranscriptItemRow; kind: "preserved" }
      > = [];
      const providerEntries = reconciledItems.map((entry) => {
        const observation = incomingObservationById.get(entry.incomingItemId);
        if (!observation) {
          throw new Error(`Complete provider turn ${turnId} lost incoming item ${entry.incomingItemId}`);
        }
        return { entry, kind: "provider" as const, observation };
      });
      const providerEntriesById = new Map(providerEntries.map((entry) => [entry.entry.item.id, entry]));
      const existingItemIds = new Set(existingItems.map((item) => item.public_id ?? item.source_id));
      const existingPositionsById = new Map<string, number>();
      for (const item of existingItems) {
        const itemId = item.public_id ?? item.source_id;
        const survivorId = survivingItemIdByEvidenceId.get(itemId);
        if (!survivorId) {
          existingEntries.push({ item, kind: "preserved" });
          continue;
        }
        // A surviving body keeps its own slot, not a duplicate or aggregate's slot.
        if (survivorId !== itemId && existingItemIds.has(survivorId)) continue;
        if (existingPositionsById.has(survivorId)) continue;
        const replacement = providerEntriesById.get(survivorId);
        if (!replacement) throw new Error(`Provider reconciliation lost surviving item ${survivorId}`);
        existingPositionsById.set(survivorId, existingEntries.length);
        existingEntries.push(replacement);
      }
      const insertions = Array.from(
        { length: existingEntries.length + 1 },
        (): (typeof providerEntries)[number][] => [],
      );
      let previousPosition = -1;
      let pendingInsertions: (typeof providerEntries)[number][] = [];
      for (const entry of providerEntries) {
        const position = existingPositionsById.get(entry.entry.item.id);
        if (position === undefined) {
          pendingInsertions.push(entry);
          continue;
        }
        // Only adjacent known items prove a complete gap, including a missing prefix.
        const insertionPosition = position === previousPosition + 1 ? position : existingEntries.length;
        insertions[insertionPosition]!.push(...pendingInsertions);
        pendingInsertions = [];
        previousPosition = position;
      }
      insertions[existingEntries.length]!.push(...pendingInsertions);
      const finalEntries = existingEntries.flatMap((entry, position) => [...insertions[position]!, entry]);
      finalEntries.push(...insertions[existingEntries.length]!);
      const retainedExistingItems = [...(index.itemsByTurnId.get(turnId)?.values() ?? [])].filter((item) => {
        const itemId = item.public_id ?? item.source_id;
        return desiredItemIdSet.has(itemId) || !survivingItemIdByEvidenceId.has(itemId);
      });
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
          if (entry.observation.publicItemId
            && entry.entry.item.id !== entry.entry.incomingItemId
            && !entry.entry.aliases.includes(entry.entry.incomingItemId)) {
            // An aggregate represents these existing facts; it does not own their bodies or source IDs.
            const retained = index.itemsByPublicId.get(entry.entry.item.id);
            if (!retained) throw new Error("Represented canonical item has no retained body.");
            this.#run(updateRows(itemTables.threadItems, { item_position: itemPosition }, { id: retained.id }));
            this.#replaceCanonicalItem(index, retained, { item_position: itemPosition });
            continue;
          }
          const timeline = this.#providerReplacementTimeline(
            index,
            entry.entry.item.id,
            entry.observation,
            entry.entry.aliases,
          );
          this.#settleObservation(
            {
              ...entry.observation,
              ...(entry.observation.publicItemId ? { publicItemId: entry.entry.item.id } : {}),
              item: entry.observation.publicItemId
                ? { ...entry.entry.item, id: entry.observation.item.id }
                : entry.entry.item,
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
        this.#replaceCanonicalItem(index, (entry.item.public_id
          ? index.itemsByPublicId.get(entry.item.public_id)
          : index.legacyItemsBySourceId.get(entry.item.source_id)) ?? entry.item, {
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

    this.#seedCatalog(window.threadId, [
      window.observations[0] as Extract<WorkbenchTranscriptAtomicObservation, { kind: "thread" }>,
      ...turnObservations,
    ]);
    const alreadyMaterialized = new Set(this.readMaterializedTurnIds(window.threadId, window.materializedTurnIds));
    const missingTurnIds = new Set(window.materializedTurnIds.filter((id) => !alreadyMaterialized.has(id)));
    const index = this.#createCanonicalSettlementIndex(window.threadId);

    for (const turnId of missingTurnIds) {
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
      const existingItems = [...(index.itemsByTurnId.get(turnId)?.values() ?? [])];
      if (existingItems.length) {
        throw new Error(`Unmaterialized transcript turn ${turnId} already contains items`);
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
        && (observation.kind === "browse"
          ? missingTurnIds.has(observation.entry.turnId)
          : "turnId" in observation && observation.turnId !== null && missingTurnIds.has(observation.turnId))
      ) {
        this.#settleObservation(observation, true, index);
      }
    }
    return window.threadId;
  }

  #seedCatalog(
    threadId: string,
    catalog: readonly Extract<WorkbenchTranscriptAtomicObservation, { kind: "thread" | "turn" }>[],
  ) {
    if (catalog[0]?.kind !== "thread") throw new Error("Compatibility catalog must begin with its thread");
    for (const observation of catalog) {
      if (observation.threadId !== threadId) throw new Error("Compatibility catalog crossed thread ownership");
      if (observation.kind === "thread") {
        if (!this.#one(selectRows(coreTables.workbenchThreads, { where: { id: threadId } }))) {
          this.#settleObservation(observation, true);
        }
      } else if (observation.kind === "turn") {
        const alias = this.#one(selectRows(transcriptIdentityTables.turnLegacyAliases, { where: { thread_id: threadId, alias: observation.turnId } }));
        const existing = this.#one(selectRows(coreTables.threadTurns, { where: { id: alias?.turn_id ?? observation.turnId } }));
        if (existing && (existing.thread_id !== threadId || existing.harness_id !== observation.harnessId
          || existing.native_location !== observation.nativeLocation || existing.native_thread_id !== observation.nativeThreadId)) {
          throw new Error(`Compatibility turn ${observation.turnId} changed owner`);
        }
        if (!existing) this.#settleObservation(observation, true);
      } else {
        throw new Error("Compatibility catalog contains a non-catalog fact");
      }
    }
  }

  #settleUsageWindow(window: Extract<WorkbenchTranscriptObservation, { kind: "usageWindow" }>) {
    this.#seedCatalog(window.threadId, window.catalog);
    for (const observation of window.observations) {
      if (observation.threadId !== window.threadId
        || (observation.kind !== "turnUsageContext" && observation.kind !== "turnTokenUsage")) {
        throw new Error("Usage import contains a non-usage fact or crossed thread ownership");
      }
      this.#settleObservation(observation, true);
    }
    return window.threadId;
  }

  #settleTurnCatalog(window: Extract<WorkbenchTranscriptObservation, { kind: "turnCatalog" }>) {
    this.#seedCatalog(window.threadId, window.catalog);
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
      if (thread.identity_origin === "workbench") {
        this.#identity.admitTurn(observation.threadId, {
          harness: observation.harnessId,
          nativeLocation: observation.nativeLocation,
          nativeThreadId: observation.nativeThreadId,
        });
      }
      if (!insideCanonicalWindow) this.#materializeTurn(observation.threadId, observation.turnId);
      return observation.threadId;
    }
    if (observation.kind === "turnUsageContext") {
      this.#requiredTurn(observation.threadId, observation.turnId);
      const existing = this.#one(selectRows(usageTables.threadTurnUsage, { where: { turn_id: observation.turnId } }));
      const newer = observation.observedAt >= (existing?.context_observed_at ?? -Infinity);
      this.#run(upsertRow(usageTables.threadTurnUsage, {
        turn_id: observation.turnId,
        model: newer ? observation.model ?? existing?.model ?? null : existing?.model ?? observation.model,
        model_is_mixed: existing?.model_is_mixed || observation.modelChanged ? 1 : 0,
        service_tier: newer ? observation.serviceTier ?? existing?.service_tier ?? null : existing?.service_tier ?? observation.serviceTier,
        cumulative_input_tokens: null,
        cumulative_cached_input_tokens: null,
        cumulative_cache_write_input_tokens: null,
        cumulative_output_tokens: null,
        cumulative_reasoning_output_tokens: null,
        cumulative_total_tokens: null,
        usage_data_version: null,
        context_observed_at: Math.max(existing?.context_observed_at ?? -Infinity, observation.observedAt),
        usage_observed_at: null,
      }, {
        conflictColumns: ["turn_id"],
        updateColumns: ["model", "model_is_mixed", "service_tier", "context_observed_at"],
      }));
      return observation.threadId;
    }
    if (observation.kind === "turnTokenUsage") {
      this.#requiredTurn(observation.threadId, observation.turnId);
      const existing = this.#one(selectRows(usageTables.threadTurnUsage, { where: { turn_id: observation.turnId } }));
      if (existing?.usage_observed_at !== null && existing?.usage_observed_at !== undefined
        && existing.usage_observed_at > observation.observedAt) return observation.threadId;
      this.#run(upsertRow(usageTables.threadTurnUsage, {
        turn_id: observation.turnId,
        model: null,
        service_tier: null,
        cumulative_input_tokens: observation.cumulative.inputTokens,
        cumulative_cached_input_tokens: observation.cumulative.cachedInputTokens,
        cumulative_cache_write_input_tokens: observation.cumulative.cacheWriteInputTokens,
        cumulative_output_tokens: observation.cumulative.outputTokens,
        cumulative_reasoning_output_tokens: observation.cumulative.reasoningOutputTokens,
        cumulative_total_tokens: observation.cumulative.totalTokens,
        usage_data_version: observation.usageDataVersion,
        context_observed_at: null,
        usage_observed_at: observation.observedAt,
      }, {
        conflictColumns: ["turn_id"],
        updateColumns: [
          "cumulative_input_tokens", "cumulative_cached_input_tokens", "cumulative_cache_write_input_tokens",
          "cumulative_output_tokens", "cumulative_reasoning_output_tokens", "cumulative_total_tokens",
          "usage_data_version", "usage_observed_at",
        ],
      }));
      return observation.threadId;
    }
    if (observation.kind === "item") {
      let item = observation.item;
      if (item.type === "functionCallOutput" || item.type === "fileChange") {
        const existing = this.#findItem(observation.threadId, observation.turnId, item.id, observation.publicItemId, canonicalIndex);
        if (item.type === "functionCallOutput" && existing?.type === "functionCallOutput") {
          const owner = this.#one(selectRows(itemTables.threadItemToolOutputs, { where: { item_id: existing.id } }));
          if (owner && owner.injection_accepted_at !== null) {
            item = mergeThreadItem(item, projectWorkbenchToolOutput(
              item.id, owner, this.#rowsByItemIds(itemTables.threadToolOutputParts, [existing.id]),
            ));
          }
        }
        if (item.type === "fileChange" && existing?.type === "fileChange") {
          const owner = this.#one(selectRows(itemTables.threadItemFileChanges, { where: { item_id: existing.id } }));
          if (owner) {
            const changes = this.#rowsByItemIds(itemTables.threadFileChanges, [existing.id]);
            if (owner.workbench_failure_kind || owner.workbench_policy || owner.recovery_state || changes.some(({ analysis_outcome }) => analysis_outcome)) {
              item = mergeThreadItem(item, projectWorkbenchFileChange(
                item.id, owner, changes,
                this.#rowsByItemIds(itemTables.threadFileChangeHunks, [existing.id]),
                this.#rowsByItemIds(itemTables.threadFileChangeCandidates, [existing.id]),
              ));
            }
          }
        }
      }
      this.#writeItem({
        createTransform: (itemId, sourceRevision) => transformWorkbenchTranscriptItem({
          item,
          itemId,
          lifecycle: observation.lifecycle,
          sourceRevision,
        }),
        itemPosition: observation.itemPosition,
        publicItemId: observation.publicItemId,
        observedAt: observation.observedAt,
        replaceTimeline: insideCanonicalWindow,
        sourceId: observation.item.id,
        timeline: observation.timeline,
        threadId: observation.threadId,
        turnId: observation.turnId,
        allowUnmaterializedTurn: insideCanonicalWindow,
        canonicalIndex,
        allowToolOutputTransition: item.type === "functionCallOutput",
      });
      return observation.threadId;
    }
    if (observation.kind === "questionnaire") {
      this.#writeItem({
        createTransform: (itemId) => transformQuestionnaireEntry(observation.entry, itemId),
        publicItemId: observation.publicItemId,
        itemPosition: observation.itemPosition,
        observedAt: observation.observedAt,
        replaceTimeline: insideCanonicalWindow,
        sourceId: observation.publicItemId ?? resolveQuestionnaireTranscriptSourceId(observation.entry),
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
        sourceId: observation.publicItemId ?? resolveSteerTranscriptSourceId(observation.entry),
        publicItemId: observation.publicItemId,
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

  #findItem(
    threadId: string,
    turnId: string,
    sourceId: string,
    publicItemId: string | undefined,
    index?: CanonicalSettlementIndex,
  ): TranscriptItemRow | null {
    if (publicItemId !== undefined) {
      const admitted = index
        ? index.itemsByPublicId.get(publicItemId) ?? null
        : this.#one(selectRows(itemTables.threadItems, { where: { public_id: publicItemId, thread_id: threadId } }));
      if (admitted) return admitted;
    }
    const legacy = index
      ? index.legacyItemsBySourceId.get(sourceId) ?? null
      : this.#one(selectRows(itemTables.threadItems, { where: { source_id: sourceId, thread_id: threadId, public_id: null } }));
    return legacy && (publicItemId === undefined || legacy.turn_id === turnId) ? legacy : null;
  }

  #findReferencedItem(
    threadId: string,
    turnId: string,
    itemId: string,
    index?: CanonicalSettlementIndex,
  ) {
    const known = index?.itemsByPublicId.get(itemId);
    if (known) return known.turn_id === turnId ? known : null;
    const identity = this.#itemIdentity.resolve({ threadId, turnId, itemId });
    const item = this.#findItem(threadId, turnId, itemId, identity?.itemId, index);
    return item?.turn_id === turnId ? item : null;
  }

  #writeItem({
    createTransform,
    itemPosition,
    observedAt,
    publicItemId,
    replaceTimeline,
    sourceId,
    timeline,
    threadId,
    turnId,
    allowUnmaterializedTurn = false,
    allowToolOutputTransition = false,
    canonicalIndex,
  }: {
    allowUnmaterializedTurn?: boolean;
    allowToolOutputTransition?: boolean;
    canonicalIndex?: CanonicalSettlementIndex;
    createTransform: (itemId: number, sourceRevision: number) => WorkbenchTranscriptItemTransform;
    itemPosition?: number;
    observedAt: number;
    publicItemId?: string;
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
    if (publicItemId !== undefined) {
      const identity = this.#itemIdentity.resolve({ threadId, turnId, itemId: publicItemId });
      if (!identity) {
        throw new Error("Transcript item identity was not admitted before body recording.");
      }
      if (sourceId !== identity.itemId
        && !identity.sources.some((source) => source.turnId === turnId && source.sourceId === sourceId)
        && !identity.legacyAliases.some((alias) => alias.turnId === turnId && alias.alias === sourceId)) {
        throw new Error(`Transcript item source does not belong to its admitted identity. thread=${JSON.stringify(threadId.slice(0, 160))} turn=${JSON.stringify(turnId.slice(0, 160))} item=${JSON.stringify(identity.itemId.slice(0, 160))} source=${JSON.stringify(sourceId.slice(0, 160))}`);
      }
      publicItemId = identity.itemId;
    }
    const existing = this.#findItem(threadId, turnId, sourceId, publicItemId, canonicalIndex);
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
        public_id: publicItemId ?? null,
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
          public_id: publicItemId ?? null,
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
      if (!allowToolOutputTransition
        || !["unknown", "functionCallOutput"].includes(existing.type)
        || !["unknown", "functionCallOutput"].includes(transform.itemType)) {
        throw new Error(`Transcript item ${sourceId} changed type from ${existing.type} to ${transform.itemType}`);
      }
      if (existing.type === "unknown") {
        const opaque = this.#one(selectRows(itemTables.threadItemUnknown, { where: { item_id: itemId } }));
        if (opaque?.native_type !== "functionCallOutput") {
          throw new Error(`Transcript item ${sourceId} is not the same native tool output.`);
        }
        this.#run(deleteRows(itemTables.threadItemUnknown, { item_id: itemId }));
      } else {
        this.#run(deleteRows(itemTables.threadItemToolOutputs, { item_id: itemId }));
      }
    }
    this.#run(updateRows(itemTables.threadItems, {
      public_id: publicItemId ?? existing?.public_id ?? null,
      turn_id: stableTurnId,
      item_position: stableItemPosition,
      type: transform.itemType,
      updated_at: observedAt,
    }, { id: itemId }));
    if (canonicalIndex && indexedItem) {
      indexedItem = this.#replaceCanonicalItem(canonicalIndex, indexedItem, {
        public_id: publicItemId ?? existing?.public_id ?? null,
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
      ? this.#findReferencedItem(entry.threadId, entry.turnId, entry.commandItemId, canonicalIndex)
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
    const item = observation.itemId && observation.threadId && observation.turnId
      ? this.#findReferencedItem(observation.threadId, observation.turnId, observation.itemId, canonicalIndex)
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

  #readRows(threadId: string, threadItems: TranscriptItemRow[]): WorkbenchTranscriptSnapshotRows {
    const itemIds = threadItems.map(({ id }) => id);
    const publicIds = threadItems.flatMap(({ public_id }) => public_id === null ? [] : [public_id]);
    const itemIdentities: WorkbenchTranscriptSnapshotRows["itemIdentities"] = [];
    const itemSourceAliases: WorkbenchTranscriptSnapshotRows["itemSourceAliases"] = [];
    const itemLegacyAliases: WorkbenchTranscriptSnapshotRows["itemLegacyAliases"] = [];
    for (let offset = 0; offset < publicIds.length; offset += SQLITE_ITEM_ID_BATCH_SIZE) {
      const batch = publicIds.slice(offset, offset + SQLITE_ITEM_ID_BATCH_SIZE);
      itemIdentities.push(...this.#all(selectRows(transcriptIdentityTables.itemIdentities, { whereIn: { id: batch } })));
      itemSourceAliases.push(...this.#all(selectRows(transcriptIdentityTables.itemSourceAliases, { whereIn: { item_identity_id: batch } })));
      itemLegacyAliases.push(...this.#all(selectRows(transcriptIdentityTables.itemLegacyAliases, { whereIn: { item_identity_id: batch } })));
    }
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
      itemIdentities,
      itemSourceAliases,
      itemLegacyAliases,
      threadItems,
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
      threadFileChangeHunks: itemRows(itemTables.threadFileChangeHunks),
      threadFileChangeCandidates: itemRows(itemTables.threadFileChangeCandidates),
      threadItemContextCompactions: itemRows(itemTables.threadItemContextCompactions),
      threadItemUnknown: itemRows(itemTables.threadItemUnknown),
      threadItemToolOutputs: itemRows(itemTables.threadItemToolOutputs),
      threadToolOutputParts: itemRows(itemTables.threadToolOutputParts),
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

  #requiredTurn(threadId: string, turnId: string) {
    const turn = this.#one(selectRows(coreTables.threadTurns, { where: { id: turnId } }));
    if (!turn) throw new Error(`Unknown Workbench transcript turn: ${turnId}`);
    if (turn.thread_id !== threadId) throw new Error(`Transcript turn ${turnId} belongs to another Workbench thread`);
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
