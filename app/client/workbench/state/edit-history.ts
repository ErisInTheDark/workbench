/**
 * Exports:
 * - cloneHistorySelectionPoint: copy a stored history selection point. Keywords: edit history, undo, redo, selection, cursor.
 * - cloneHistorySelection: copy a stored history selection range. Keywords: edit history, undo, redo, selection, range.
 * - cloneHistoryPatch: copy a text patch record. Keywords: edit history, patch, undo, redo, diff.
 * - cloneHistoryFrame: copy a history frame including its patch or snapshot payload. Keywords: edit history, frame, snapshot, patch, undo.
 * - cloneEditHistory: deep-clone an edit history state. Keywords: edit history, state, undo, redo, clone.
 * - createInitialEditHistory: seed history with a snapshot frame for current content. Keywords: edit history, initialization, snapshot, undo, redo.
 * - applyHistoryPatch: apply a patch to content and return the updated text. Keywords: edit history, patch application, content, diff.
 * - materializeHistoryContent: rebuild content at a specific history index from snapshots and patches. Keywords: edit history, materialize, snapshot, patch, undo.
 * - getCurrentHistoryContent: read the content at the current history cursor. Keywords: edit history, current state, undo, redo, content.
 * - countHistoryStatesSinceSnapshot: count patch frames since the latest snapshot. Keywords: edit history, snapshot cadence, patch count, compaction.
 * - createHistoryPatch: derive the minimal changed range between two content strings. Keywords: edit history, diff, patch, text change.
 * - mergeHistoryPatches: combine adjacent insert or delete patches within the merge window. Keywords: edit history, patch merge, undo grouping, typing.
 * - normalizeEditHistory: validate or rebuild persisted history against current content. Keywords: edit history, normalization, persistence, recovery.
 * - trimEditHistory: cap history length while preserving a snapshot base frame. Keywords: edit history, trim, limit, snapshot, persistence.
 */

export interface EditHistoryPatch {
  deletedText: string;
  insertedText: string;
  start: number;
}

/** A block's element-child position path from the editor, and the characters before the point inside that block. */
export interface EditHistorySelectionPoint {
  offset: number;
  path: number[];
}

/** Rich selections name blocks; `source` selections are offsets into the markdown text of source mode (empty paths). */
export interface EditHistorySelection {
  end: EditHistorySelectionPoint;
  source?: true;
  start: EditHistorySelectionPoint;
}

/** Where the selection was when the change began and once it was made; undo restores `before`, redo `after`. */
interface EditHistoryFrameSelections {
  after?: EditHistorySelection | null;
  before?: EditHistorySelection | null;
}

export type EditHistoryFrame = EditHistoryFrameSelections & (
  | {
    type: "snapshot";
    content: string;
    timestamp: number;
  }
  | {
    type: "patch";
    patch: EditHistoryPatch;
    timestamp: number;
  });

export interface EditHistoryState {
  currentIndex: number;
  frames: EditHistoryFrame[];
  /** The selection as it is now; it becomes the next change's `before` and is where a reopened file resumes. */
  selection?: EditHistorySelection | null;
}

export const HISTORY_MERGE_WINDOW_MS = 1600;
export const HISTORY_STATE_LIMIT = 200;

export function cloneHistorySelectionPoint (point: EditHistorySelectionPoint): EditHistorySelectionPoint {
  return {
    offset: point.offset,
    path: [...point.path],
  };
}

export function cloneHistorySelection (selection: EditHistorySelection | null): EditHistorySelection | null {
  if (!selection) {
    return null;
  }

  return {
    start: cloneHistorySelectionPoint(selection.start),
    end: cloneHistorySelectionPoint(selection.end),
    ...(selection.source ? { source: true as const } : {}),
  };
}

export function cloneHistoryPatch (patch: EditHistoryPatch): EditHistoryPatch {
  return { ...patch };
}

function cloneFrameSelections (frame: EditHistoryFrameSelections): EditHistoryFrameSelections {
  return { after: cloneHistorySelection(frame.after ?? null), before: cloneHistorySelection(frame.before ?? null) };
}

export function cloneHistoryFrame (frame: EditHistoryFrame): EditHistoryFrame {
  if (frame.type === "snapshot") {
    return {
      type: "snapshot",
      content: frame.content,
      timestamp: frame.timestamp,
      ...cloneFrameSelections(frame),
    };
  }

  return {
    type: "patch",
    patch: cloneHistoryPatch(frame.patch),
    timestamp: frame.timestamp,
    ...cloneFrameSelections(frame),
  };
}

export function cloneEditHistory (history: EditHistoryState | null): EditHistoryState | null {
  if (!history) {
    return null;
  }

  return {
    currentIndex: history.currentIndex,
    frames: history.frames.map((frame) => cloneHistoryFrame(frame)),
    selection: cloneHistorySelection(history.selection ?? null),
  };
}

export function createInitialEditHistory (content: string, selection: EditHistorySelection | null = null): EditHistoryState {
  return {
    currentIndex: 0,
    frames: [{
      type: "snapshot",
      content,
      timestamp: Date.now(),
    }],
    selection: cloneHistorySelection(selection),
  };
}

export function applyHistoryPatch (content: string, patch: EditHistoryPatch) {
  return `${content.slice(0, patch.start)}${patch.insertedText}${content.slice(patch.start + patch.deletedText.length)}`;
}

