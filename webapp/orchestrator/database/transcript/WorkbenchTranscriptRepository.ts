/*
 * WorkbenchTranscriptRepository: owns atomic transcript settlements, stable item indexes, and hydration-bounded reads on one SQLite connection. Keywords: transcript, repository, transaction.
 */
import type Database from "better-sqlite3";

import type {
  ColumnDefinition,
  CurrentTableDefinition,
} from "../../../lib/workbench/database/schema/schema-definition.ts";
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
} from "../workbench-database-statements.ts";
import {
  transformQuestionnaireEntry,
  transformSteerEntry,
  type WorkbenchInteractionTransform,
} from "./workbench-transcript-interaction-transformers.ts";
import { transformWorkbenchTranscriptItem } from "./workbench-transcript-transform-registry.ts";
import type {
  WorkbenchTranscriptAtomicObservation,
  WorkbenchTranscriptObservation,
  WorkbenchTranscriptReadRequest,
  WorkbenchTranscriptSettlement,
  WorkbenchTranscriptSnapshot,
  WorkbenchTranscriptSnapshotRows,
} from "./workbench-transcript-types.ts";

const CURRENT_TRANSCRIPT_CONTENT_VERSION = 2;

export default class WorkbenchTranscriptRepository {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  settle(observations: readonly WorkbenchTranscriptObservation[]): WorkbenchTranscriptSettlement {
    const changedThreadIds = new Set<string>();
    this.#database.transaction(() => {
      for (const observation of observations) {
        const threadId = observation.kind === "canonicalSnapshot"
          ? this.#settleCanonicalSnapshot(observation)
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
        throw new Error("Transcript turnIds contain a turn outside the requested thread");
      }
      const loadedTurnIds = loadedTurns.map(({ id }) => id);
      const firstLoadedTurnIndex = loadedTurns[0]?.turn_index;
      const threadItems = this.#all(selectRows(itemTables.threadItems, {
        whereIn: { turn_id: loadedTurnIds },
        orderBy: [{ column: "item_index" }],
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

