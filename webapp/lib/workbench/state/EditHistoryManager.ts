/*
 * Exports:
 * - EditHistoryManagerOptions: coordinator-owned callbacks and state accessors required to manage undo, redo, and history replay. Keywords: workbench, edit history, manager, coordinator.
 * - EditHistoryReplayRequest: replay payload delegated back to the coordinator so history replay can use the shared editor mutation pipeline. Keywords: workbench, edit history, replay, coordinator.
 * - EditHistoryManager: public surface for history selection tracking, recording, replay, undo, and redo. Keywords: workbench, edit history, undo, redo, selection.
 * - createEditHistoryManager: create the history manager that owns edit-history mutations while delegating DOM rendering back to the coordinator. Keywords: workbench, edit history, manager, replay.
 */

import {
    cloneHistorySelection,
    countHistoryStatesSinceSnapshot,
    createHistoryPatch,
    materializeHistoryContent,
    mergeHistoryPatches,
    normalizeEditHistory,
    trimEditHistory,
    type EditHistorySelection,
    type EditHistoryState,
} from "./edit-history";

export interface EditHistoryReplayRequest {
  content: string;
  selection: EditHistorySelection | null;
}

export interface EditHistoryManagerOptions {
  applyHistoryReplay: (request: EditHistoryReplayRequest) => void;
  getCurrentContent: () => string;
  getHistory: () => EditHistoryState | null;
  historyKeyframeInterval: number;
  setHistory: (history: EditHistoryState | null) => void;
}

export interface EditHistoryManager {
  applyHistoryState: (history: EditHistoryState, nextIndex: number) => void;
  recordEditHistory: (previousContent: string, nextContent: string, selection: EditHistorySelection | null) => void;
  redoEditHistory: () => void;
  undoEditHistory: () => void;
  updateHistorySelection: (selection: EditHistorySelection | null) => void;
}

export function EditHistoryManager(options: EditHistoryManagerOptions): EditHistoryManager {
  function updateHistorySelection(selection: EditHistorySelection | null) {
    const history = options.getHistory();
    if (!history?.frames.length) {
      return;
    }

    history.frames[history.currentIndex].selection = cloneHistorySelection(selection);
  }

  function recordEditHistory(previousContent: string, nextContent: string, selection: EditHistorySelection | null) {
    if (previousContent === nextContent) {
      updateHistorySelection(selection);
      return;
    }

    const nextHistory = normalizeEditHistory(options.getHistory(), previousContent);
    if (nextHistory.currentIndex < nextHistory.frames.length - 1) {
      nextHistory.frames = nextHistory.frames.slice(0, nextHistory.currentIndex + 1);
    }

    const patch = createHistoryPatch(previousContent, nextContent);
    if (!patch) {
      options.setHistory(nextHistory);
      updateHistorySelection(selection);
      return;
    }

    const timestamp = Date.now();
    const previousFrame = nextHistory.frames.at(-1);
    if (previousFrame?.type === "patch") {
      const mergedFrame = mergeHistoryPatches(previousFrame, patch, selection, timestamp);
      if (mergedFrame) {
        nextHistory.frames[nextHistory.frames.length - 1] = mergedFrame;
        nextHistory.currentIndex = nextHistory.frames.length - 1;
        options.setHistory(trimEditHistory(nextHistory));
        return;
      }
    }

    const shouldCreateSnapshot = countHistoryStatesSinceSnapshot(nextHistory) >= options.historyKeyframeInterval - 1;
    nextHistory.frames.push(shouldCreateSnapshot
      ? {
        type: "snapshot",
        content: nextContent,
        selection: cloneHistorySelection(selection),
        timestamp,
      }
      : {
        type: "patch",
        patch,
        selection: cloneHistorySelection(selection),
        timestamp,
      });
    nextHistory.currentIndex = nextHistory.frames.length - 1;
    options.setHistory(trimEditHistory(nextHistory));
  }

  function applyHistoryState(history: EditHistoryState, nextIndex: number) {
    const clampedIndex = Math.max(0, Math.min(nextIndex, history.frames.length - 1));
    const nextContent = materializeHistoryContent(history, clampedIndex);
    history.currentIndex = clampedIndex;
    options.setHistory(history);
    options.applyHistoryReplay({
      content: nextContent,
      selection: history.frames[clampedIndex]?.selection ?? null,
    });
  }

  function undoEditHistory() {
    const history = options.getHistory();
    if (!history || history.currentIndex <= 0) {
      return;
    }

    applyHistoryState(normalizeEditHistory(history, options.getCurrentContent()), history.currentIndex - 1);
  }

  function redoEditHistory() {
    const history = options.getHistory();
    if (!history || history.currentIndex >= history.frames.length - 1) {
      return;
    }

    applyHistoryState(normalizeEditHistory(history, options.getCurrentContent()), history.currentIndex + 1);
  }

  return {
    applyHistoryState,
    recordEditHistory,
    redoEditHistory,
    undoEditHistory,
    updateHistorySelection,
  };
}