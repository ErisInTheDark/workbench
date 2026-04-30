/*
 * Exports:
 * - DraftBuffer: in-memory file draft state including persisted editor markup, conflicts, and save-guard metadata. Keywords: workbench, file, draft, buffer.
 * - FileSessionStateSnapshot: readonly projection of current file persistence and history state. Keywords: workbench, file, session, snapshot.
 * - FileSessionStateListener: subscriber signature for file-session updates. Keywords: workbench, file, session, subscribe.
 * - FileSessionState: mutable owner of file persistence, history, and save-guard state for the active file. Keywords: workbench, file, session, state.
 * - default FileSessionState: create the file-session state owner consumed by the coordinator and file client. Keywords: workbench, file, session, create, default export.
 */

import type { SaveConflictPayload } from "../../types";
import type { EditorMode, SaveGuardIssue } from "../WorkbenchEditorClient";
import { cloneEditHistory, type EditHistoryState } from "./edit-history";

export interface DraftBuffer {
  baselineContent: string;
  content: string;
  dirty: boolean;
  editorState: string;
  expectedMtimeMs: number | null;
  headContent: string | null;
  history: EditHistoryState;
  mode: EditorMode;
  pendingWriteConflict: SaveConflictPayload | null;
  saveIssue: SaveGuardIssue | null;
}

export interface FileSessionStateSnapshot {
  baselineContent: string;
  currentContent: string;
  draftBuffers: Map<string, DraftBuffer>;
  dirty: boolean;
  expectedMtimeMs: number | null;
  headContent: string | null;
  history: EditHistoryState | null;
  mode: EditorMode;
  pendingWriteConflict: SaveConflictPayload | null;
  saveIssue: SaveGuardIssue | null;
}

export type FileSessionStateListener = (snapshot: FileSessionStateSnapshot) => void;

interface FileSessionState extends FileSessionStateSnapshot {
  getSnapshot: () => FileSessionStateSnapshot;
  subscribe: (listener: FileSessionStateListener) => () => void;
}

function cloneDraftBuffer(buffer: DraftBuffer): DraftBuffer {
  return {
    baselineContent: buffer.baselineContent,
    content: buffer.content,
    dirty: buffer.dirty,
    editorState: buffer.editorState,
    expectedMtimeMs: buffer.expectedMtimeMs,
    headContent: buffer.headContent,
    history: cloneEditHistory(buffer.history) ?? buffer.history,
    mode: buffer.mode,
    pendingWriteConflict: buffer.pendingWriteConflict
      ? { ...buffer.pendingWriteConflict }
      : null,
    saveIssue: buffer.saveIssue
      ? { ...buffer.saveIssue }
      : null,
  };
}

function createInitialFileSessionSnapshot(
  initial: Partial<FileSessionStateSnapshot> = {},
): FileSessionStateSnapshot {
  return {
    baselineContent: initial.baselineContent ?? "",
    currentContent: initial.currentContent ?? "",
    draftBuffers: initial.draftBuffers ? new Map(initial.draftBuffers) : new Map(),
    dirty: initial.dirty ?? false,
    expectedMtimeMs: initial.expectedMtimeMs ?? null,
    headContent: initial.headContent ?? null,
    history: initial.history ?? null,
    mode: initial.mode ?? "rich",
    pendingWriteConflict: initial.pendingWriteConflict ?? null,
    saveIssue: initial.saveIssue ?? null,
  };
}

function FileSessionState(initial: Partial<FileSessionStateSnapshot> = {}): FileSessionState {
  const listeners = new Set<FileSessionStateListener>();
  const state = createInitialFileSessionSnapshot(initial);

  function getSnapshot(): FileSessionStateSnapshot {
    return {
      baselineContent: state.baselineContent,
      currentContent: state.currentContent,
      draftBuffers: new Map(
        Array.from(state.draftBuffers.entries(), ([path, buffer]) => [path, cloneDraftBuffer(buffer)]),
      ),
      dirty: state.dirty,
      expectedMtimeMs: state.expectedMtimeMs,
      headContent: state.headContent,
      history: cloneEditHistory(state.history),
      mode: state.mode,
      pendingWriteConflict: state.pendingWriteConflict
        ? { ...state.pendingWriteConflict }
        : null,
      saveIssue: state.saveIssue
        ? { ...state.saveIssue }
        : null,
    };
  }

  function emit() {
    const snapshot = getSnapshot();
    for (const listener of listeners) {
      listener(snapshot);
    }
  }

  function subscribe(listener: FileSessionStateListener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return {
    get baselineContent() {
      return state.baselineContent;
    },
    set baselineContent(value: string) {
      if (state.baselineContent === value) {
        return;
      }

      state.baselineContent = value;
      emit();
    },
    get currentContent() {
      return state.currentContent;
    },
    set currentContent(value: string) {
      if (state.currentContent === value) {
        return;
      }

      state.currentContent = value;
      emit();
    },
    get draftBuffers() {
      return state.draftBuffers;
    },
    set draftBuffers(value: Map<string, DraftBuffer>) {
      state.draftBuffers = new Map(value);
      emit();
    },
    get dirty() {
      return state.dirty;
    },
    set dirty(value: boolean) {
      if (state.dirty === value) {
        return;
      }

      state.dirty = value;
      emit();
    },
    get expectedMtimeMs() {
      return state.expectedMtimeMs;
    },
    set expectedMtimeMs(value: number | null) {
      if (state.expectedMtimeMs === value) {
        return;
      }

      state.expectedMtimeMs = value;
      emit();
    },
    get headContent() {
      return state.headContent;
    },
    set headContent(value: string | null) {
      if (state.headContent === value) {
        return;
      }

      state.headContent = value;
      emit();
    },
    get history() {
      return state.history;
    },
    set history(value: EditHistoryState | null) {
      state.history = value;
      emit();
    },
    get mode() {
      return state.mode;
    },
    set mode(value: EditorMode) {
      if (state.mode === value) {
        return;
      }

      state.mode = value;
      emit();
    },
    get pendingWriteConflict() {
      return state.pendingWriteConflict;
    },
    set pendingWriteConflict(value: SaveConflictPayload | null) {
      state.pendingWriteConflict = value;
      emit();
    },
    get saveIssue() {
      return state.saveIssue;
    },
    set saveIssue(value: SaveGuardIssue | null) {
      state.saveIssue = value;
      emit();
    },
    getSnapshot,
    subscribe,
  };
}

export default FileSessionState;