/*
 * Exports:
 * - StitchedNativeFilePiece: one native file change contributing to a stitched row.
 * - StitchedNativeFileRow: one native file row grown from back-to-back pieces touching the same file.
 * - FileOperationRenderGroup: one item's rows after stitching; native items whose rows were all absorbed are omitted.
 * - stitchFileOperationRows: merge back-to-back mergeable native file pieces on one path into one growing row.
 */
import type { WorkbenchFileChangeItem } from "workbench-shared/workbench/thread/workbench-file-change";
import {
  getNativeFileChanges, getNativeFileOperationOutcome,
  type NativeFileChange, type NativeFileOperationItem,
} from "../../../workbench/thread/thread-command-matchers";

export interface StitchedNativeFilePiece {
  entry: NativeFileChange;
  item: NativeFileOperationItem;
  /** First change of its item; the item's evidence attaches to exactly one row. */
  primary: boolean;
}

export interface StitchedNativeFileRow {
  pieces: [StitchedNativeFilePiece, ...StitchedNativeFilePiece[]];
}

export type FileOperationRenderGroup =
  | { kind: "fileChange"; item: WorkbenchFileChangeItem }
  | { kind: "native"; item: NativeFileOperationItem; rows: StitchedNativeFileRow[] };

// Failures, deletes, and moves stay standalone so their outcome is never hidden inside a growing edit.
function isMergeable({ entry, item }: StitchedNativeFilePiece) {
  if (entry.danger || getNativeFileOperationOutcome(item) === "failed") return false;
  const kind = entry.change.kind;
  return kind.type === "add" || (kind.type === "update" && !kind.move_path);
}

export function stitchFileOperationRows(items: readonly (WorkbenchFileChangeItem | NativeFileOperationItem)[]) {
  const groups: FileOperationRenderGroup[] = [];
  let open: StitchedNativeFileRow | null = null;
  for (const item of items) {
    if (item.type === "fileChange") {
      groups.push({ kind: "fileChange", item });
      open = null;
      continue;
    }
    const changes = getNativeFileChanges(item);
    if (!changes.length) {
      groups.push({ kind: "native", item, rows: [] });
      open = null;
      continue;
    }
    let group: Extract<FileOperationRenderGroup, { kind: "native" }> | null = null;
    for (const [index, entry] of changes.entries()) {
      const piece = { entry, item, primary: index === 0 };
      const mergeable = isMergeable(piece);
      if (mergeable && open && open.pieces[0].entry.change.path === entry.change.path) {
        open.pieces.push(piece);
        continue;
      }
      const row: StitchedNativeFileRow = { pieces: [piece] };
      if (!group) {
        group = { kind: "native", item, rows: [] };
        groups.push(group);
      }
      group.rows.push(row);
      open = mergeable ? row : null;
    }
  }
  return groups;
}
