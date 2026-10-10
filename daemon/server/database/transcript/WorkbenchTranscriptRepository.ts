/*
 * Exports:
 * - default WorkbenchTranscriptRepository: own atomic item admission and body settlement, held steers, context compaction, usage facts, provider evidence reconciliation, and bounded reads.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  ItemReferenceSchema, NativeThreadIdSchema, NativeTurnIdSchema, ThreadReferenceSchema, TurnReferenceSchema,
  WorkbenchItemIdSchema,
  WorkbenchThreadIdSchema, WorkbenchTurnIdSchema,
  type WorkbenchItemId, type WorkbenchThreadId, type WorkbenchTurnId,
} from "workbench-shared/workbench/identity";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository.ts";
import WorkbenchProjectRepository from "../project/WorkbenchProjectRepository.ts";
import WorkbenchTranscriptIdentityRepository from "./WorkbenchTranscriptIdentityRepository.ts";
import WorkbenchThreadContextUsageRepository from "./WorkbenchThreadContextUsageRepository.ts";
import WorkbenchApprovalOutcomeRepository from "./WorkbenchApprovalOutcomeRepository.ts";
import { usageTables } from "workbench-shared/workbench/database/schema/usage-schema";
import { transcriptIdentityTables } from "workbench-shared/workbench/database/schema/transcript-identity-schema";
import { codexTranscriptTables } from "workbench-shared/workbench/database/schema/codex-transcript-schema";

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { WorkbenchSteerHistoryEntry } from "workbench-shared/types";
import {
  isSupportedWorkbenchTranscriptItem,
  mergeThreadItem,
  reconcileCompleteThreadItems,
} from "workbench-shared/workbench/thread/thread-item-normalization";
import {
  getWorkbenchThreadItemIdentityKind,
  withWorkbenchThreadItemIdentity,
} from "workbench-shared/workbench/thread/thread-item-identity";
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
  threadPayloadRetentionTables,
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
  heldSteerPartMutations,
  resolveQuestionnaireTranscriptSourceId,
  resolveSteerTranscriptSourceId,
  transformQuestionnaireEntry,
  transformSteerEntry,
} from "./workbench-transcript-interaction-transformers.ts";
import { heldSteerTables } from "workbench-shared/workbench/database/schema/item-schema";
import {
  transformWorkbenchTranscriptItem,
  type WorkbenchTranscriptItemTransform,
} from "./workbench-transcript-transform-registry.ts";
import { transformContextCompaction } from "./workbench-transcript-core-transformers.ts";
import { planTranscriptItemAdmissions } from "./transcript-item-admission.ts";
import type {
  WorkbenchTranscriptAtomicObservation,
  WorkbenchTranscriptCaptureGapObservation,
  WorkbenchTranscriptContextCompactionObservation,
  WorkbenchTranscriptCompactionCompletion,
  WorkbenchTranscriptContextSnapshot,
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
  readonly itemsByPublicId: Map<string, TranscriptItemRow>;
  readonly itemsByTurnId: Map<string, Map<number, TranscriptItemRow>>;
  readonly materializedTurnIds: Set<string>;
  readonly operationRevisionsByItemId: Map<number, number>;
  thread: TranscriptThreadRow;
  readonly timelineAliasesByItemId: Map<number, string[]>;
  readonly timelinesByItemId: Map<number, TranscriptTimelineRow>;
  readonly turnsById: Map<string, TranscriptTurnRow>;
}

interface SettlementChanges {
  itemIds: Set<number>;
  completedItemIds: Set<number>;
  turnIds: Set<string>;
  removedItems: Map<string, Set<string>>;
  /** Latest observed time of rows this settlement newly admitted, per thread. */
  itemActivityAt: Map<string, number>;
  compactionCompletions: WorkbenchTranscriptCompactionCompletion[];
  /** Turns whose held steers changed; live views receive those turns' held-steer rows. */
  heldSteerTurnIds: Set<string>;
}

type TranscriptSettlementMode = "live" | "canonicalImport" | "providerRecovery";

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
  return item.type !== "approval" && item.type !== "questionnaire" && item.type !== "generic";
}

export default class WorkbenchTranscriptRepository {
  readonly #database: Database.Database;
  readonly #identity: WorkbenchThreadIdentityRepository;
  readonly #itemIdentity: WorkbenchTranscriptIdentityRepository;
  readonly #contextUsage: WorkbenchThreadContextUsageRepository;
  readonly #approvalOutcomes: WorkbenchApprovalOutcomeRepository;
  #settlementChanges: SettlementChanges | null = null;

  constructor(database: Database.Database, identity = new WorkbenchThreadIdentityRepository(database)) {
    this.#database = database;
    this.#identity = identity;
    this.#itemIdentity = new WorkbenchTranscriptIdentityRepository(database);
    this.#contextUsage = new WorkbenchThreadContextUsageRepository(database);
    this.#approvalOutcomes = new WorkbenchApprovalOutcomeRepository(database);
  }

  readContextUsage(threadId: string) {
    return this.#contextUsage.read(threadId);
  }

