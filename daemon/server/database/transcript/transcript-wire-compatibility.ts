/*
 * Keywords: transcript, wire, compatibility.
 * Exports:
 * - transcriptSnapshotForProtocol: project canonical rows for the requesting client without changing storage.
 */
import type { WorkbenchTranscriptSnapshot } from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import { projectWorkbenchToolOutput } from "workbench-shared/workbench/database/transcript/workbench-transcript-item-projection";

export function transcriptSnapshotForProtocol(snapshot: WorkbenchTranscriptSnapshot | null, protocolVersion = 1) {
  if (!snapshot || protocolVersion >= 4) return snapshot;
  const sourceReferenceByItemId = new Map<string, { kind: "client" | "provisional" | "stable"; reference: string }>();
  const sourceRank = { client: 0, provisional: 1, stable: 2 } as const;
  for (const source of snapshot.rows.itemSourceAliases) {
    if (source.component_kind !== "item" || source.component_index !== 0) continue;
    const current = sourceReferenceByItemId.get(source.item_identity_id);
    if (current && sourceRank[current.kind] >= sourceRank[source.source_kind]) continue;
    sourceReferenceByItemId.set(source.item_identity_id, {
      kind: source.source_kind,
      reference: source.reference,
    });
  }
  const {
    itemSourceAliases,
    threadItemToolOutputs,
    threadToolOutputParts,
    ...currentRows
  } = snapshot.rows;
  const legacyRows = {
    ...currentRows,
    itemLegacyAliases: [],
    itemSourceAliases: itemSourceAliases.map((source) => ({
      turn_id: source.turn_id,
      source_kind: source.source_kind,
      source_id: source.reference,
      thread_id: source.thread_id,
      item_identity_id: source.item_identity_id,
    })),
    threadItems: currentRows.threadItems.map((item) => ({
      ...item,
      source_id: sourceReferenceByItemId.get(item.public_id)?.reference ?? item.public_id,
    })),
  };
  if (protocolVersion >= 2) return { ...snapshot, rows: {
    ...legacyRows,
    threadItemToolOutputs,
    threadToolOutputParts,
  } };
  const owners = new Map(threadItemToolOutputs.map((owner) => [owner.item_id, owner]));
  const parts = new Map<number, typeof threadToolOutputParts>();
  for (const part of threadToolOutputParts) {
    const group = parts.get(part.item_id) ?? [];
    group.push(part);
    parts.set(part.item_id, group);
  }
  const opaque = [...legacyRows.threadItemUnknown];
  const threadItems = legacyRows.threadItems.map((root) => {
    if (root.type !== "functionCallOutput") return root;
    const owner = owners.get(root.id);
    if (!owner) throw new Error("Tool output wire projection is missing its owner.");
    opaque.push({
      item_id: root.id,
      item_type: "unknown",
      native_type: "functionCallOutput",
      safe_json: JSON.stringify(projectWorkbenchToolOutput(root.source_id, owner, parts.get(root.id) ?? [])),
    });
    return { ...root, type: "unknown" as const };
  });
  return {
    ...snapshot,
    rows: { ...legacyRows, threadItems, threadItemUnknown: opaque },
  };
}
