/*
 * Exports:
 * - WorkbenchThreadRuntimeController: internal accept port plus the provider-facing thread runtime store. Keywords: thread runtime, React, domain hook.
 * - default WorkbenchThreadRuntimeStore: cache and publish route-owned thread runtime state with stable snapshots. Keywords: thread, external store, selection.
 */

import type { WorkbenchThreadRuntimeSnapshot, WorkbenchThreadRuntimeStore as WorkbenchThreadRuntimeStoreContract } from "../types";
import { areDeeplyEqual } from "./deep-equality";

export interface WorkbenchThreadRuntimeController extends WorkbenchThreadRuntimeStoreContract {
  accept: (snapshot: WorkbenchThreadRuntimeSnapshot) => void;
}

function areWorkbenchThreadRuntimeSnapshotsEquivalent(
  left: WorkbenchThreadRuntimeSnapshot,
  right: WorkbenchThreadRuntimeSnapshot,
) {
  return left.currentThreadId === right.currentThreadId
    && areDeeplyEqual(left.currentThread, right.currentThread)
    && left.isLoading === right.isLoading
    && areDeeplyEqual(left.pendingUserInputRequestsByThreadId, right.pendingUserInputRequestsByThreadId)
    && left.rateLimits === right.rateLimits
    && left.subagents === right.subagents
    && left.threadDocuments === right.threadDocuments
    && left.threads === right.threads
    && left.threadsError === right.threadsError;
}

export default function WorkbenchThreadRuntimeStore(
  initialSnapshot: WorkbenchThreadRuntimeSnapshot,
): WorkbenchThreadRuntimeController {
  const listeners = new Set<() => void>();
  let snapshot = initialSnapshot;

  return {
    accept(nextSnapshot) {
      if (areWorkbenchThreadRuntimeSnapshotsEquivalent(snapshot, nextSnapshot)) {
        return;
      }
      snapshot = nextSnapshot;
      for (const listener of listeners) listener();
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
