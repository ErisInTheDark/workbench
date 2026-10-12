/*
 * Exports:
 * - WorkbenchTranscriptItemCursor/WorkbenchTranscriptItemEnvelope: stable ordered item and its complete relational mini-snapshot.
 * - WorkbenchTranscriptEnvelopeCatalog/WorkbenchTranscriptEnvelopePartition: shared non-item facts and partitioned transcript items.
 * - splitWorkbenchTranscriptSnapshot/composeWorkbenchTranscriptWindow: losslessly partition and rebuild canonical transcript windows.
 * - prependWorkbenchTranscriptWindow: merge an older delivered item window into the browser's credited snapshot.
 * - packWorkbenchTranscriptEnvelopes: select a byte-bounded contiguous envelope prefix without splitting an item.
 */
import {
  emptyTranscriptSnapshotRows,
  type WorkbenchTranscriptItemCursor,
  type WorkbenchTranscriptItemEnvelope,
  type WorkbenchTranscriptSnapshot,
  type WorkbenchTranscriptSnapshotRows,
} from "../database/transcript/workbench-transcript-contract.ts";

export type { WorkbenchTranscriptItemCursor, WorkbenchTranscriptItemEnvelope };

export interface WorkbenchTranscriptEnvelopePartition {
  catalog: WorkbenchTranscriptSnapshot;
  envelopes: WorkbenchTranscriptItemEnvelope[];
}

const itemRowTableNames = [
  "threadItemTimelines",
  "threadItemTimelineAliases",
  "threadItemUserMessages",
  "threadUserMessageParts",
  "threadItemAssistantMessages",
  "threadItemReasoning",
  "threadReasoningSections",
  "threadItemFileChanges",
  "threadFileChanges",
  "threadFileChangeHunks",
  "threadFileChangeCandidates",
  "threadItemContextCompactions",
  "threadItemUnknown",
  "threadItemToolOutputs",
  "threadToolOutputParts",
  "threadItemOperations",
  "threadOperationProcessSources",
  "threadProcessCommandActions",
  "threadOperationToolSources",
  "threadOperationCallableToolSources",
  "threadCallableDynamicContent",
  "threadCallableMcpResults",
  "threadCallableMcpResultContent",
  "threadOperationCollaborationToolSources",
  "threadCollaborationReceivers",
  "threadCollaborationAgentStates",
  "threadItemWebSearches",
  "threadWebSearchQueries",
  "threadWebSearchResults",
  "threadItemInteractions",
  "threadInteractionQuestions",
  "threadInteractionOptions",
  "threadInteractionAnswers",
  "threadApprovalCommandContexts",
  "threadApprovalCommandActions",
  "threadBrowseEntries",
] as const satisfies readonly (keyof WorkbenchTranscriptSnapshotRows)[];

type ItemRow = { item_id: number };
type ItemRowTableName = typeof itemRowTableNames[number];

function serializedBytes(value: object) {
  return JSON.stringify(value).length * 2;
}

function itemRows(
  rows: WorkbenchTranscriptSnapshotRows,
  itemId: number,
): Pick<WorkbenchTranscriptSnapshotRows, ItemRowTableName> {
  const selected = {} as Pick<WorkbenchTranscriptSnapshotRows, ItemRowTableName>;
  for (const name of itemRowTableNames) {
    selected[name] = (rows[name] as ItemRow[]).filter(row => row.item_id === itemId) as never;
  }
  return selected;
}

function uniqueBy<Value, Key>(values: readonly Value[], key: (value: Value) => Key) {
  return [...new Map(values.map(value => [key(value), value])).values()];
}

export function splitWorkbenchTranscriptSnapshot(
  snapshot: WorkbenchTranscriptSnapshot,
): WorkbenchTranscriptEnvelopePartition {
  const turns = new Map(snapshot.turns.map(turn => [turn.id, turn]));
  const itemIdentities = new Map(snapshot.rows.itemIdentities.map(identity => [identity.id, identity]));
  const sourceAliases = new Map<string, WorkbenchTranscriptSnapshotRows["itemSourceAliases"]>();
  for (const alias of snapshot.rows.itemSourceAliases) {
    const aliases = sourceAliases.get(alias.item_identity_id);
    if (aliases) aliases.push(alias);
    else sourceAliases.set(alias.item_identity_id, [alias]);
  }
  const threadAssetRefs = snapshot.rows.transcriptAssetRefs.filter(reference => reference.item_id === null);
  const threadAssetDigests = new Set(threadAssetRefs.map(reference => reference.asset_digest));
  const catalogRows = emptyTranscriptSnapshotRows();
  catalogRows.threadHeldSteers.push(...snapshot.rows.threadHeldSteers);
  catalogRows.threadHeldSteerParts.push(...snapshot.rows.threadHeldSteerParts);
  catalogRows.transcriptAssetRefs.push(...threadAssetRefs);
  catalogRows.transcriptAssets.push(...snapshot.rows.transcriptAssets.filter(asset => threadAssetDigests.has(asset.digest)));
  const catalog: WorkbenchTranscriptSnapshot = {
    expiredTurnPayloads: snapshot.expiredTurnPayloads ?? [],
    hasPreviousTurns: snapshot.hasPreviousTurns,
    loadedTurnIds: [],
    rows: catalogRows,
    thread: snapshot.thread,
    turns: snapshot.turns,
  };
  const envelopes = snapshot.rows.threadItems.map(root => {
    const turn = turns.get(root.turn_id);
    if (!turn) throw new Error(`Transcript item ${root.public_id} references missing turn ${root.turn_id}.`);
    const rows = emptyTranscriptSnapshotRows();
    rows.threadItems.push(root);
    const identity = itemIdentities.get(root.public_id);
    if (identity) rows.itemIdentities.push(identity);
    rows.itemSourceAliases.push(...(sourceAliases.get(root.public_id) ?? []));
    Object.assign(rows, itemRows(snapshot.rows, root.id));
    rows.transcriptAssetRefs.push(...snapshot.rows.transcriptAssetRefs.filter(reference => reference.item_id === root.id));
    const assetDigests = new Set([
      ...rows.transcriptAssetRefs.map(reference => reference.asset_digest),
      ...rows.threadBrowseEntries.flatMap(entry => entry.asset_digest ? [entry.asset_digest] : []),
    ]);
    rows.transcriptAssets.push(...snapshot.rows.transcriptAssets.filter(asset => assetDigests.has(asset.digest)));
    const miniSnapshot: WorkbenchTranscriptSnapshot = {
      approvalOutcomes: snapshot.approvalOutcomes?.filter(outcome => outcome.itemId === root.public_id),
      expiredItemPayloads: snapshot.expiredItemPayloads?.filter(payload => payload.itemId === root.id),
      expiredTurnPayloads: [],
      hasPreviousTurns: false,
      loadedTurnIds: [turn.id],
      rows,
      thread: snapshot.thread,
      turns: [turn],
    };
    const value = {
      cursor: { itemId: root.public_id, itemPosition: root.item_position, turnIndex: turn.turn_index },
      itemId: root.public_id,
      snapshot: miniSnapshot,
    };
    return { ...value, retainedBytes: serializedBytes(value) };
  });
  envelopes.sort((left, right) => left.cursor.turnIndex - right.cursor.turnIndex
    || left.cursor.itemPosition - right.cursor.itemPosition
    || left.cursor.itemId.localeCompare(right.cursor.itemId));
  return { catalog, envelopes };
}

