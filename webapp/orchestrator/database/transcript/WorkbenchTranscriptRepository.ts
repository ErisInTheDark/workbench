/*
 * WorkbenchTranscriptRepository: owns atomic transcript settlements, turn-owned item positions, and hydration-bounded reads on one SQLite connection. Keywords: transcript, repository, transaction.
 */
import type Database from "better-sqlite3";

import type {
  ColumnDefinition,
  CurrentTableDefinition,
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
  WorkbenchTranscriptObservation,
  WorkbenchTranscriptReadRequest,
  WorkbenchTranscriptSettlement,
  WorkbenchTranscriptSnapshot,
  WorkbenchTranscriptSnapshotRows,
} from "./workbench-transcript-types.ts";

const CURRENT_TRANSCRIPT_CONTENT_VERSION = 3;

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

export default class WorkbenchTranscriptRepository {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  settle(observations: readonly WorkbenchTranscriptObservation[]): WorkbenchTranscriptSettlement {
    const changedThreadIds = new Set<string>();
    this.#database.transaction(() => {
      for (const observation of observations) {
        const threadId = observation.kind === "canonicalWindow"
          ? this.#settleCanonicalWindow(observation)
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
      const existingItems = this.#all(selectRows(itemTables.threadItems, { where: { turn_id: turnId } }));
      for (const existingItem of existingItems) {
        if (!desiredSourceIdSet.has(existingItem.source_id)) {
          this.#run(deleteRows(itemTables.threadItems, { id: existingItem.id }));
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
      }
      for (const [itemPosition, { observation }] of identifiedItems.entries()) {
        this.#settleObservation(this.#withItemPosition(observation, itemPosition), true);
      }
      this.#materializeTurn(window.threadId, turnId);
    }

    for (const observation of window.observations) {
      if (
        observation.kind !== "thread"
        && observation.kind !== "turn"
        && !this.#itemObservationTurnId(observation)
      ) {
        this.#settleObservation(observation, true);
      }
    }
    this.#run(updateRows(coreTables.workbenchThreads, {
      transcript_content_version: CURRENT_TRANSCRIPT_CONTENT_VERSION,
    }, { id: window.threadId }));
    return window.threadId;
  }

  #settleObservation(
    observation: WorkbenchTranscriptAtomicObservation,
    insideCanonicalWindow = false,
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
      });
      return observation.entry.threadId;
    }
    if (observation.kind === "browse") {
      this.#writeBrowseEntry(observation, insideCanonicalWindow);
      return observation.entry.threadId;
    }
    this.#writeNativeEvidence(observation);
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
  }: {
    allowUnmaterializedTurn?: boolean;
    createTransform: (itemId: number, sourceRevision: number) => WorkbenchTranscriptItemTransform;
    itemPosition?: number;
    observedAt: number;
    replaceTimeline: boolean;
    sourceId: string;
    timeline?: Extract<WorkbenchTranscriptAtomicObservation, { kind: "item" }>["timeline"];
    threadId: string;
    turnId: string;
  }) {
    const turn = this.#one(selectRows(coreTables.threadTurns, { where: { id: turnId } }));
    if (!turn || turn.thread_id !== threadId) {
      throw new Error(`Transcript item ${sourceId} references an unknown turn owner`);
    }
    if (!allowUnmaterializedTurn && !this.#isTurnMaterialized(threadId, turnId)) {
      throw new Error(`Transcript item ${sourceId} references an unmaterialized turn`);
    }
    const existing = this.#one(selectRows(itemTables.threadItems, {
      where: { source_id: sourceId, thread_id: threadId },
    }));
    const existingOwnerTurn = existing?.turn_id === turnId
      ? turn
      : existing
        ? this.#one(selectRows(coreTables.threadTurns, { where: { id: existing.turn_id } }))
        : null;
    const stableTurnId = existingOwnerTurn && existingOwnerTurn.turn_index <= turn.turn_index
      ? existingOwnerTurn.id
      : turnId;
    const stableItemPosition = existing
      && stableTurnId === existing.turn_id
      && (turnId !== stableTurnId || itemPosition === undefined)
      ? existing.item_position
      : itemPosition ?? (() => {
      const turnItems = this.#all(selectRows(itemTables.threadItems, {
        where: { turn_id: stableTurnId },
        orderBy: [{ column: "item_position" }],
      }));
      return (turnItems.at(-1)?.item_position ?? -1) + 1;
    })();
    if (!existing) {
      const thread = this.#requiredThread(threadId);
      this.#run(updateRows(coreTables.workbenchThreads, {
        updated_at: Math.max(thread.updated_at, observedAt),
        activity_at: Math.max(thread.activity_at, observedAt),
      }, { id: threadId }));
    }
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
      return allocatedId;
    })();
    const existingOperation = this.#one(selectRows(operationSourceTables.threadItemOperations, {
      where: { item_id: itemId },
    }));
    const transform = createTransform(itemId, (existingOperation?.source_revision ?? -1) + 1);
    if (existing && existing.type !== transform.itemType) {
      throw new Error(`Transcript item ${sourceId} changed type from ${existing.type} to ${transform.itemType}`);
    }
    this.#run(updateRows(itemTables.threadItems, {
      turn_id: stableTurnId,
      item_position: stableItemPosition,
      type: transform.itemType,
      updated_at: observedAt,
    }, { id: itemId }));
    this.#writeItemTimeline(itemId, timeline, replaceTimeline);
    this.#runAll(transform.cleanup);
    this.#runAll(transform.mutations);
  }

  #writeItemTimeline(
    itemId: number,
    timeline: Extract<WorkbenchTranscriptAtomicObservation, { kind: "item" }>["timeline"],
    replace: boolean,
  ) {
    if (!timeline && !replace) return;
    const existing = this.#one(selectRows(itemTables.threadItemTimelines, { where: { item_id: itemId } }));
    const existingAliases = existing
      ? this.#all(selectRows(itemTables.threadItemTimelineAliases, { where: { item_id: itemId } }))
        .map(({ alias }) => alias)
      : [];
    this.#run(deleteRows(itemTables.threadItemTimelines, { item_id: itemId }));
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
    const aliases = replace
      ? timeline.aliases ?? []
      : Array.from(new Set([...existingAliases, ...(timeline.aliases ?? [])]));
    for (const alias of aliases) {
      this.#run(insertRow(itemTables.threadItemTimelineAliases, {
        item_id: itemId,
        alias,
      }));
    }
  }

  #writeBrowseEntry(
    observation: Extract<WorkbenchTranscriptObservation, { kind: "browse" }>,
    allowUnmaterializedTurn = false,
  ) {
    const { asset, entry } = observation;
    const turn = this.#one(selectRows(coreTables.threadTurns, { where: { id: entry.turnId } }));
    if (!turn || turn.thread_id !== entry.threadId) {
      throw new Error(`Browse entry ${entry.entryKey} references an unknown turn owner`);
    }
    if (!allowUnmaterializedTurn && !this.#isTurnMaterialized(entry.threadId, entry.turnId)) {
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
      ? this.#one(selectRows(itemTables.threadItems, {
        where: { source_id: entry.commandItemId, thread_id: entry.threadId },
      }))
      : null;
    const operation = sourceItem
      ? this.#one(selectRows(operationSourceTables.threadItemOperations, { where: { item_id: sourceItem.id } }))
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

  #writeNativeEvidence(observation: Extract<WorkbenchTranscriptObservation, { kind: "nativeEvidence" }>) {
    this.#ensureHarness(observation.harnessId);
    const linkKind = observation.itemId ? "item" : observation.turnId ? "turn" : "orphan";
    const item = observation.itemId && observation.threadId
      ? this.#one(selectRows(itemTables.threadItems, {
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
    >(table: Table) => (
      this.#all(selectRows(table, {
        whereIn: { item_id: itemIds } as WorkbenchDatabaseRowInFilter<Table>,
      }))
    );
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

  #materializeTurn(threadId: string, turnId: string) {
    this.#run(upsertRow(coreTables.threadTurnMaterializations, {
      turn_id: turnId,
      thread_id: threadId,
      materialized_at: Date.now(),
    }, {
      conflictColumns: ["turn_id"],
      updateColumns: ["materialized_at"],
    }));
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
