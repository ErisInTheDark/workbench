/*
 * Exports:
 * - default WorkbenchThreadRecordStore: own canonical provider and projected sidebar entries for one project.
 */

import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import { currentThreadTitleName, dismissThreadTitle, recordThreadTitle } from "workbench-shared/workbench/thread/thread-title-history";
import {
  parseWorkbenchThreadStateEntry,
  type WorkbenchThreadStateEntry,
} from "./workbench-thread-state-record";

export default class WorkbenchThreadRecordStore {
  readonly entries: Map<string, WorkbenchThreadStateEntry>;

  constructor(entries: Iterable<readonly [string, WorkbenchThreadStateEntry]> = []) {
    this.entries = new Map(entries);
  }

  clone() {
    return new WorkbenchThreadRecordStore(this.entries);
  }

  get(key: string) {
    return this.entries.get(key);
  }

  set(key: string, entry: WorkbenchThreadStateEntry) {
    this.entries.set(key, entry);
  }

  delete(key: string) {
    return this.entries.delete(key);
  }

  snapshot() {
    return new Map(this.entries);
  }

  setTitle(key: string, title: string, usedAt: number) {
    const entry = this.entries.get(key);
    if (!entry || entry.entryKind === "draft") return null;
    // The recorded title owns the mutation comparison; `entry.title` is only a display label.
    const currentTitle = currentThreadTitleName(entry.titleHistory ?? []) ?? "";
    const next = parseWorkbenchThreadStateEntry({
      ...entry,
      title,
      titleHistory: recordThreadTitle(entry.titleHistory ?? [], currentTitle, title, usedAt),
    });
    if (next.entryKind === "draft") return null;
    const changed = !areDeeplyEqual(entry, next);
    if (changed) this.entries.set(key, next);
    return { changed, next, previous: entry };
  }

  dismissTitle(key: string, title: string) {
    const entry = this.entries.get(key);
    if (!entry || entry.entryKind === "draft") return null;
    // Protect the recorded current title, not a provider label that drifted into `entry.title`.
    const currentTitle = currentThreadTitleName(entry.titleHistory ?? []) ?? "";
    if (title === currentTitle) return { accepted: false, changed: false, next: entry };
    const titleHistory = dismissThreadTitle(entry.titleHistory ?? [], currentTitle, title);
    const changed = !areDeeplyEqual(titleHistory, entry.titleHistory ?? []);
    const next = changed ? { ...entry, titleHistory } : entry;
    if (changed) this.entries.set(key, next);
    return { accepted: true, changed, next };
  }
}