export function composeWorkbenchTranscriptWindow(
  catalog: WorkbenchTranscriptSnapshot,
  source: readonly WorkbenchTranscriptItemEnvelope[],
  options: { hasPreviousItems: boolean },
): WorkbenchTranscriptSnapshot {
  const envelopes = [...source].sort((left, right) => left.cursor.turnIndex - right.cursor.turnIndex
    || left.cursor.itemPosition - right.cursor.itemPosition
    || left.cursor.itemId.localeCompare(right.cursor.itemId));
  const rows = emptyTranscriptSnapshotRows();
  rows.threadHeldSteers.push(...catalog.rows.threadHeldSteers);
  rows.threadHeldSteerParts.push(...catalog.rows.threadHeldSteerParts);
  rows.transcriptAssetRefs.push(...catalog.rows.transcriptAssetRefs);
  rows.transcriptAssets.push(...catalog.rows.transcriptAssets);
  for (const envelope of envelopes) {
    for (const name of Object.keys(rows) as (keyof WorkbenchTranscriptSnapshotRows)[]) {
      rows[name].push(...envelope.snapshot.rows[name] as never[]);
    }
  }
  rows.transcriptAssets = uniqueBy(rows.transcriptAssets, asset => asset.digest);
  rows.transcriptAssetRefs = uniqueBy(rows.transcriptAssetRefs, reference => reference.id);
  const loaded = new Set(envelopes.flatMap(envelope => envelope.snapshot.loadedTurnIds));
  return {
    approvalOutcomes: envelopes.flatMap(envelope => envelope.snapshot.approvalOutcomes ?? []),
    expiredItemPayloads: envelopes.flatMap(envelope => envelope.snapshot.expiredItemPayloads ?? []),
    expiredTurnPayloads: (catalog.expiredTurnPayloads ?? []).filter(payload => loaded.has(payload.turnId)),
    hasPreviousTurns: options.hasPreviousItems,
    loadedTurnIds: catalog.turns.filter(turn => loaded.has(turn.id)).map(turn => turn.id),
    rows,
    thread: catalog.thread,
    turns: catalog.turns,
  };
}

export function prependWorkbenchTranscriptWindow(
  current: WorkbenchTranscriptSnapshot,
  older: WorkbenchTranscriptSnapshot,
  options: { hasPreviousItems: boolean },
) {
  const currentPartition = splitWorkbenchTranscriptSnapshot(current);
  const olderPartition = splitWorkbenchTranscriptSnapshot(older);
  const envelopes = new Map(currentPartition.envelopes.map(envelope => [envelope.itemId, envelope]));
  for (const envelope of olderPartition.envelopes) envelopes.set(envelope.itemId, envelope);
  const turns = new Map(currentPartition.catalog.turns.map(turn => [turn.id, turn]));
  for (const turn of olderPartition.catalog.turns) turns.set(turn.id, turn);
  return composeWorkbenchTranscriptWindow({
    ...currentPartition.catalog,
    turns: [...turns.values()].sort((left, right) => left.turn_index - right.turn_index),
  }, [...envelopes.values()], options);
}

export function packWorkbenchTranscriptEnvelopes(
  envelopes: readonly WorkbenchTranscriptItemEnvelope[],
  maxBytes: number,
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Transcript envelope byte budget must be positive.");
  const selected: WorkbenchTranscriptItemEnvelope[] = [];
  let retainedBytes = 0;
  for (const envelope of envelopes) {
    if (selected.length && retainedBytes + envelope.retainedBytes > maxBytes) break;
    selected.push(envelope);
    retainedBytes += envelope.retainedBytes;
  }
  return {
    envelopes: selected,
    hasMore: selected.length < envelopes.length,
    retainedBytes,
  };
}
