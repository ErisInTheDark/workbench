/*
 * Exports:
 * - createThreadDocumentKey: build the harness-scoped identity key for a thread document.
 * - createThreadDocumentKeyForThread: build a document key from a thread payload.
 * - getThreadDocumentFromSnapshot: resolve a thread payload from a document snapshot by thread id.
 */

import type { ThreadPayload, WorkbenchHarness, WorkbenchThreadDocumentSnapshot } from "workbench-shared/types";
import { ThreadDocumentKeySchema, type DraftId, type WorkbenchThreadId } from "workbench-shared/workbench/identity";

export function createThreadDocumentKey(harness: WorkbenchHarness, threadId: WorkbenchThreadId | DraftId) {
  return ThreadDocumentKeySchema.parse(`${harness}:${threadId}`);
}

export function createThreadDocumentKeyForThread(thread: Pick<ThreadPayload, "harness" | "id">) {
  return createThreadDocumentKey(thread.harness, thread.id);
}

export function getThreadDocumentFromSnapshot(
  snapshot: WorkbenchThreadDocumentSnapshot,
  threadId: string,
) {
  const key = snapshot.keysByThreadId[threadId] ?? "";
  return key ? snapshot.documentsByKey[key] ?? null : null;
}
