/*
 * Exports:
 * - default WorkbenchThreadRecordStore: own canonical provider and projected sidebar entries for one project, with a write version.
 */

import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import { currentThreadTitleName, dismissThreadTitle, recordThreadTitle } from "workbench-shared/workbench/thread/thread-title-history";
import {
  parseWorkbenchThreadStateEntry,
  type WorkbenchThreadStateEntry,
} from "./workbench-thread-state-record";

/** Counts every effective write, so derived views of the entries can tell they are stale without rescanning them. */
class VersionedEntryMap extends Map<string, WorkbenchThreadStateEntry> {
  version = 0;

  constructor(entries: Iterable<readonly [string, WorkbenchThreadStateEntry]>) {
    super();
    for (const [key, entry] of entries) super.set(key, entry);
  }

  override set(key: string, entry: WorkbenchThreadStateEntry) {
    if (!this.has(key) || this.get(key) !== entry) this.version++;
    return super.set(key, entry);
  }

  override delete(key: string) {
    const deleted = super.delete(key);
    if (deleted) this.version++;
    return deleted;
  }

  override clear() {
    if (this.size) this.version++;
    super.clear();
  }
}

export default class WorkbenchThreadRecordStore {
  readonly entries: Map<string, WorkbenchThreadStateEntry>;
  readonly #entries: VersionedEntryMap;

  constructor(entries: Iterable<readonly [string, WorkbenchThreadStateEntry]> = []) {
    this.#entries = new VersionedEntryMap(entries);
    this.entries = this.#entries;
  }

  /** Changes whenever an entry is added, replaced or removed. */
  get version() {
    return this.#entries.version;
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
