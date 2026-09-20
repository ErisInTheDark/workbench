/*
 * Exports:
 * - default ThreadEntryMotionController: remember thread-owned logical entries across presentation remounts.
 * - getThreadEntryMotionIdentity: preserve user-input identity across optimistic and canonical item ids.
 * - getThreadFileChangeMotionIdentity: identify one streamed row within a file-change item.
 * - getThreadEntryMotionIdentities: enumerate one item's block and nested row motion identities.
 */

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";

export function getThreadEntryMotionIdentity(item: ThreadItem) {
  return item.type === "userMessage" && item.clientId
    ? `user:${item.clientId}`
    : `item:${item.id}`;
}

export function getThreadFileChangeMotionIdentity(itemId: string, changeIndex: number) {
  return `file-change:${itemId}:${changeIndex}`;
}

export function getThreadEntryMotionIdentities(item: ThreadItem) {
  return [
    getThreadEntryMotionIdentity(item),
    ...(item.type === "fileChange"
      ? item.changes.map((_change, index) => getThreadFileChangeMotionIdentity(item.id, index))
      : []),
  ];
}

export default class ThreadEntryMotionController {
  private readonly seen: Set<string>;

  constructor(initialIdentities: Iterable<string> = []) {
    this.seen = new Set(initialIdentities);
  }

  seed(identities: Iterable<string>) {
    for (const identity of identities) this.seen.add(identity);
  }

  shouldAnimate(identity: string) {
    return !this.seen.has(identity);
  }

  commit(identity: string) {
    this.seen.add(identity);
  }
}
