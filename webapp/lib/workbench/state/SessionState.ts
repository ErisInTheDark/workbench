/*
 * Exports:
 * - SessionStateSnapshot: readonly projection of the active file or thread selection. Keywords: workbench, session, selection, snapshot.
 * - SessionStateListener: subscriber signature for selection changes. Keywords: workbench, session, selection, subscribe.
 * - SessionState: mutable selection state owner for the active workbench target. Keywords: workbench, session, selection, state.
 * - default SessionState: create the selection state owner used by the coordinator and file workflow. Keywords: workbench, session, selection, create, default export.
 */

import type { ThreadPayload } from "../../types";

export interface SessionStateSnapshot {
  currentPath: string;
  currentThread: ThreadPayload | null;
  currentThreadId: string;
}

export type SessionStateListener = (snapshot: SessionStateSnapshot) => void;

interface SessionState extends SessionStateSnapshot {
  getSnapshot: () => SessionStateSnapshot;
  subscribe: (listener: SessionStateListener) => () => void;
}

function createInitialSessionSnapshot(
  initial: Partial<SessionStateSnapshot> = {},
): SessionStateSnapshot {
  return {
    currentPath: initial.currentPath ?? "",
    currentThread: initial.currentThread ?? null,
    currentThreadId: initial.currentThreadId ?? "",
  };
}

function SessionState(initial: Partial<SessionStateSnapshot> = {}): SessionState {
  const listeners = new Set<SessionStateListener>();
  const state = createInitialSessionSnapshot(initial);

  function getSnapshot(): SessionStateSnapshot {
    return {
      currentPath: state.currentPath,
      currentThread: state.currentThread,
      currentThreadId: state.currentThreadId,
    };
  }

  function emit() {
    const snapshot = getSnapshot();
    for (const listener of listeners) {
      listener(snapshot);
    }
  }

  function subscribe(listener: SessionStateListener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return {
    get currentPath() {
      return state.currentPath;
    },
    set currentPath(value: string) {
      if (state.currentPath === value) {
        return;
      }

      state.currentPath = value;
      emit();
    },
    get currentThread() {
      return state.currentThread;
    },
    set currentThread(value: ThreadPayload | null) {
      if (state.currentThread === value) {
        return;
      }

      state.currentThread = value;
      emit();
    },
    get currentThreadId() {
      return state.currentThreadId;
    },
    set currentThreadId(value: string) {
      if (state.currentThreadId === value) {
        return;
      }

      state.currentThreadId = value;
      emit();
    },
    getSnapshot,
    subscribe,
  };
}

export default SessionState;