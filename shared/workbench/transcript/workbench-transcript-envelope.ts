/*
 * Exports:
 * - WorkbenchTranscriptItemCursor/WorkbenchTranscriptItemEnvelope: stable ordered item and its complete relational mini-snapshot.
 * - WorkbenchTranscriptEnvelopePartition: shared non-item facts and partitioned transcript items.
 * - compareWorkbenchTranscriptItemCursors: canonical (turn index, item position, item id) order.
 * - splitWorkbenchTranscriptSnapshot/composeWorkbenchTranscriptWindow: losslessly partition and rebuild canonical transcript windows.
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
  "threadInteractionMcpTools",
  "threadBrowseEntries",
] as const satisfies readonly (keyof WorkbenchTranscriptSnapshotRows)[];

type ItemRow = { item_id: number };
type ItemRowTableName = typeof itemRowTableNames[number];

function serializedBytes(value: object) {
  return JSON.stringify(value).length * 2;
}

function groupBy<Value, Key>(values: readonly Value[], key: (value: Value) => Key) {
  const groups = new Map<Key, Value[]>();
  for (const value of values) {
    const group = groups.get(key(value));
    if (group) group.push(value);
    else groups.set(key(value), [value]);
  }
  return groups;
}

/** One pass per table, so splitting stays linear in snapshot size. */
function itemRowIndex(rows: WorkbenchTranscriptSnapshotRows) {
  const tables = itemRowTableNames.map(name => [name, groupBy(rows[name] as ItemRow[], row => row.item_id)] as const);
  return (itemId: number) => {
    const selected = {} as Pick<WorkbenchTranscriptSnapshotRows, ItemRowTableName>;
    for (const [name, groups] of tables) selected[name] = (groups.get(itemId) ?? []) as never;
    return selected;
  };
}

function uniqueBy<Value, Key>(values: readonly Value[], key: (value: Value) => Key) {
  return [...new Map(values.map(value => [key(value), value])).values()];
}

export function compareWorkbenchTranscriptItemCursors(
  left: WorkbenchTranscriptItemCursor,
  right: WorkbenchTranscriptItemCursor,
) {
  return left.turnIndex - right.turnIndex
    || left.itemPosition - right.itemPosition
    || (left.itemId < right.itemId ? -1 : left.itemId > right.itemId ? 1 : 0);
}

export function splitWorkbenchTranscriptSnapshot(
  snapshot: WorkbenchTranscriptSnapshot,
): WorkbenchTranscriptEnvelopePartition {
  const turns = new Map(snapshot.turns.map(turn => [turn.id, turn]));
  const itemIdentities = new Map(snapshot.rows.itemIdentities.map(identity => [identity.id, identity]));
  const sourceAliases = groupBy(snapshot.rows.itemSourceAliases, alias => alias.item_identity_id);
  const itemRows = itemRowIndex(snapshot.rows);
  const assetRefs = groupBy(snapshot.rows.transcriptAssetRefs, reference => reference.item_id);
  const assets = new Map(snapshot.rows.transcriptAssets.map(asset => [asset.digest, asset]));
  const approvalOutcomes = groupBy(snapshot.approvalOutcomes ?? [], outcome => outcome.itemId);
  const expiredItemPayloads = groupBy(snapshot.expiredItemPayloads ?? [], payload => payload.itemId);
  const deferredItemBodies = new Set((snapshot.deferredItemBodies ?? []).map(body => body.itemId));
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
    Object.assign(rows, itemRows(root.id));
    rows.transcriptAssetRefs.push(...(assetRefs.get(root.id) ?? []));
    const assetDigests = new Set([
      ...rows.transcriptAssetRefs.map(reference => reference.asset_digest),
      ...rows.threadBrowseEntries.flatMap(entry => entry.asset_digest ? [entry.asset_digest] : []),
    ]);
    for (const digest of assetDigests) {
      const asset = assets.get(digest);
      if (asset) rows.transcriptAssets.push(asset);
    }
    const miniSnapshot: WorkbenchTranscriptSnapshot = {
      approvalOutcomes: snapshot.approvalOutcomes ? approvalOutcomes.get(root.public_id) ?? [] : undefined,
      expiredItemPayloads: snapshot.expiredItemPayloads ? expiredItemPayloads.get(root.id) ?? [] : undefined,
      ...(deferredItemBodies.has(root.id) ? { deferredItemBodies: [{ itemId: root.id }] } : {}),
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
  envelopes.sort((left, right) => compareWorkbenchTranscriptItemCursors(left.cursor, right.cursor));
  return { catalog, envelopes };
}

export function composeWorkbenchTranscriptWindow(
  catalog: WorkbenchTranscriptSnapshot,
  source: readonly WorkbenchTranscriptItemEnvelope[],
  options: { hasPreviousItems: boolean },
): WorkbenchTranscriptSnapshot {
  const envelopes = [...source].sort((left, right) => compareWorkbenchTranscriptItemCursors(left.cursor, right.cursor));
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
    deferredItemBodies: envelopes.flatMap(envelope => envelope.snapshot.deferredItemBodies ?? []),
    expiredTurnPayloads: (catalog.expiredTurnPayloads ?? []).filter(payload => loaded.has(payload.turnId)),
    hasPreviousTurns: options.hasPreviousItems,
    loadedTurnIds: catalog.turns.filter(turn => loaded.has(turn.id)).map(turn => turn.id),
    rows,
    thread: catalog.thread,
    turns: catalog.turns,
  };
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