  readStoredItems(threadId: string, itemIds: number[]) {
    return this.#database.transaction(() => {
      const roots = this.#all(selectRows(itemTables.threadItems, {
        where: { thread_id: threadId },
        whereIn: { id: itemIds },
        orderBy: [{ column: "item_position" }],
      }));
      if (roots.length !== itemIds.length) throw new Error("Stored transcript item selection crossed its thread boundary or disappeared.");
      return projectWorkbenchTranscriptItems(this.#readRows(threadId, roots));
    })();
  }

  settle(
    observations: readonly WorkbenchTranscriptObservation[],
    settlementMode: "live" | "replay" = "live",
  ): WorkbenchTranscriptSettlement {
    const changedThreadIds = new Set<string>();
    const affected: SettlementChanges = {
      itemIds: new Set(), completedItemIds: new Set(), turnIds: new Set(), removedItems: new Map(), itemActivityAt: new Map(),
      compactionCompletions: [], heldSteerTurnIds: new Set(),
    };
    try {
      this.#settlementChanges = affected;
      return this.#database.transaction(() => {
        for (const observation of observations) {
          const threadId = observation.kind === "canonicalWindow"
            ? this.#settleCanonicalWindow(observation)
            : observation.kind === "usageWindow"
              ? this.#settleUsageWindow(observation)
            : observation.kind === "turnCatalog"
              ? this.#settleTurnCatalog(observation)
            : observation.kind === "providerTurnScope"
              ? this.#settleProviderTurnScope(observation)
            : observation.kind === "contextCompaction"
              ? this.#settleContextCompaction(observation, settlementMode)
            : this.#settleObservation(observation);
          if (threadId) changedThreadIds.add(threadId);
        }
        const items: TranscriptItemRow[] = [];
        const itemIds = [...affected.itemIds];
        for (let offset = 0; offset < itemIds.length; offset += SQLITE_ITEM_ID_BATCH_SIZE) {
          items.push(...this.#all(selectRows(itemTables.threadItems, {
            whereIn: { id: itemIds.slice(offset, offset + SQLITE_ITEM_ID_BATCH_SIZE) },
          })));
        }
        for (const item of items) affected.turnIds.add(item.turn_id);
        for (const turnId of affected.heldSteerTurnIds) affected.turnIds.add(turnId);
        const turns = this.#all(selectRows(coreTables.threadTurns, { whereIn: { id: [...affected.turnIds] } }));
        const heldSteers = this.#all(selectRows(heldSteerTables.threadHeldSteers, {
          whereIn: { turn_id: [...affected.heldSteerTurnIds] }, orderBy: [{ column: "id" }],
        }));
        const heldSteerParts = this.#all(selectRows(heldSteerTables.threadHeldSteerParts, {
          whereIn: { steer_id: heldSteers.map(({ id }) => id) },
        }));
        const changes = [...changedThreadIds].map(threadId => {
          const changedTurns = turns.filter(turn => turn.thread_id === threadId);
          return {
            removedItemIds: [...(affected.removedItems.get(threadId) ?? [])],
            itemActivityAt: affected.itemActivityAt.get(threadId) ?? null,
            completedItemIds: items.filter(item => item.thread_id === threadId && affected.completedItemIds.has(item.id))
              .map(item => item.public_id),
            snapshot: {
              thread: this.#requiredThread(threadId),
              turns: changedTurns,
              loadedTurnIds: changedTurns.filter(turn => this.#isTurnMaterialized(threadId, turn.id)).map(turn => turn.id),
              hasPreviousTurns: false,
              rows: this.#withHeldSteers(this.#readRows(threadId, items.filter(item => item.thread_id === threadId)),
                heldSteers.filter(steer => steer.thread_id === threadId), heldSteerParts),
            },
          };
        });
        return {
          changedThreadIds: [...changedThreadIds],
          compactionCompletions: affected.compactionCompletions,
          changes,
        };
      })();
    } finally {
      this.#settlementChanges = null;
    }
  }

  readProviderPreviousCursor(threadId: string, turnId: string): string | null | undefined {
    const storedThread = this.#one(selectRows(coreTables.workbenchThreads, { where: { id: threadId } }));
    const owner = storedThread?.id ?? this.#identity.resolve({ threadId: ThreadReferenceSchema.parse(threadId) })?.threadId;
    if (!owner) return undefined;
    const storedTurn = this.#one(selectRows(coreTables.threadTurns, { where: { id: turnId, thread_id: owner } }));
    const boundary = storedTurn?.id ?? this.#identity.resolveTurn({
      threadId: WorkbenchThreadIdSchema.parse(owner), turnId: TurnReferenceSchema.parse(turnId),
    })?.turnId;
    if (!boundary) return undefined;
    return this.#one(selectRows(codexTranscriptTables.turnCursors, { where: { turn_id: boundary } }))?.previous_cursor;
  }

  readContext(threadId: string): WorkbenchTranscriptContextSnapshot | null {
    const catalog = this.read({ threadId, turnIds: [], turnLimit: 1 });
    if (!catalog) return null;
    const materialized = this.readMaterializedTurnIds(threadId, catalog.turns.map(turn => turn.id));
    return this.read({ threadId, turnIds: materialized, turnLimit: 1 }, true);
  }

  read(request: WorkbenchTranscriptReadRequest, contextOnly = false): WorkbenchTranscriptContextSnapshot | null {
    if (!Number.isInteger(request.turnLimit) || request.turnLimit <= 0) {
      throw new Error("Transcript turnLimit must be a positive integer");
    }
    return this.#database.transaction(() => {
      let thread = this.#one(selectRows(coreTables.workbenchThreads, {
        where: { id: request.threadId },
      }));
      if (!thread) {
        const identity = this.#identity.resolve({ threadId: ThreadReferenceSchema.parse(request.threadId) });
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
          ? this.#identity.resolveTurn({ threadId: WorkbenchThreadIdSchema.parse(threadId), turnId: TurnReferenceSchema.parse(turnId) })?.turnId ?? turnId
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
          const identity = this.#identity.resolveTurn({ threadId: WorkbenchThreadIdSchema.parse(threadId), turnId: TurnReferenceSchema.parse(turn.id) })!;
          const replacement = { ...turn, id: identity.turnId, identity_origin: "workbench" as const };
          turns[index] = replacement;
          const loadedIndex = loadedIndexes.get(turn.id);
          if (loadedIndex !== undefined) loadedTurns[loadedIndex] = replacement;
        }
        loadedTurnIds = loadedTurns.map(({ id }) => id);
      }
      const firstLoadedTurnIndex = loadedTurns[0]?.turn_index;
      let threadItems = this.#all(selectRows(itemTables.threadItems, {
        whereIn: { turn_id: loadedTurnIds },
        orderBy: [{ column: "item_position" }],
      }));
      this.#promoteLegacyToolOutputs(threadItems);
      let contextItemOrder: WorkbenchTranscriptContextSnapshot["contextItemOrder"];
      if (contextOnly) {
        const order = new Map(loadedTurnIds.map(turnId => [turnId, [] as string[]]));
        for (const item of threadItems) order.get(item.turn_id)!.push(item.public_id);
        contextItemOrder = [...order].map(([turnId, itemIds]) => ({ turnId, itemIds }));
        const browseItems = new Set(this.#rowsByItemIds(
          evidenceTables.threadBrowseEntries, threadItems.map(item => item.id),
        ).map(entry => entry.item_id));
        const retainedSteers = new Set(this.#rowsByItemIds(itemTables.threadItemUnknown,
          threadItems.filter(item => item.type === "unknown").map(item => item.id))
          .filter(row => row.native_type === "workbenchSteer").map(row => row.item_id));
        threadItems = threadItems.filter(item => item.type === "questionnaire" || item.type === "approval"
          || item.type === "userMessage" || browseItems.has(item.id) || retainedSteers.has(item.id));
      }
      const threadHeldSteers = this.#all(selectRows(heldSteerTables.threadHeldSteers, {
        where: { thread_id: threadId },
        whereIn: { turn_id: loadedTurnIds },
        orderBy: [{ column: "id" }],
      }));
      const rows = {
        ...this.#readRows(threadId, threadItems),
        threadHeldSteers,
        threadHeldSteerParts: this.#all(selectRows(heldSteerTables.threadHeldSteerParts, {
          whereIn: { steer_id: threadHeldSteers.map(({ id }) => id) },
        })),
      };
      return {
        thread,
        turns,
        loadedTurnIds,
        expiredItemPayloads: this.#rowsByItemIds(
          threadPayloadRetentionTables.itemPayloadRetention,
          threadItems.map(({ id }) => id),
        ).map(({ expired_at, item_id }) => ({ expiredAt: expired_at, itemId: item_id })),
        expiredTurnPayloads: this.#all(selectRows(threadPayloadRetentionTables.turnPayloadRetention, {
          whereIn: { turn_id: loadedTurnIds },
        })).map(({ expired_at, turn_id }) => ({ expiredAt: expired_at, turnId: turn_id })),
        hasPreviousTurns: firstLoadedTurnIndex !== undefined
          && turns.some((turn) => turn.turn_index < firstLoadedTurnIndex),
        rows,
        approvalOutcomes: this.#approvalOutcomes.read(threadId, loadedTurnIds),
        ...(contextItemOrder ? { contextItemOrder } : {}),
      };
    })();
  }

  readMaterializedTurnIds(threadId: string, turnIds: readonly string[]) {
    const requestedTurnIds = [...new Set(turnIds)];
    if (requestedTurnIds.length === 0) return [];
    const thread = this.#one(selectRows(coreTables.workbenchThreads, { where: { id: threadId } }));
    if (!thread) threadId = this.#identity.resolve({ threadId: ThreadReferenceSchema.parse(threadId) })?.threadId ?? threadId;
    const resolvedTurnIds = new Map(requestedTurnIds.map((turnId) => {
      const direct = this.#one(selectRows(coreTables.threadTurns, { where: { thread_id: threadId, id: turnId } }));
      if (direct) return [turnId, direct.id];
      const alias = this.#one(selectRows(transcriptIdentityTables.turnLegacyAliases, { where: { thread_id: threadId, alias: turnId } }));
      if (alias) return [turnId, alias.turn_id];
      const native = this.#all(selectRows(coreTables.threadTurns, { where: { thread_id: threadId, native_turn_id: turnId } }));
      if (native.length > 1) throw new Error("Native turn identity is ambiguous within the requested thread.");
      return [turnId, native[0]?.id ?? turnId];
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
      if (!parsed || !this.#one(selectRows(transcriptIdentityTables.itemSourceAliases, {
        where: {
          item_identity_id: root.public_id,
          reference: parsed.id,
          component_kind: "item",
          component_index: 0,
        },
      }))) continue;
      this.#writeItem({
        createTransform: (itemId, sourceRevision) => transformWorkbenchTranscriptItem({
          item: parsed, itemId, sourceRevision, lifecycle: "completed",
        }),
        threadId: root.thread_id, turnId: root.turn_id, sourceId: parsed.id,
        observedAt: root.updated_at, itemPosition: root.item_position,
        replaceTimeline: false, allowToolOutputTransition: true,
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
      itemsByPublicId: new Map(items.map((item) => [item.public_id, item])),
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
    index.itemsByPublicId.delete(existing.public_id);
    index.itemsByPublicId.set(replacement.public_id, replacement);
    if (existing.turn_id !== replacement.turn_id) {
      index.itemsByTurnId.get(existing.turn_id)?.delete(existing.id);
    }
    const turnItems = index.itemsByTurnId.get(replacement.turn_id) ?? new Map<number, TranscriptItemRow>();
    turnItems.set(replacement.id, replacement);
    index.itemsByTurnId.set(replacement.turn_id, turnItems);
    return replacement;
  }

  #deleteCanonicalItem(index: CanonicalSettlementIndex, item: TranscriptItemRow) {
    if (this.#settlementChanges) {
      const removed = this.#settlementChanges.removedItems.get(item.thread_id) ?? new Set<string>();
      removed.add(item.public_id);
      this.#settlementChanges.removedItems.set(item.thread_id, removed);
      this.#settlementChanges.turnIds.add(item.turn_id);
    }
    this.#run(updateRows(evidenceTables.transcriptNativeRecords, {
      link_kind: "turn", item_id: null,
    }, { item_id: item.id }));
    this.#run(deleteRows(itemTables.threadItems, { id: item.id }));
    index.itemsByPublicId.delete(item.public_id);
    index.itemsByTurnId.get(item.turn_id)?.delete(item.id);
    index.operationRevisionsByItemId.delete(item.id);
    index.timelinesByItemId.delete(item.id);
    index.timelineAliasesByItemId.delete(item.id);
  }

  #providerReplacementEnrichedItemIds(existingItems: readonly TranscriptItemRow[]) {
    const itemIds = existingItems.map(({ id }) => id);
    const protectedItemIds = new Set(existingItems
      .filter(({ type }) => (
        type === "questionnaire"
        || type === "approval"
      ))
      .map(({ id }) => id));
    for (const row of this.#rowsByItemIds(itemTables.threadItemUserMessages, itemIds)) {
      if (row.input_kind === "steer" || row.client_id) {
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
    const existingItem = index.itemsByPublicId.get(itemId);
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

  readCompactionExecution(input: {
    harnessId: string; nativeLocation: string; nativeThreadId: string; nativeTurnId: string;
  }) {
    const execution = this.#one(selectRows(itemTables.threadItemContextCompactionExecutions, {
      where: {
        harness_id: input.harnessId,
        native_location: input.nativeLocation,
        native_thread_id: input.nativeThreadId,
        native_turn_id: input.nativeTurnId,
      },
    }));
    if (!execution) return null;
    const item = this.#one(selectRows(itemTables.threadItems, { where: { id: execution.item_id } }));
    if (!item) throw new Error("Compaction execution lost its canonical item.");
    return {
      itemId: WorkbenchItemIdSchema.parse(item.public_id),
      threadId: WorkbenchThreadIdSchema.parse(item.thread_id),
      turnId: WorkbenchTurnIdSchema.parse(item.turn_id),
    };
  }

  #itemLifecycleTimeline(
    existing: TranscriptItemRow,
    observation: Extract<WorkbenchTranscriptAtomicObservation, { kind: "item" }>,
    canonicalIndex?: CanonicalSettlementIndex,
  ): WorkbenchThreadItemTimelineEntry | undefined {
    if (observation.timeline) return observation.timeline;
    if (observation.item.type !== "commandExecution"
      && observation.item.type !== "mcpToolCall"
      && observation.item.type !== "dynamicToolCall") return undefined;
    const timeline = canonicalIndex
      ? canonicalIndex.timelinesByItemId.get(existing.id) ?? null
      : this.#one(selectRows(itemTables.threadItemTimelines, { where: { item_id: existing.id } }));
    if (observation.lifecycle !== "streaming" && !timeline) return undefined;
    const aliases = timeline
      ? canonicalIndex
        ? canonicalIndex.timelineAliasesByItemId.get(existing.id) ?? []
        : this.#all(selectRows(itemTables.threadItemTimelineAliases, { where: { item_id: existing.id } }))
          .map(({ alias }) => alias)
      : [];
    return {
      ...(aliases.length ? { aliases } : {}),
      completedAt: observation.lifecycle === "streaming"
        ? timeline?.completed_at ?? null
        : latestTimestamp(timeline?.completed_at ?? null, observation.observedAt),
      firstSeenAt: earliestTimestamp(timeline?.first_seen_at ?? null, observation.observedAt)
        ?? observation.observedAt,
      itemId: existing.public_id,
      lastSeenAt: latestTimestamp(timeline?.last_seen_at ?? null, observation.observedAt)
        ?? observation.observedAt,
      startedAt: timeline?.started_at
        ?? (observation.lifecycle === "streaming" ? observation.observedAt : null),
    };
  }

  #mergeCanonicalItemIdentity(
    index: CanonicalSettlementIndex,
    threadId: WorkbenchThreadId,
    turnId: WorkbenchTurnId,
    fromItemId: WorkbenchItemId,
    toItemId: WorkbenchItemId,
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
      if (observation.kind !== "item") this.#settleObservation(observation, "providerRecovery");
    }
    const index = this.#createCanonicalSettlementIndex(scope.threadId);
    for (const turnId of scope.completeTurnIds) {
      if (this.#one(selectRows(threadPayloadRetentionTables.turnPayloadRetention, {
        where: { turn_id: turnId },
      }))) continue;
      const itemObservations = scope.observations.filter((
        observation,
      ): observation is Extract<WorkbenchTranscriptAtomicObservation, { kind: "item" }> => (
        observation.kind === "item" && observation.turnId === turnId
      )).map((observation) => {
        // Live compaction reports and snapshots may classify the same native reference differently.
        const publicItemId = observation.publicItemId ?? (observation.item.type === "contextCompaction"
          ? this.#findReferencedItem(scope.threadId, turnId, observation.item.id, index)?.public_id
          : undefined);
        const identity = publicItemId
          ? this.#itemIdentity.resolve({
            threadId: WorkbenchThreadIdSchema.parse(scope.threadId),
            turnId: WorkbenchTurnIdSchema.parse(turnId),
            itemId: ItemReferenceSchema.parse(publicItemId),
          }) ?? this.#itemIdentity.resolve({
            threadId: WorkbenchThreadIdSchema.parse(scope.threadId),
            turnId: WorkbenchTurnIdSchema.parse(turnId),
            itemId: ItemReferenceSchema.parse(observation.item.id),
          })
          : this.#itemIdentity.admit({
            threadId: WorkbenchThreadIdSchema.parse(scope.threadId),
            sources: [{
              turnId: WorkbenchTurnIdSchema.parse(turnId),
              kind: getWorkbenchThreadItemIdentityKind(observation.item),
              reference: observation.item.id,
            }],
          });
        if (!identity) throw new Error("Provider scope references an item identity that was not admitted.");
        return identity.itemId === observation.publicItemId
          ? observation
          : { ...observation, publicItemId: identity.itemId };
      });
      const incomingSourceIds = itemObservations.map(({ item }) => item.id);
      const repeatedSourceCount = incomingSourceIds.length - new Set(incomingSourceIds).size;
      const existingItems = [...(index.itemsByTurnId.get(turnId)?.values() ?? [])]
        .sort((left, right) => left.item_position - right.item_position);
      this.#promoteLegacyToolOutputs(existingItems);
      const enrichedItemIds = this.#providerReplacementEnrichedItemIds(existingItems);
      const rows = this.#readRows(scope.threadId, existingItems);
      const projection = projectWorkbenchTranscriptItems(rows);
      if ("issues" in projection) {
        const issues = projection.issues.map(({ code, itemId, table }) => (
          `${code}:${table}${itemId ? `:${itemId}` : ""}`
        )).join(", ");
        throw new Error(`Complete provider turn ${turnId} could not project current items: ${issues}`);
      }
      const projectedByItemId = new Map(projection.data.map(({ item, root }) => [root.public_id, item]));
      const currentProviderItems = projection.data.flatMap(({ item, root }) => {
        if (!isProviderProjectionItem(item) || root.type === "questionnaire" || root.type === "approval") return [];
        const identity = this.#itemIdentity.resolve({
          threadId: WorkbenchThreadIdSchema.parse(scope.threadId),
          turnId: WorkbenchTurnIdSchema.parse(turnId),
          itemId: ItemReferenceSchema.parse(root.public_id),
        });
        const source = identity?.sources.find(({ kind }) => kind === "stable")
          ?? identity?.sources.find(({ kind }) => kind === "provisional");
        return [withWorkbenchThreadItemIdentity(
          { ...item, id: root.public_id },
          source?.kind === "provisional" ? "provisional" : "stable",
        )];
      });
      const incomingObservationById = new Map(itemObservations.map((observation) => [
        observation.publicItemId!,
        observation,
      ]));
      const publicItemIdFor = (itemId: string) => {
        const identity = this.#itemIdentity.resolve({
          threadId: WorkbenchThreadIdSchema.parse(scope.threadId),
          turnId: WorkbenchTurnIdSchema.parse(turnId),
          itemId: ItemReferenceSchema.parse(itemId),
        });
        if (!identity) throw new Error(`Provider reconciliation lost item identity ${itemId}`);
        return identity.itemId;
      };
      const reconciledItems = reconcileCompleteThreadItems(
        currentProviderItems,
        itemObservations.map(({ item, publicItemId }) => ({ ...item, id: publicItemId! })),
        { mergeDuplicateItems: mergeThreadItem },
      ).map((entry) => ({
        ...entry,
        aliases: entry.aliases.map(publicItemIdFor),
        incomingItemId: publicItemIdFor(entry.incomingItemId),
        item: { ...entry.item, id: publicItemIdFor(entry.item.id) },
      })).map((entry) => {
        const existingRoot = index.itemsByPublicId.get(entry.item.id);
        if (!existingRoot || !enrichedItemIds.has(existingRoot.id)) return entry;
        const existingItem = projectedByItemId.get(existingRoot.public_id);
        return existingItem && isProviderProjectionItem(existingItem)
          ? { ...entry, item: mergeThreadItem(entry.item, existingItem) }
          : entry;
      });
      const desiredItemIds = reconciledItems.map(({ item }) => item.id);
      if (repeatedSourceCount) {
        console.warn(`[workbench-transcript] combined repeated provider observations thread=${JSON.stringify(scope.threadId.slice(0, 100))} turn=${JSON.stringify(turnId.slice(0, 100))} sources=${repeatedSourceCount}`);
      }
      const desiredItemIdSet = new Set(desiredItemIds);
      for (const entry of reconciledItems) {
        if (!incomingObservationById.get(entry.incomingItemId)?.publicItemId) continue;
        for (const alias of entry.aliases) {
          const source = this.#itemIdentity.resolve({ threadId: scope.threadId, turnId, itemId: ItemReferenceSchema.parse(alias) });
          if (!source) throw new Error(`Reconciliation alias has no admitted identity: ${alias}`);
          const target = this.#itemIdentity.resolve({ threadId: scope.threadId, turnId, itemId: ItemReferenceSchema.parse(entry.item.id) });
          if (!target) throw new Error("Reconciliation target has no admitted identity.");
          this.#mergeCanonicalItemIdentity(index, scope.threadId, turnId, source.itemId, target.itemId);
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
        const itemId = existingItem.public_id;
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
      const providerEntries = reconciledItems.map((entry) => {
        const observation = incomingObservationById.get(entry.incomingItemId);
        if (!observation) {
          throw new Error(`Complete provider turn ${turnId} lost incoming item ${entry.incomingItemId}`);
        }
        return { entry, observation };
      });
      const providerEntriesById = new Map(providerEntries.map((entry) => [entry.entry.item.id, entry]));
      const admittedItemIds = [...(index.itemsByTurnId.get(turnId)?.values() ?? [])]
        .sort((left, right) => left.item_position - right.item_position)
        .map(item => item.public_id);
      const recoveryItemIds = desiredItemIds.filter(itemId => {
        const existing = index.itemsByPublicId.get(itemId);
        return !existing || existing.turn_id === turnId;
      });
      for (const admission of planTranscriptItemAdmissions(admittedItemIds, recoveryItemIds)) {
        const provider = providerEntriesById.get(admission.itemId);
        if (!provider) throw new Error("Missing recovery item has no provider evidence.");
        const item = this.#admitItem({
          sourceId: provider.observation.item.id,
          sourceKind: getWorkbenchThreadItemIdentityKind(provider.observation.item),
          publicItemId: admission.itemId,
          observedAt: provider.observation.observedAt,
          threadId: scope.threadId,
          turnId,
          allowUnmaterializedTurn: true,
          canonicalIndex: index,
        });
        this.#insertAdmittedItem(index, item, admission.beforeItemId);
      }
      for (const entry of providerEntries) {
        if (entry.observation.publicItemId
          && entry.entry.item.id !== entry.entry.incomingItemId
          && !entry.entry.aliases.includes(entry.entry.incomingItemId)) {
          // An aggregate represents these existing facts; it does not own their bodies or source IDs.
          if (!index.itemsByPublicId.has(entry.entry.item.id)) throw new Error("Represented canonical item has no retained body.");
          continue;
        }
        const timeline = this.#providerReplacementTimeline(
          index,
          entry.entry.item.id,
          entry.observation,
          entry.entry.aliases,
        );
        const publicItemId = entry.observation.publicItemId
          ? this.#itemIdentity.resolve({ threadId: scope.threadId, turnId, itemId: ItemReferenceSchema.parse(entry.entry.item.id) })?.itemId
          : undefined;
        if (entry.observation.publicItemId && !publicItemId) throw new Error("Replacement item has no admitted identity.");
        const existingRoot = (publicItemId ? index.itemsByPublicId.get(publicItemId) : undefined)
          ?? this.#findItem(scope.threadId, entry.observation.item.id, index)
          ?? undefined;
        const existingItem = existingRoot && enrichedItemIds.has(existingRoot.id)
          ? projectedByItemId.get(existingRoot.public_id)
          : undefined;
        const replacementItem = entry.observation.publicItemId
          ? { ...entry.entry.item, id: entry.observation.item.id }
          : entry.entry.item;
        this.#settleObservation(
          {
            ...entry.observation,
            ...(publicItemId ? { publicItemId } : {}),
            item: existingItem && isProviderProjectionItem(existingItem)
              ? mergeThreadItem(replacementItem, { ...existingItem, id: replacementItem.id })
              : replacementItem,
            itemPosition: undefined,
            ...(timeline ? { timeline } : {}),
          },
          "providerRecovery",
          index,
        );
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
        this.#settleObservation(this.#withItemPosition(observation, itemPosition), "canonicalImport", index);
      }
      const retainedTurn = index.turnsById.get(turnId)!;
      const observedTurn = turnsById.get(turnId)!;
      const timing = {
        started_at: retainedTurn.started_at ?? observedTurn.startedAt,
        ended_at: retainedTurn.ended_at ?? observedTurn.endedAt,
        duration_ms: retainedTurn.duration_ms ?? observedTurn.durationMs,
      };
      if (timing.started_at !== retainedTurn.started_at
        || timing.ended_at !== retainedTurn.ended_at
        || timing.duration_ms !== retainedTurn.duration_ms) {
        this.#run(updateRows(coreTables.threadTurns, timing, { id: turnId }));
        index.turnsById.set(turnId, { ...retainedTurn, ...timing });
      }
      this.#materializeTurn(window.threadId, turnId, index);
    }

    for (const observation of window.observations) {
      // Settled undelivered steers are held, not positioned; a window's pending steer is stale evidence.
      if (observation.kind === "steer") {
        const { status, turnId } = observation.entry;
        if (status !== "sent" && status !== "pending" && missingTurnIds.has(turnId)) this.#settleObservation(observation, "canonicalImport", index);
        continue;
      }
      if (
        observation.kind !== "thread"
        && observation.kind !== "turn"
        && !this.#itemObservationTurnId(observation)
        && (observation.kind === "browse"
          ? missingTurnIds.has(observation.entry.turnId)
          : "turnId" in observation && observation.turnId !== null && missingTurnIds.has(observation.turnId))
      ) {
        this.#settleObservation(observation, "canonicalImport", index);
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
          this.#settleObservation(observation, "canonicalImport");
        }
      } else if (observation.kind === "turn") {
        const alias = this.#one(selectRows(transcriptIdentityTables.turnLegacyAliases, { where: { thread_id: threadId, alias: observation.turnId } }));
        const existing = this.#one(selectRows(coreTables.threadTurns, { where: { id: alias?.turn_id ?? observation.turnId } }));
        if (existing && (existing.thread_id !== threadId || existing.harness_id !== observation.harnessId
          || existing.native_location !== observation.nativeLocation || existing.native_thread_id !== observation.nativeThreadId)) {
          throw new Error(`Compatibility turn ${observation.turnId} changed owner`);
        }
        if (!existing) this.#settleObservation(observation, "canonicalImport");
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
      this.#settleObservation(observation, "canonicalImport");
    }
    return window.threadId;
  }

  #settleTurnCatalog(window: Extract<WorkbenchTranscriptObservation, { kind: "turnCatalog" }>) {
    this.#seedCatalog(window.threadId, window.catalog);
    return window.threadId;
  }

  #settleObservation(
    observation: WorkbenchTranscriptAtomicObservation | WorkbenchTranscriptCaptureGapObservation,
    mode: TranscriptSettlementMode = "live",
    canonicalIndex?: CanonicalSettlementIndex,
  ) {
    if (observation.kind === "providerCursor") {
      const turn = this.#one(selectRows(coreTables.threadTurns, { where: { id: observation.turnId } }));
      if (!turn || turn.thread_id !== observation.threadId || !turn.native_turn_id) {
        throw new Error("Provider pagination boundary requires its owning native turn.");
      }
      this.#run(upsertRow(codexTranscriptTables.turnCursors, {
        turn_id: turn.id, previous_cursor: observation.previousCursor,
      }, { conflictColumns: ["turn_id"], updateColumns: ["previous_cursor"] }));
      return null;
    }
    if (observation.kind === "threadContextUsage") {
      this.#contextUsage.write(observation.threadId, observation.snapshot, observation.initialise);
      return observation.threadId;
    }
    if (observation.kind === "thread") {
      this.#run(upsertRow(coreTables.workbenchThreads, {
        id: observation.threadId,
        project_id: new WorkbenchProjectRepository(this.#database).admitStoredReference(observation.projectId),
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
      const preservesTerminalState = mode === "live"
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
        started_at: mode !== "live" ? observation.startedAt : observation.startedAt ?? existing?.started_at ?? null,
        ended_at: mode !== "live" ? observation.endedAt : observation.endedAt ?? existing?.ended_at ?? null,
        duration_ms: mode !== "live" ? observation.durationMs : observation.durationMs ?? existing?.duration_ms ?? null,
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
      if (mode === "live") this.#materializeTurn(observation.threadId, observation.turnId);
      const settles = observation.state === "completed" || observation.state === "interrupted" || observation.state === "failed";
      if (mode === "live" && settles && (existing?.state === "inProgress" || existing?.state === "admitted")) {
        this.#interruptContextCompactions(
          this.#openContextCompactions(observation.threadId).filter(item => item.turn_id === observation.turnId),
          observation.endedAt ?? Date.now(),
        );
        this.#interruptHeldSteers(observation.turnId, observation.endedAt ?? Date.now());
      }
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
      if (!isSupportedWorkbenchTranscriptItem(observation.item)) return observation.threadId;
      if (this.#one(selectRows(threadPayloadRetentionTables.turnPayloadRetention, {
        where: { turn_id: observation.turnId },
      }))) return observation.threadId;
      const existing = this.#admitItem({
        itemPosition: observation.itemPosition,
        publicItemId: observation.publicItemId ?? (observation.item.type === "contextCompaction"
          ? this.#findReferencedItem(observation.threadId, observation.turnId, observation.item.id, canonicalIndex)?.public_id
          : undefined),
        observedAt: observation.observedAt,
        sourceId: observation.item.id,
        sourceKind: getWorkbenchThreadItemIdentityKind(observation.item),
        threadId: observation.threadId,
        turnId: observation.turnId,
        allowUnmaterializedTurn: mode !== "live",
        canonicalIndex,
      });
      if (this.#one(selectRows(threadPayloadRetentionTables.itemPayloadRetention, {
        where: { item_id: existing.id },
      })) && [
        "commandExecution", "dynamicToolCall", "functionCallOutput", "mcpToolCall",
      ].includes(observation.item.type)) return observation.threadId;
      if (observation.item.type === "contextCompaction") {
        // Workbench settled this compaction; a later native echo can neither reopen nor restate it.
        if (this.#isSettledContextCompaction(existing.id)) return observation.threadId;
      }
      let item: ThreadItem = observation.item;
      if (item.type === "functionCallOutput" || item.type === "fileChange") {
        if (item.type === "functionCallOutput" && existing.type === "functionCallOutput") {
          const owner = this.#one(selectRows(itemTables.threadItemToolOutputs, { where: { item_id: existing.id } }));
          if (owner && owner.injection_accepted_at !== null) {
            item = mergeThreadItem(item, projectWorkbenchToolOutput(
              item.id, owner, this.#rowsByItemIds(itemTables.threadToolOutputParts, [existing.id]),
            ));
          }
        }
        if (item.type === "fileChange" && existing.type === "fileChange") {
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
      const settledItemId = this.#writeItemBody(existing, {
        createTransform: (itemId, sourceRevision) => transformWorkbenchTranscriptItem({
          item,
          itemId,
          lifecycle: observation.lifecycle,
          sourceRevision,
        }),
        observedAt: observation.observedAt,
        replaceTimeline: mode !== "live",
        timeline: this.#itemLifecycleTimeline(existing, observation, canonicalIndex),
        canonicalIndex,
        allowToolOutputTransition: item.type === "functionCallOutput",
      });
      if (observation.lifecycle !== "streaming") this.#settlementChanges?.completedItemIds.add(settledItemId);
      return observation.threadId;
    }
    if (observation.kind === "questionnaire") {
      this.#writeItem({
        createTransform: (itemId) => transformQuestionnaireEntry(observation.entry, itemId),
        publicItemId: observation.publicItemId,
        itemPosition: observation.itemPosition,
        observedAt: observation.observedAt,
        replaceTimeline: mode !== "live",
        sourceId: observation.publicItemId ?? resolveQuestionnaireTranscriptSourceId(observation.entry),
        threadId: observation.entry.threadId,
        turnId: observation.entry.turnId,
        allowUnmaterializedTurn: mode !== "live",
        canonicalIndex,
      });
      return observation.entry.threadId;
    }
    if (observation.kind === "steer") {
      if (observation.entry.status !== "sent") {
        this.#holdSteer(observation, mode);
        return observation.entry.threadId;
      }
      const held = this.#findHeldSteer(observation.entry, observation.publicItemId);
      // Delivery creates the transcript item, so it lands where the agent received it, not where it was sent.
      this.#writeItem({
        createTransform: (itemId) => transformSteerEntry(observation.entry, itemId),
        itemPosition: observation.itemPosition,
        observedAt: observation.observedAt,
        replaceTimeline: mode !== "live",
        sourceId: observation.publicItemId ?? resolveSteerTranscriptSourceId(observation.entry),
        publicItemId: observation.publicItemId,
        threadId: observation.entry.threadId,
        turnId: observation.entry.turnId,
        allowUnmaterializedTurn: mode !== "live",
        canonicalIndex,
      });
      if (held) {
        this.#run(deleteRows(heldSteerTables.threadHeldSteers, { id: held.id }));
        // Live views drop the held entry by its public id once the delivered item replaces it.
        const removed = this.#settlementChanges?.removedItems;
        if (removed) removed.set(held.thread_id, new Set([...removed.get(held.thread_id) ?? [], held.public_id]));
      }
      return observation.entry.threadId;
    }
    if (observation.kind === "browse") {
      this.#writeBrowseEntry(observation, mode !== "live", canonicalIndex);
      return observation.entry.threadId;
    }
    if (observation.kind === "captureGap") {
      this.#requiredThread(observation.threadId);
      if (observation.state === "reconciled") {
        const gap = this.#one(selectRows(evidenceTables.transcriptCaptureGaps, {
          where: { id: observation.gapId, thread_id: observation.threadId },
        }));
        if (!gap || gap.state !== "open") throw new Error("SQLite transcript capture gap is no longer open.");
        this.#run(updateRows(evidenceTables.transcriptCaptureGaps, {
          state: "reconciled", closed_at: observation.closedAt,
        }, { id: gap.id }));
        return observation.threadId;
      }
      this.#run(insertRow(evidenceTables.transcriptCaptureGaps, {
        id: observation.gapId,
        thread_id: observation.threadId,
        turn_id: observation.turnId,
        state: observation.state,
        reason: observation.reason,
        opened_at: observation.openedAt,
        closed_at: observation.closedAt,
        error_text: observation.errorText,
      }));
      return observation.threadId;
    }
    this.#writeNativeEvidence(observation, canonicalIndex);
    return observation.threadId;
  }

  #findItem(
    threadId: string,
    publicItemId: string | undefined,
    index?: CanonicalSettlementIndex,
  ): TranscriptItemRow | null {
    if (publicItemId === undefined) return null;
    return index
      ? index.itemsByPublicId.get(publicItemId) ?? null
      : this.#one(selectRows(itemTables.threadItems, { where: { public_id: publicItemId, thread_id: threadId } }));
  }

  #findReferencedItem(
    threadId: WorkbenchThreadId,
    turnId: WorkbenchTurnId,
    itemId: string,
    index?: CanonicalSettlementIndex,
  ) {
    const known = index?.itemsByPublicId.get(itemId);
    if (known) return known.turn_id === turnId ? known : null;
    const identity = this.#itemIdentity.resolve({ threadId, turnId, itemId: ItemReferenceSchema.parse(itemId) });
    const item = this.#findItem(threadId, identity?.itemId, index);
    return item?.turn_id === turnId ? item : null;
  }

  /**
   * Workbench owns compaction items. A report lands on its referenced item; an unreferenced start adopts its
   * turn's running echo and an unreferenced end settles the thread's open compaction; otherwise it creates the
   * item. Settled compactions never change again, an end with nothing open needs a reference or a measured
   * duration as evidence before it creates one, and a new start retires any older compaction left open.
   */
  #settleContextCompaction(
    observation: WorkbenchTranscriptContextCompactionObservation,
    settlementMode: "live" | "replay",
  ) {
    const threadId = WorkbenchThreadIdSchema.parse(observation.threadId);
    const turnId = WorkbenchTurnIdSchema.parse(observation.turnId);
    this.#requiredTurn(threadId, turnId);
    const { phase, observedAt, reference } = observation;
    if (observation.itemId) {
      this.#itemIdentity.admit({
        threadId,
        itemId: observation.itemId,
        sources: [
          {
            turnId,
            kind: "client",
            reference: observation.itemId,
          },
          ...(reference && reference !== observation.itemId ? [{
            turnId,
            kind: "stable" as const,
            reference,
          }] : []),
        ],
      });
    }
    const referenced = observation.itemId
      ? this.#itemIdentity.resolve({ threadId, turnId, itemId: observation.itemId })
      : reference === null ? null : this.#itemIdentity.resolve({
      threadId, turnId, itemId: ItemReferenceSchema.parse(reference),
    });
    const openItems = this.#openContextCompactions(threadId);
    const open = reference !== null ? null
      : (phase === "started" ? openItems.filter(item => item.turn_id === turnId) : openItems).at(-1) ?? null;
    const existing = referenced ? this.#findItem(threadId, referenced.itemId) : open;
    if (existing && this.#isSettledContextCompaction(existing.id)) return null;
    const durationMs = observation.durationMs ?? null;
    if (!existing && !referenced && phase !== "started" && reference === null && durationMs === null) return null;
    if (phase === "started") {
      this.#interruptContextCompactions(openItems.filter(item => item.id !== existing?.id), observedAt);
    }
    const publicItemId = observation.itemId ?? referenced?.itemId ?? open?.public_id;
    const sourceId = open ? open.public_id : observation.itemId ?? reference ?? `workbench-compaction:${randomUUID()}`;
    const startedAt = phase === "started" ? observedAt
      : !existing && durationMs !== null ? Math.max(0, observedAt - durationMs) : null;
    const itemId = this.#writeItem({
      createTransform: (id) => transformContextCompaction(id, phase === "started" ? "inProgress" : phase),
      observedAt,
      ...(publicItemId ? { publicItemId } : {}),
      replaceTimeline: false,
      sourceId,
      timeline: {
        itemId: publicItemId ?? sourceId,
        startedAt,
        firstSeenAt: startedAt ?? observedAt,
        lastSeenAt: observedAt,
        completedAt: phase === "started" ? null : observedAt,
      },
      threadId,
      turnId: open?.turn_id ?? turnId,
    });
    if (observation.execution) {
      const execution = {
        item_id: itemId,
        harness_id: observation.execution.harnessId,
        native_location: observation.execution.nativeLocation,
        native_thread_id: observation.execution.nativeThreadId,
        native_turn_id: observation.execution.nativeTurnId,
      };
      const stored = this.#one(selectRows(itemTables.threadItemContextCompactionExecutions, {
        where: { item_id: itemId },
      }));
      if (!stored) this.#run(insertRow(itemTables.threadItemContextCompactionExecutions, execution));
      else if (stored.harness_id !== execution.harness_id
        || stored.native_location !== execution.native_location
        || stored.native_thread_id !== execution.native_thread_id
        || stored.native_turn_id !== execution.native_turn_id) {
        throw new Error("A compaction item cannot change its native execution identity.");
      }
    }
    if (phase !== "started") this.#settlementChanges?.completedItemIds.add(itemId);
    if (phase === "completed" && settlementMode === "live") {
      const usage = this.#contextUsage.resetCurrent(threadId);
      const completed = this.#one(selectRows(itemTables.threadItems, { where: { id: itemId } }));
      if (!completed) throw new Error("Completed compaction lost its canonical item.");
      this.#settlementChanges?.compactionCompletions.push({
        itemId: WorkbenchItemIdSchema.parse(completed.public_id),
        threadId,
        turnId: WorkbenchTurnIdSchema.parse(completed.turn_id),
        usage,
      });
    }
    return threadId;
  }

  /** Running compactions whose turn settled, or that a newer compaction replaced, were cut off. */
  #interruptContextCompactions(items: readonly TranscriptItemRow[], endedAt: number) {
    for (const item of items) {
      const itemId = this.#writeItem({
        createTransform: (id) => transformContextCompaction(id, "interrupted"),
        observedAt: endedAt,
        publicItemId: item.public_id,
        replaceTimeline: false,
        sourceId: item.public_id,
        timeline: { itemId: item.public_id, startedAt: null, firstSeenAt: endedAt, lastSeenAt: endedAt, completedAt: endedAt },
        threadId: item.thread_id,
        turnId: item.turn_id,
        allowUnmaterializedTurn: true,
      });
      this.#settlementChanges?.completedItemIds.add(itemId);
    }
  }

  /**
   * A provider can record delivery under its own message identity rather than the held steer's, so the
   * held steer is found by its own identity first and its stable entry key second.
   */
  #findHeldSteer(entry: WorkbenchSteerHistoryEntry, publicItemId: string | undefined) {
    for (const id of new Set([publicItemId, entry.itemId].filter((id): id is string => Boolean(id)))) {
      const held = this.#one(selectRows(heldSteerTables.threadHeldSteers, { where: { public_id: id } }));
      if (held) return held;
    }
    return this.#one(selectRows(heldSteerTables.threadHeldSteers, {
      where: { thread_id: entry.threadId, entry_key: entry.entryKey },
    }));
  }

  /**
   * Held steer truth only moves forward: news never returns a settled steer to `pending`, and the user's
   * dismissal is final against later undelivered news. Delivery evidence always wins and retires the hold.
   */
  #holdSteer(observation: Extract<WorkbenchTranscriptAtomicObservation, { kind: "steer" }>, mode: TranscriptSettlementMode) {
    const { entry } = observation;
    if (entry.status === "sent") throw new Error("A delivered steer cannot be held.");
    this.#requiredTurn(entry.threadId, entry.turnId);
    if (mode === "live" && !this.#isTurnMaterialized(entry.threadId, entry.turnId)) {
      throw new Error(`Held steer ${entry.entryKey} references an unmaterialized turn`);
    }
    const existing = this.#findHeldSteer(entry, observation.publicItemId);
    const publicId = existing?.public_id ?? observation.publicItemId ?? this.#itemIdentity.admit({
      threadId: WorkbenchThreadIdSchema.parse(entry.threadId),
      sources: [{
        turnId: WorkbenchTurnIdSchema.parse(entry.turnId),
        kind: "stable",
        reference: resolveSteerTranscriptSourceId(entry),
      }],
    }).itemId;
    // Late undelivered news about a steer the transcript already received changes nothing.
    if (!existing && this.#findItem(entry.threadId, publicId)) return;
    if (existing && (existing.state === "dismissed" || (entry.status === "pending" && existing.state !== "pending"))) return;
    const values = {
      state: entry.status,
      error_text: entry.status === "failed" ? entry.error ?? "Steer delivery failed." : null,
      resolved_at: entry.status === "pending" ? null : entry.resolvedAt ?? observation.observedAt,
      request_id: entry.requestId,
      client_id: entry.clientUserMessageId ?? null,
      dispatch_sequence: entry.dispatchSequence ?? null,
    };
    let steerId = existing?.id;
    if (existing) {
      this.#run(updateRows(heldSteerTables.threadHeldSteers, values, { id: existing.id }));
    } else {
      steerId = Number(this.#run(insertRow(heldSteerTables.threadHeldSteers, {
        ...values,
        public_id: publicId,
        thread_id: entry.threadId,
        turn_id: entry.turnId,
        entry_key: entry.entryKey,
        attempted_at: entry.attemptedAt,
      })).lastInsertRowid);
    }
    this.#runAll(heldSteerPartMutations(entry, steerId!));
    this.#settlementChanges?.heldSteerTurnIds.add(entry.turnId);
  }

  /** A turn that ends can no longer deliver the steers it still holds; they become undelivered, not lost. */
  #interruptHeldSteers(turnId: string, endedAt: number) {
    this.#run(updateRows(heldSteerTables.threadHeldSteers, {
      state: "interrupted", resolved_at: endedAt,
    }, { turn_id: turnId, state: "pending" }));
    this.#settlementChanges?.heldSteerTurnIds.add(turnId);
  }

  #withHeldSteers(
    rows: WorkbenchTranscriptSnapshotRows,
    steers: WorkbenchTranscriptSnapshotRows["threadHeldSteers"],
    parts: WorkbenchTranscriptSnapshotRows["threadHeldSteerParts"],
  ): WorkbenchTranscriptSnapshotRows {
    if (!steers.length) return rows;
    const ids = new Set(steers.map(({ id }) => id));
    return { ...rows, threadHeldSteers: steers, threadHeldSteerParts: parts.filter(part => ids.has(part.steer_id)) };
  }

  /** The thread's running compactions in creation order, wherever their turns are; manual compaction can follow a settled turn. */
  #openContextCompactions(threadId: string) {
    const items = this.#all(selectRows(itemTables.threadItems, {
      where: { thread_id: threadId, type: "contextCompaction" },
      orderBy: [{ column: "id" }],
    }));
    const open = new Set(this.#rowsByItemIds(itemTables.threadItemContextCompactions, items.map(item => item.id))
      .filter(row => row.state === "inProgress").map(row => row.item_id));
    return items.filter(item => open.has(item.id));
  }

  #contextCompactionState(itemId: number) {
    return this.#one(selectRows(itemTables.threadItemContextCompactions, { where: { item_id: itemId } }))?.state ?? null;
  }

  #isSettledContextCompaction(itemId: number) {
    const state = this.#contextCompactionState(itemId);
    return state === "completed" || state === "failed";
  }

  #admitItem({
    itemPosition,
    observedAt,
    publicItemId,
    sourceId,
    sourceKind,
    threadId,
    turnId,
    allowUnmaterializedTurn = false,
    canonicalIndex,
  }: {
    allowUnmaterializedTurn?: boolean;
    canonicalIndex?: CanonicalSettlementIndex;
    itemPosition?: number;
    observedAt: number;
    publicItemId?: string;
    sourceId: string;
    sourceKind?: "stable" | "provisional";
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
    publicItemId ??= this.#itemIdentity.admit({
      threadId: WorkbenchThreadIdSchema.parse(threadId),
      sources: [{
        turnId: WorkbenchTurnIdSchema.parse(turnId),
        kind: sourceKind ?? getWorkbenchThreadItemIdentityKind({ id: sourceId }),
        reference: sourceId,
      }],
    }).itemId;
    const identity = this.#itemIdentity.resolve({
      threadId: WorkbenchThreadIdSchema.parse(threadId),
      turnId: WorkbenchTurnIdSchema.parse(turnId),
      itemId: ItemReferenceSchema.parse(publicItemId),
    });
    if (!identity) {
      throw new Error("Transcript item identity was not admitted before body recording.");
    }
    if (sourceId !== identity.itemId
      && !identity.sources.some((source) => source.turnId === turnId
        && source.reference === sourceId
        && (source.component?.kind ?? "item") === "item"
        && (source.component?.index ?? 0) === 0)) {
      throw new Error(`Transcript item source does not belong to its admitted identity. thread=${JSON.stringify(threadId.slice(0, 160))} turn=${JSON.stringify(turnId.slice(0, 160))} item=${JSON.stringify(identity.itemId.slice(0, 160))} source=${JSON.stringify(sourceId.slice(0, 160))}`);
    }
    publicItemId = identity.itemId;
    const existing = this.#findItem(threadId, publicItemId, canonicalIndex);
    if (existing) {
      if (itemPosition !== undefined && (existing.turn_id !== turnId || existing.item_position !== itemPosition)) {
        throw new Error("An admitted transcript item cannot be relocated by a body observation.");
      }
      return existing;
    }
    const stableItemPosition = itemPosition ?? (() => {
      const turnItems = canonicalIndex
        ? [...(canonicalIndex.itemsByTurnId.get(turnId)?.values() ?? [])]
        : this.#all(selectRows(itemTables.threadItems, {
          where: { turn_id: turnId },
          orderBy: [{ column: "item_position" }],
        }));
      return Math.max(-1, ...turnItems.map(({ item_position }) => item_position)) + 1;
    })();
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
    if (this.#settlementChanges) {
      const admittedAt = this.#settlementChanges.itemActivityAt.get(threadId);
      this.#settlementChanges.itemActivityAt.set(threadId, Math.max(admittedAt ?? observedAt, observedAt));
    }
    const result = this.#run(insertRow(itemTables.threadItems, {
      public_id: publicItemId,
      thread_id: threadId,
      turn_id: turnId,
      item_position: stableItemPosition,
      type: "unknown",
      created_at: observedAt,
      updated_at: observedAt,
    }));
    const itemId = Number(result.lastInsertRowid);
    if (!Number.isSafeInteger(itemId) || itemId <= 0) {
      throw new Error(`Transcript item ${sourceId} received an invalid relational id`);
    }
    const item: TranscriptItemRow = {
      id: itemId, public_id: publicItemId, thread_id: threadId, turn_id: turnId,
      item_position: stableItemPosition, type: "unknown", created_at: observedAt, updated_at: observedAt,
    };
    return canonicalIndex ? this.#replaceCanonicalItem(canonicalIndex, item, {}) : item;
  }

  /** Only a newly admitted item may enter a proven gap; existing items retain their relative order. */
  #insertAdmittedItem(index: CanonicalSettlementIndex, item: TranscriptItemRow, beforeItemId: string | null) {
    if (beforeItemId === null) return;
    const anchor = index.itemsByPublicId.get(beforeItemId);
    if (!anchor || anchor.turn_id !== item.turn_id || anchor.thread_id !== item.thread_id) {
      throw new Error("Recovered item admission has no owning insertion anchor.");
    }
    const suffix = [...(index.itemsByTurnId.get(item.turn_id)?.values() ?? [])]
      .filter(row => row.id !== item.id && row.item_position >= anchor.item_position)
      .sort((left, right) => right.item_position - left.item_position);
    // The new row occupies the tail. Park only it, then shift the suffix backwards to avoid unique collisions.
    const parkedPosition = Math.max(item.item_position, ...suffix.map(row => row.item_position)) + 2;
    this.#run(updateRows(itemTables.threadItems, { item_position: parkedPosition }, { id: item.id }));
    for (const row of suffix) {
      this.#run(updateRows(itemTables.threadItems, { item_position: row.item_position + 1 }, { id: row.id }));
      this.#replaceCanonicalItem(index, row, { item_position: row.item_position + 1 });
    }
    this.#run(updateRows(itemTables.threadItems, { item_position: anchor.item_position }, { id: item.id }));
    this.#replaceCanonicalItem(index, item, { item_position: anchor.item_position });
  }

  #writeItem({
    createTransform, itemPosition, observedAt, publicItemId, replaceTimeline, sourceId, sourceKind,
    timeline, threadId, turnId, allowUnmaterializedTurn = false, allowToolOutputTransition = false, canonicalIndex,
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
    sourceKind?: "stable" | "provisional";
    timeline?: Extract<WorkbenchTranscriptAtomicObservation, { kind: "item" }>["timeline"];
    threadId: string;
    turnId: string;
  }) {
    const admitted = this.#admitItem({
      itemPosition, observedAt, publicItemId, sourceId, sourceKind, threadId, turnId,
      allowUnmaterializedTurn, canonicalIndex,
    });
    return this.#writeItemBody(admitted, { createTransform, observedAt, replaceTimeline, timeline, allowToolOutputTransition, canonicalIndex });
  }

  #writeItemBody(existing: TranscriptItemRow, {
    createTransform, observedAt, replaceTimeline, timeline, allowToolOutputTransition, canonicalIndex,
  }: {
    createTransform: (itemId: number, sourceRevision: number) => WorkbenchTranscriptItemTransform;
    observedAt: number;
    replaceTimeline: boolean;
    timeline?: Extract<WorkbenchTranscriptAtomicObservation, { kind: "item" }>["timeline"];
    allowToolOutputTransition: boolean;
    canonicalIndex?: CanonicalSettlementIndex;
  }) {
    const itemId = existing.id;
    const existingOperationRevision = canonicalIndex
      ? canonicalIndex.operationRevisionsByItemId.get(itemId) ?? null
      : this.#one(selectRows(operationSourceTables.threadItemOperations, {
        where: { item_id: itemId },
      }))?.source_revision ?? null;
    const transform = createTransform(itemId, (existingOperationRevision ?? -1) + 1);
    // A just-admitted root has no augmentation yet; an opaque provider item already has an owned body.
    const opaque = existing.type === "unknown"
      ? this.#one(selectRows(itemTables.threadItemUnknown, { where: { item_id: itemId } }))
      : null;
    if (existing.type !== transform.itemType && (existing.type !== "unknown" || opaque)) {
      if (!allowToolOutputTransition
        || !["unknown", "functionCallOutput"].includes(existing.type)
        || !["unknown", "functionCallOutput"].includes(transform.itemType)) {
        throw new Error(`Transcript item ${existing.public_id} changed type from ${existing.type} to ${transform.itemType}`);
      }
      if (existing.type === "unknown") {
        if (opaque?.native_type !== "functionCallOutput") {
          throw new Error(`Transcript item ${existing.public_id} is not the same native tool output.`);
        }
        this.#run(deleteRows(itemTables.threadItemUnknown, { item_id: itemId }));
      } else {
        this.#run(deleteRows(itemTables.threadItemToolOutputs, { item_id: itemId }));
      }
    }
    this.#run(updateRows(itemTables.threadItems, {
      type: transform.itemType,
      updated_at: observedAt,
    }, { id: itemId }));
    if (canonicalIndex) {
      this.#replaceCanonicalItem(canonicalIndex, existing, {
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
    return itemId;
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
        nativeThreadId: turn.native_thread_id === null ? null : NativeThreadIdSchema.parse(turn.native_thread_id),
        nativeTurnId: turn.native_turn_id === null ? null : NativeTurnIdSchema.parse(turn.native_turn_id),
        nativeItemId: null,
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
    const publicIds = threadItems.map(({ public_id }) => public_id);
    const itemIdentities: WorkbenchTranscriptSnapshotRows["itemIdentities"] = [];
    const itemSourceAliases: WorkbenchTranscriptSnapshotRows["itemSourceAliases"] = [];
    for (let offset = 0; offset < publicIds.length; offset += SQLITE_ITEM_ID_BATCH_SIZE) {
      const batch = publicIds.slice(offset, offset + SQLITE_ITEM_ID_BATCH_SIZE);
      itemIdentities.push(...this.#all(selectRows(transcriptIdentityTables.itemIdentities, { whereIn: { id: batch } })));
      itemSourceAliases.push(...this.#all(selectRows(transcriptIdentityTables.itemSourceAliases, { whereIn: { item_identity_id: batch } })));
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
      threadItems,
      threadItemTimelines: itemRows(itemTables.threadItemTimelines),
      threadItemTimelineAliases: itemRows(itemTables.threadItemTimelineAliases),
      threadItemUserMessages: itemRows(itemTables.threadItemUserMessages),
      threadUserMessageParts: itemRows(itemTables.threadUserMessageParts),
      // Held steers are not items; only transcript reads attach them.
      threadHeldSteers: [],
      threadHeldSteerParts: [],
      threadItemAssistantMessages: itemRows(itemTables.threadItemAssistantMessages),
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
      return observation.entry.status === "sent"
        ? resolveSteerTranscriptSourceId(observation.entry)
        : null;
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
    const result = this.#database.prepare(compiled.sql).run(...compiled.parameters);
    if (this.#settlementChanges) {
      const values = statement.kind === "insert" || statement.kind === "upsert"
        ? statement.values : statement.where;
      const itemId = values.find(([column]) => column === (
        statement.tableName === itemTables.threadItems.name ? "id" : "item_id"
      ))?.[1];
      if (typeof itemId === "number" && statement.tableName !== evidenceTables.transcriptNativeRecords.name) {
        this.#settlementChanges.itemIds.add(itemId);
      }
      if (statement.tableName === itemTables.threadItems.name && statement.kind === "insert") {
        this.#settlementChanges.itemIds.add(Number(result.lastInsertRowid));
      }
      if (statement.tableName === coreTables.threadTurns.name) {
        const turnId = values.find(([column]) => column === "id")?.[1];
        if (typeof turnId === "string") this.#settlementChanges.turnIds.add(turnId);
      }
    }
    return result;
  }

  #all<Row extends WorkbenchDatabaseRow>(statement: WorkbenchDatabaseQuery<Row>): Row[] {
    const compiled = compileWorkbenchDatabaseStatement(workbenchDatabaseTables, statement);
    return this.#database.prepare(compiled.sql).all(...compiled.parameters) as Row[];
  }

  #one<Row extends WorkbenchDatabaseRow>(statement: WorkbenchDatabaseQuery<Row>): Row | null {
    return this.#all(statement)[0] ?? null;
  }
}