  #settleCanonicalSnapshot(
    snapshot: Extract<WorkbenchTranscriptObservation, { kind: "canonicalSnapshot" }>,
  ) {
    if (snapshot.contentVersion !== CURRENT_TRANSCRIPT_CONTENT_VERSION) {
      throw new Error(`Unsupported transcript content version: ${snapshot.contentVersion}`);
    }
    if (!snapshot.observations.length || snapshot.observations[0]?.kind !== "thread") {
      throw new Error("Canonical transcript snapshot must begin with its thread");
    }
    for (const observation of snapshot.observations) {
      const observationThreadId = observation.kind === "questionnaire" || observation.kind === "steer"
        ? observation.entry.threadId
        : observation.kind === "browse"
          ? observation.entry.threadId
          : observation.threadId;
      if (observationThreadId !== snapshot.threadId) {
        throw new Error(`Canonical transcript snapshot crossed thread ownership: ${observationThreadId}`);
      }
    }
    const existing = this.#one(selectRows(coreTables.workbenchThreads, { where: { id: snapshot.threadId } }));
    if (existing && existing.transcript_content_version < CURRENT_TRANSCRIPT_CONTENT_VERSION) {
      this.#run(deleteRows(coreTables.workbenchThreads, { id: snapshot.threadId }));
    }
    for (const observation of snapshot.observations) this.#settleObservation(observation);
    this.#run(updateRows(coreTables.workbenchThreads, {
      transcript_content_version: CURRENT_TRANSCRIPT_CONTENT_VERSION,
    }, { id: snapshot.threadId }));
    return snapshot.threadId;
  }

  #settleObservation(observation: WorkbenchTranscriptAtomicObservation) {
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
      this.#run(upsertRow(coreTables.threadTurns, {
        id: observation.turnId,
        thread_id: observation.threadId,
        turn_index: turnIndex,
        harness_id: observation.harnessId,
        native_location: observation.nativeLocation,
        native_thread_id: observation.nativeThreadId,
        native_turn_id: observation.nativeTurnId,
        state: observation.state,
        created_at: observation.createdAt,
        started_at: observation.startedAt,
        ended_at: observation.endedAt,
        duration_ms: observation.durationMs,
      }, {
        conflictColumns: ["id"],
        updateColumns: ["native_turn_id", "state", "started_at", "ended_at", "duration_ms"],
      }));
      return observation.threadId;
    }
    if (observation.kind === "item") {
      const existingOperation = this.#one(selectRows(operationSourceTables.threadItemOperations, {
        where: { item_id: observation.item.id },
      }));
      const transform = transformWorkbenchTranscriptItem({
        item: observation.item,
        lifecycle: observation.lifecycle,
        sourceRevision: (existingOperation?.source_revision ?? -1) + 1,
      });
      this.#writeItem({
        itemId: observation.item.id,
        itemIndex: observation.itemIndex,
        observedAt: observation.observedAt,
        timeline: observation.timeline,
        threadId: observation.threadId,
        turnId: observation.turnId,
        transform,
      });
      return observation.threadId;
    }
    if (observation.kind === "questionnaire") {
      const transform = transformQuestionnaireEntry(observation.entry);
      this.#writeItem({
        itemId: transform.itemId,
        itemIndex: observation.itemIndex,
        observedAt: observation.observedAt,
        threadId: observation.entry.threadId,
        turnId: observation.entry.turnId,
        transform,
      });
      return observation.entry.threadId;
    }
    if (observation.kind === "steer") {
      const transform = transformSteerEntry(observation.entry);
      if (!transform) return null;
      this.#writeItem({
        itemId: transform.itemId,
        itemIndex: observation.itemIndex,
        observedAt: observation.observedAt,
        threadId: observation.entry.threadId,
        turnId: observation.entry.turnId,
        transform,
      });
      return observation.entry.threadId;
    }
    if (observation.kind === "browse") {
      this.#writeBrowseEntry(observation);
      return observation.entry.threadId;
    }
    this.#writeNativeEvidence(observation);
    return observation.threadId;
  }

  #writeItem({
    itemId,
    itemIndex,
    observedAt,
    timeline,
    threadId,
    turnId,
    transform,
  }: {
    itemId: string;
    itemIndex?: number;
    observedAt: number;
    timeline?: Extract<WorkbenchTranscriptAtomicObservation, { kind: "item" }>["timeline"];
    threadId: string;
    turnId: string;
    transform: WorkbenchInteractionTransform | ReturnType<typeof transformWorkbenchTranscriptItem>;
  }) {
    const turn = this.#one(selectRows(coreTables.threadTurns, { where: { id: turnId } }));
    if (!turn || turn.thread_id !== threadId) {
      throw new Error(`Transcript item ${itemId} references an unknown turn owner`);
    }
    const existing = this.#one(selectRows(itemTables.threadItems, { where: { id: itemId } }));
    if (existing && (existing.thread_id !== threadId || existing.turn_id !== turnId)) {
      throw new Error(`Transcript item ${itemId} changed thread or turn owner`);
    }
    if (existing && existing.type !== transform.itemType) {
      throw new Error(`Transcript item ${itemId} changed type from ${existing.type} to ${transform.itemType}`);
    }
    const thread = this.#requiredThread(threadId);
    const stableItemIndex = existing?.item_index ?? itemIndex ?? thread.next_item_index;
    if (!existing) {
      this.#run(updateRows(coreTables.workbenchThreads, {
        next_item_index: Math.max(thread.next_item_index, stableItemIndex + 1),
        updated_at: Math.max(thread.updated_at, observedAt),
        activity_at: Math.max(thread.activity_at, observedAt),
      }, { id: threadId }));
    }
    this.#run(upsertRow(itemTables.threadItems, {
      id: itemId,
      thread_id: threadId,
      turn_id: turnId,
      item_index: stableItemIndex,
      type: transform.itemType,
      created_at: existing?.created_at ?? observedAt,
      updated_at: observedAt,
    }, {
      conflictColumns: ["id"],
      updateColumns: ["updated_at"],
    }));
    this.#run(deleteRows(itemTables.threadItemTimelines, { item_id: itemId }));
    if (timeline) {
      this.#run(insertRow(itemTables.threadItemTimelines, {
        item_id: itemId,
        first_seen_at: timeline.firstSeenAt,
        last_seen_at: timeline.lastSeenAt,
        started_at: timeline.startedAt,
        completed_at: timeline.completedAt,
      }));
      for (const alias of timeline.aliases ?? []) {
        this.#run(insertRow(itemTables.threadItemTimelineAliases, {
          item_id: itemId,
          alias,
        }));
      }
    }
    this.#runAll(transform.cleanup);
    this.#runAll(transform.mutations);
  }

  #writeBrowseEntry(observation: Extract<WorkbenchTranscriptObservation, { kind: "browse" }>) {
    const { asset, entry } = observation;
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
    const operation = entry.commandItemId
      ? this.#one(selectRows(operationSourceTables.threadItemOperations, { where: { item_id: entry.commandItemId } }))
      : null;
    if (!entry.commandItemId || !operation) {
      const turn = this.#one(selectRows(coreTables.threadTurns, { where: { id: entry.turnId } }));
      if (!turn || turn.thread_id !== entry.threadId) {
        throw new Error(`Browse entry ${entry.entryKey} references an unknown turn owner`);
      }
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
      item_id: entry.commandItemId,
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
    this.#run(insertRow(evidenceTables.transcriptNativeRecords, {
      link_kind: linkKind,
      thread_id: observation.threadId,
      turn_id: observation.turnId,
      item_id: observation.itemId,
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

  #readRows(threadId: string, itemIds: string[]): WorkbenchTranscriptSnapshotRows {
    const itemRows = <
      Table extends CurrentTableDefinition & {
        columns: { item_id: ColumnDefinition<string, boolean, boolean> };
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
