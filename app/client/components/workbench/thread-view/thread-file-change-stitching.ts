/*
 * Exports:
 * - StitchedNativeFilePiece: one native file change contributing to a stitched row.
 * - StitchedNativeFileRow: one native file row grown from back-to-back pieces touching the same file.
 * - FileOperationRenderGroup: one item's rows after stitching; native items whose rows were all absorbed are omitted.
 * - stitchFileOperationRows: merge back-to-back native file pieces on one path into one growing row: applied edits into an applied run, identical failures into a failure run.
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

/** What later pieces must match to join a row: applied runs grow by path, failure runs only repeat one exact failure. */
interface RunShape {
  attempt: string;
  failure: string | null;
  path: string;
}

interface OpenRun extends RunShape {
  row: StitchedNativeFileRow;
}

/** Same operation on the same target, regardless of outcome. */
function getAttemptKey({ change }: NativeFileChange) {
  return JSON.stringify([change.path, change.kind.type, change.kind.type === "update" ? change.kind.move_path : null]);
}

function getFailureKey(entry: NativeFileChange) {
  return JSON.stringify([getAttemptKey(entry), entry.failureKind ?? null, entry.presentationLabel ?? null]);
}

// Deletes, moves, and dangerous changes never grow an applied row, so their outcome is never hidden inside an edit.
function isGrowable({ change, danger }: NativeFileChange) {
  return !danger && (change.kind.type === "add" || (change.kind.type === "update" && !change.kind.move_path));
}

/**
 * Applied and failed outcomes never share a row. A live piece joins the open run it would retry or extend,
 * so an ongoing attempt never flashes a new row; once settled it stays only if its outcome matches that run.
 */
function stitchPiece(open: RunShape | null, { entry, item }: StitchedNativeFilePiece): { joins: boolean; run: RunShape | null } {
  const outcome = getNativeFileOperationOutcome(item);
  const attempt = getAttemptKey(entry);
  if (outcome === "failed") {
    const failure = getFailureKey(entry);
    return { joins: open?.failure === failure, run: { attempt, failure, path: entry.change.path } };
  }
  if (outcome === "inProgress" && open?.failure && open.attempt === attempt) return { joins: true, run: open };
  if (!isGrowable(entry)) return { joins: false, run: null };
  return { joins: Boolean(open && !open.failure && open.path === entry.change.path), run: { attempt, failure: null, path: entry.change.path } };
}

export function stitchFileOperationRows(items: readonly (WorkbenchFileChangeItem | NativeFileOperationItem)[]) {
  const groups: FileOperationRenderGroup[] = [];
  let open: OpenRun | null = null;
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
      const { joins, run } = stitchPiece(open, piece);
      if (joins && open) {
        open.row.pieces.push(piece);
        open = run && { ...run, row: open.row };
        continue;
      }
      const row: StitchedNativeFileRow = { pieces: [piece] };
      if (!group) {
        group = { kind: "native", item, rows: [] };
        groups.push(group);
      }
      group.rows.push(row);
      open = run && { ...run, row };
    }
  }
  return groups;
}
