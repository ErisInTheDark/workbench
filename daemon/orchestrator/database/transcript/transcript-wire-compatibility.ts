/*
 * Keywords: transcript, wire, compatibility.
 * Exports:
 * - transcriptSnapshotForProtocol: project canonical rows for the requesting client without changing storage.
 */
import type { WorkbenchTranscriptSnapshot } from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import { projectWorkbenchToolOutput } from "workbench-shared/workbench/database/transcript/workbench-transcript-item-projection";

export function transcriptSnapshotForProtocol(snapshot: WorkbenchTranscriptSnapshot | null, protocolVersion = 1) {
  if (!snapshot || protocolVersion >= 2) return snapshot;
  const { threadItemToolOutputs, threadToolOutputParts, ...legacyRows } = snapshot.rows;
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
