/*
 * Exports:
 * - createThreadDocumentKey: build the harness-scoped identity key for a thread document. Keywords: thread, document, identity, harness.
 * - createThreadDocumentKeyForThread: build a document key from a thread payload. Keywords: thread, document, payload, identity.
 * - getThreadDocumentFromSnapshot: resolve a thread payload from a document snapshot by thread id. Keywords: thread, document, snapshot, lookup.
 */

import type { ThreadPayload, WorkbenchHarness, WorkbenchThreadDocumentSnapshot } from "../../types";

export function createThreadDocumentKey(harness: WorkbenchHarness, threadId: string) {
  return `${harness}:${threadId}`;
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