export function materializeHistoryContent (history: EditHistoryState, targetIndex: number) {
  const clampedIndex = Math.max(0, Math.min(targetIndex, history.frames.length - 1));
  let snapshotIndex = clampedIndex;

  while (snapshotIndex > 0 && history.frames[snapshotIndex].type !== "snapshot") {
    snapshotIndex -= 1;
  }

  const snapshotFrame = history.frames[snapshotIndex];
  let content = snapshotFrame.type === "snapshot" ? snapshotFrame.content : "";

  for (let index = snapshotIndex + 1; index <= clampedIndex; index += 1) {
    const frame = history.frames[index];
    if (frame.type === "snapshot") {
      content = frame.content;
      continue;
    }

    content = applyHistoryPatch(content, frame.patch);
  }

  return content;
}

export function getCurrentHistoryContent (history: EditHistoryState | null) {
  if (!history || !history.frames.length) {
    return "";
  }

  return materializeHistoryContent(history, history.currentIndex);
}

export function countHistoryStatesSinceSnapshot (history: EditHistoryState) {
  let count = 0;

  for (let index = history.frames.length - 1; index >= 0; index -= 1) {
    if (history.frames[index].type === "snapshot") {
      break;
    }

    count += 1;
  }

  return count;
}

export function createHistoryPatch (previousContent: string, nextContent: string): EditHistoryPatch | null {
  if (previousContent === nextContent) {
    return null;
  }

  let start = 0;
  while (
    start < previousContent.length
    && start < nextContent.length
    && previousContent[start] === nextContent[start]
  ) {
    start += 1;
  }

  let previousEnd = previousContent.length;
  let nextEnd = nextContent.length;
  while (
    previousEnd > start
    && nextEnd > start
    && previousContent[previousEnd - 1] === nextContent[nextEnd - 1]
  ) {
    previousEnd -= 1;
    nextEnd -= 1;
  }

  return {
    start,
    deletedText: previousContent.slice(start, previousEnd),
    insertedText: nextContent.slice(start, nextEnd),
  };
}

/** Typing or deleting runs join into one frame that keeps where the run began and ends where it stopped. */
export function mergeHistoryPatches (
  previousFrame: Extract<EditHistoryFrame, { type: "patch" }>,
  nextPatch: EditHistoryPatch,
  nextSelection: EditHistorySelection | null,
  nextTimestamp: number,
): EditHistoryFrame | null {
  if (nextTimestamp - previousFrame.timestamp > HISTORY_MERGE_WINDOW_MS) {
    return null;
  }

  const merged = (patch: EditHistoryPatch): EditHistoryFrame => ({
    type: "patch",
    timestamp: nextTimestamp,
    patch,
    before: cloneHistorySelection(previousFrame.before ?? null),
    after: cloneHistorySelection(nextSelection),
  });
  const previousPatch = previousFrame.patch;
  const previousInsertOnly = previousPatch.deletedText === "" && previousPatch.insertedText.length > 0;
  const nextInsertOnly = nextPatch.deletedText === "" && nextPatch.insertedText.length > 0;
  if (previousInsertOnly && nextInsertOnly) {
    if (nextPatch.start === previousPatch.start + previousPatch.insertedText.length) {
      return merged({
        start: previousPatch.start,
        deletedText: "",
        insertedText: `${previousPatch.insertedText}${nextPatch.insertedText}`,
      });
    }

    if (nextPatch.start === previousPatch.start) {
      return merged({
        start: previousPatch.start,
        deletedText: "",
        insertedText: `${nextPatch.insertedText}${previousPatch.insertedText}`,
      });
    }
  }

  const previousDeleteOnly = previousPatch.insertedText === "" && previousPatch.deletedText.length > 0;
  const nextDeleteOnly = nextPatch.insertedText === "" && nextPatch.deletedText.length > 0;
  if (previousDeleteOnly && nextDeleteOnly) {
    if (nextPatch.start === previousPatch.start) {
      return merged({
        start: previousPatch.start,
        insertedText: "",
        deletedText: `${previousPatch.deletedText}${nextPatch.deletedText}`,
      });
    }

    if (nextPatch.start + nextPatch.deletedText.length === previousPatch.start) {
      return merged({
        start: nextPatch.start,
        insertedText: "",
        deletedText: `${nextPatch.deletedText}${previousPatch.deletedText}`,
      });
    }
  }

  return null;
}

export function normalizeEditHistory (history: EditHistoryState | null, currentContent: string): EditHistoryState {
  if (!history?.frames.length) {
    return createInitialEditHistory(currentContent);
  }

  const nextHistory = cloneEditHistory(history) ?? createInitialEditHistory(currentContent);
  nextHistory.currentIndex = Math.max(0, Math.min(nextHistory.currentIndex, nextHistory.frames.length - 1));
  if (getCurrentHistoryContent(nextHistory) !== currentContent) {
    return createInitialEditHistory(currentContent);
  }

  return nextHistory;
}

export function trimEditHistory (history: EditHistoryState) {
  if (history.frames.length <= HISTORY_STATE_LIMIT) {
    return history;
  }

  let sliceStart = history.frames.length - HISTORY_STATE_LIMIT;
  if (history.currentIndex < sliceStart) {
    sliceStart = history.currentIndex;
  }

  const snapshotContent = materializeHistoryContent(history, sliceStart);
  const baseFrame = history.frames[sliceStart];
  const trimmedFrames: EditHistoryFrame[] = [{
    type: "snapshot",
    content: snapshotContent,
    timestamp: baseFrame?.timestamp ?? Date.now(),
    ...cloneFrameSelections(baseFrame ?? {}),
  }, ...history.frames.slice(sliceStart + 1).map((frame) => cloneHistoryFrame(frame))];

  history.frames = trimmedFrames.slice(0, HISTORY_STATE_LIMIT);
  history.currentIndex = Math.max(0, Math.min(history.currentIndex - sliceStart, history.frames.length - 1));
  return history;
}
