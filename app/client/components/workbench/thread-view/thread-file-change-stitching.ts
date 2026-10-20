/*
 * Exports:
 * - StitchedNativeFilePiece: one native file change contributing to a stitched row.
 * - StitchedNativeFileRow: one native file row grown from back-to-back pieces touching the same file.
 * - StitchedCanonicalFilePiece/StitchedCanonicalFileRow: one canonical change, and one row grown from back-to-back applied changes of one kind on one file.
 * - FileOperationRenderGroup: one item's rows after stitching; items whose rows were all absorbed are omitted.
 * - stitchFileOperationRows: merge back-to-back pieces on one path into one growing row: native applied edits or identical failures, canonical applied changes of the same kind.
 * - getStitchedRowSpan: one row's work span, from its first piece starting to its last finishing.
 */
import type { WorkbenchFileChangeItem } from "workbench-shared/workbench/thread/workbench-file-change";
import { findWorkbenchThreadItemTimelineEntry, type WorkbenchThreadItemTimelineEntry } from "workbench-shared/workbench/thread/thread-item-timeline";
import {
  getNativeFileChanges, getNativeFileOperationOutcome,
  type NativeFileChange, type NativeFileOperationItem,
} from "../../../workbench/thread/thread-command-matchers";

type CanonicalChange = WorkbenchFileChangeItem["changes"][number];

export interface StitchedNativeFilePiece {
  entry: NativeFileChange;
  item: NativeFileOperationItem;
  /** First change of its item; the item's evidence attaches to exactly one row. */
  primary: boolean;
}

export interface StitchedNativeFileRow {
  pieces: [StitchedNativeFilePiece, ...StitchedNativeFilePiece[]];
}

export interface StitchedCanonicalFilePiece {
  change: CanonicalChange;
  item: WorkbenchFileChangeItem;
  sourceChangeIndex: number;
}

export interface StitchedCanonicalFileRow {
  pieces: [StitchedCanonicalFilePiece, ...StitchedCanonicalFilePiece[]];
}

export type FileOperationRenderGroup =
  | { kind: "fileChange"; item: WorkbenchFileChangeItem; rows: StitchedCanonicalFileRow[] }
  | { kind: "native"; item: NativeFileOperationItem; rows: StitchedNativeFileRow[] };

/** What later pieces must match to join a row: applied runs grow by path, failure runs only repeat one exact failure. */
interface RunShape {
  attempt: string;
  failure: string | null;
  path: string;
}

type OpenRun =
  | RunShape & { kind: "native"; row: StitchedNativeFileRow }
  | { kind: "fileChange"; attempt: string; row: StitchedCanonicalFileRow };

function getChangeAttemptKey(change: Pick<CanonicalChange, "kind" | "path">) {
  return JSON.stringify([change.path, change.kind.type, change.kind.type === "update" ? change.kind.move_path : null]);
}

/** Same operation on the same target, regardless of outcome. */
function getAttemptKey({ change }: NativeFileChange) {
  return getChangeAttemptKey(change);
}

function getFailureKey(entry: NativeFileChange) {
  return JSON.stringify([getAttemptKey(entry), entry.failureKind ?? null, entry.presentationLabel ?? null]);
}

// Deletes and moves never grow a row, so their outcome is never hidden inside an edit.
function isGrowableChange(change: Pick<CanonicalChange, "kind">) {
  return change.kind.type === "add" || (change.kind.type === "update" && !change.kind.move_path);
}

// Dangerous native changes never grow an applied row either.
function isGrowable(entry: NativeFileChange) {
  return !entry.danger && isGrowableChange(entry.change);
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

/** Only applied changes grow; anything with an outcome or recovery note of its own keeps its own rows. */
function isGrowableCanonicalItem(item: WorkbenchFileChangeItem) {
  return item.status === "completed" && item.workbenchRecovery?.state !== "failed";
}

function stitchCanonicalItem(item: WorkbenchFileChangeItem, open: OpenRun | null, groups: FileOperationRenderGroup[]): OpenRun | null {
  if (!item.changes.length || !isGrowableCanonicalItem(item)) {
    groups.push({ item, kind: "fileChange", rows: item.changes.map((change, sourceChangeIndex) => ({ pieces: [{ change, item, sourceChangeIndex }] })) });
    return null;
  }
  let group: Extract<FileOperationRenderGroup, { kind: "fileChange" }> | null = null;
  for (const [sourceChangeIndex, change] of item.changes.entries()) {
    const piece = { change, item, sourceChangeIndex };
    const attempt = isGrowableChange(change) ? getChangeAttemptKey(change) : null;
    if (attempt && open?.kind === "fileChange" && open.attempt === attempt) {
      open.row.pieces.push(piece);
      continue;
    }
    const row: StitchedCanonicalFileRow = { pieces: [piece] };
    if (!group) {
      group = { item, kind: "fileChange", rows: [] };
      groups.push(group);
    }
    group.rows.push(row);
    open = attempt ? { attempt, kind: "fileChange", row } : null;
  }
  return open;
}

/**
 * How long a stitched row's work took: from its first timed piece starting (or first seen) to its last piece
 * finishing; no end while that piece still runs, and no span at all without timing.
 */
export function getStitchedRowSpan(
  items: readonly { id: string }[], timeline: readonly WorkbenchThreadItemTimelineEntry[] | undefined,
): { durationMs: number | null; startedAtMs: number } | null {
  const entries = items.map(item => findWorkbenchThreadItemTimelineEntry(item.id, timeline));
  const startedAtMs = entries.map(entry => entry?.startedAt ?? entry?.firstSeenAt ?? null).find(time => time !== null);
  if (startedAtMs === undefined || startedAtMs === null) return null;
  const completedAt = entries.at(-1)?.completedAt ?? null;
  return { durationMs: completedAt === null ? null : Math.max(0, completedAt - startedAtMs), startedAtMs };
}

export function stitchFileOperationRows(items: readonly (WorkbenchFileChangeItem | NativeFileOperationItem)[]) {
  const groups: FileOperationRenderGroup[] = [];
  let open: OpenRun | null = null;
  for (const item of items) {
    if (item.type === "fileChange") {
      open = stitchCanonicalItem(item, open, groups);
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
      const nativeOpen = open?.kind === "native" ? open : null;
      const { joins, run } = stitchPiece(nativeOpen, piece);
      if (joins && nativeOpen) {
        nativeOpen.row.pieces.push(piece);
        open = run && { ...run, kind: "native", row: nativeOpen.row };
        continue;
      }
      const row: StitchedNativeFileRow = { pieces: [piece] };
      if (!group) {
        group = { kind: "native", item, rows: [] };
        groups.push(group);
      }
      group.rows.push(row);
      open = run && { ...run, kind: "native", row };
    }
  }
  return groups;
}
