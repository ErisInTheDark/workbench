/*
 * Exports:
 * - default ThreadEntryMotionController: remember thread-owned logical entries across presentation remounts, admitting
 *   history that lands above seen entries without motion, and find entries an absorbing entry may slide from.
 * - getThreadEntryMotionIdentity: preserve user-input identity across optimistic and canonical item ids.
 * - getThreadFileChangeMotionIdentity: identify one streamed row within a file-change item.
 * - getThreadEntryMotionIdentities: enumerate one item's block and nested row motion identities.
 * - getProjectedEntryMotionIdentities: the same for any rendered transcript item, generic and interaction included.
 */

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { WorkbenchProjectedTranscriptItem } from "workbench-shared/workbench/transcript/workbench-transcript-projection";

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

/** Every rendered transcript item, including generic and interaction items the provider-item turns leave out. */
export function getProjectedEntryMotionIdentities(item: WorkbenchProjectedTranscriptItem) {
  return item.type === "generic" || "requestKey" in item
    ? [`item:${item.id}`]
    : getThreadEntryMotionIdentities(item);
}

type TrackedElement = Pick<Element, "getBoundingClientRect">;

export default class ThreadEntryMotionController {
  private readonly seen: Set<string>;
  private readonly tracked = new Map<string, TrackedElement>();

  constructor(initialIdentities: Iterable<string> = []) {
    this.seen = new Set(initialIdentities);
  }

  seed(identities: Iterable<string>) {
    for (const identity of identities) this.seen.add(identity);
  }

  /** Unseen entries ordered before the newest seen one are history arriving above the reader, never new activity. */
  admit(ordered: readonly string[]) {
    let newestSeen = -1;
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      if (this.seen.has(ordered[index]!)) {
        newestSeen = index;
        break;
      }
    }
    for (let index = 0; index < newestSeen; index += 1) this.seen.add(ordered[index]!);
  }

  shouldAnimate(identity: string) {
    return !this.seen.has(identity);
  }

  commit(identity: string) {
    this.seen.add(identity);
  }

  /** Keep a mounted entry findable while it could be absorbed; returns its untrack. */
  track(identity: string, element: TrackedElement) {
    this.tracked.set(identity, element);
    return () => { if (this.tracked.get(identity) === element) this.tracked.delete(identity); };
  }

  /**
   * Where a tracked entry is now. An absorbing entry asks while it renders, before the commit removes what it absorbs
   * and everything below shifts up.
   */
  topOf(identity: string) {
    return this.tracked.get(identity)?.getBoundingClientRect().top ?? null;
  }
}
