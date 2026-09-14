/*
 * Exports:
 * - default ThreadSidebarProjectState: admit complete project state and replay uncovered activity fields.
 */
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import { resolveWorkbenchThreadDisplayOrder } from "workbench-shared/workbench/thread/thread-display-order";
import {
  createWorkbenchProjectThreadSummary,
  type WorkbenchProjectThreadSummary,
  type WorkbenchThreadActivityUpdate,
  type WorkbenchThreadStateDelta,
  type WorkbenchThreadSidebarEntry,
  type WorkbenchThreadSidebarSnapshot,
} from "workbench-shared/workbench/thread/thread-state";

interface RevisedValue<T> {
  revision: number;
  value: T;
}
interface ActivityFields {
  activityAt?: RevisedValue<number>;
  orderAt?: RevisedValue<number>;
}

export default class ThreadSidebarProjectState {
  private sidebar: WorkbenchThreadSidebarSnapshot | null = null;
  private summary: WorkbenchProjectThreadSummary | null = null;
  // Rendered revisions can include sparse fields. Only complete deliveries
  // advance these watermarks; an activity event cannot cover a title or status.
  private sidebarRevision = -1;
  private summaryRevision = -1;
  private readonly activity = new Map<string, ActivityFields>();
  private readonly changedEntries = new Map<string, RevisedValue<WorkbenchThreadSidebarEntry | null>>();
  private delivery: RevisedValue<Pick<WorkbenchThreadSidebarSnapshot, "error" | "freshness">> | null = null;
  private displayOrder: RevisedValue<NonNullable<WorkbenchThreadActivityUpdate["displayOrder"]>> | null = null;

  readonly getSnapshot = () => this.sidebar;
  readonly getSummary = () => this.summary;
  readonly hasAdmission = () => this.sidebarRevision >= 0 || this.summaryRevision >= 0 || this.activity.size > 0 || this.changedEntries.size > 0 || this.displayOrder !== null;

  resetAdmission() {
    this.sidebarRevision = -1;
    this.summaryRevision = -1;
    this.activity.clear();
    this.changedEntries.clear();
    this.delivery = null;
    this.displayOrder = null;
  }

  acceptSidebar(snapshot: WorkbenchThreadSidebarSnapshot) {
    if (snapshot.revision <= this.sidebarRevision) return false;
    this.sidebarRevision = snapshot.revision;
    this.sidebar = this.withActivity(snapshot, true);
    this.syncSummary();
    this.retireCoveredFields();
    return true;
  }

  acceptSummary(summary: WorkbenchProjectThreadSummary) {
    if (summary.revision < this.summaryRevision) return false;
    this.summaryRevision = summary.revision;
    const next = this.withSummaryActivity(summary);
    const changed = !areDeeplyEqual(this.summary, next);
    if (changed) this.summary = next;
    this.retireCoveredFields();
    return changed;
  }

  acceptActivity(update: WorkbenchThreadActivityUpdate) {
    const floor = this.summary ? Math.min(this.sidebarRevision, this.summaryRevision) : this.sidebarRevision;
    const key = this.threadKey(update.identity);
    const fields = this.activity.get(key) ?? {};
    let changed = false;
    if (update.revision > Math.max(floor, fields.activityAt?.revision ?? -1)) {
      fields.activityAt = { revision: update.revision, value: update.activityAt };
      changed = true;
    }
    if (update.orderAt !== undefined && update.revision > Math.max(this.sidebarRevision, fields.orderAt?.revision ?? -1)) {
      fields.orderAt = { revision: update.revision, value: update.orderAt };
      changed = true;
    }
    if (fields.activityAt || fields.orderAt) this.activity.set(key, fields);
    if (update.displayOrder !== undefined && update.revision > Math.max(this.sidebarRevision, this.displayOrder?.revision ?? -1)) {
      this.displayOrder = { revision: update.revision, value: update.displayOrder };
      changed = true;
    }
    if (!changed) return false;
    const previousSidebar = this.sidebar;
    const previousSummary = this.summary;
    if (this.sidebar) {
      const next = this.withActivity(this.sidebar);
      if (!areDeeplyEqual(next, this.sidebar)) this.sidebar = next;
      this.syncSummary();
    }
    if (this.summary) {
      const next = this.withSummaryActivity(this.summary);
      if (!areDeeplyEqual(next, this.summary)) this.summary = next;
    }
    return this.sidebar !== previousSidebar || this.summary !== previousSummary;
  }

  acceptDelta(update: WorkbenchThreadStateDelta) {
    let admitted = false;
    const entries = new Map(this.sidebar?.entries.map(entry => [this.entryKey(entry), entry]) ?? []);
    const accept = (key: string, value: WorkbenchThreadSidebarEntry | null) => {
      if (update.revision <= Math.max(this.sidebarRevision, this.changedEntries.get(key)?.revision ?? -1)) return;
      this.changedEntries.set(key, { revision: update.revision, value });
      const local = entries.get(key);
      if (!value) entries.delete(key);
      else if (!(local?.entryKind === "draft" && value.entryKind === "draft"
        && local.draft.clientUpdatedAt > value.draft.clientUpdatedAt)) entries.set(key, value);
      admitted = true;
    };
    for (const entry of update.upserts) accept(this.entryKey(entry), entry);
    for (const key of update.removedKeys) accept(key, null);
    if (update.revision > Math.max(this.sidebarRevision, this.delivery?.revision ?? -1)) {
      this.delivery = { revision: update.revision, value: { error: update.error, freshness: update.freshness } };
      admitted = true;
    }
    if (update.displayOrder !== undefined && update.revision > Math.max(this.sidebarRevision, this.displayOrder?.revision ?? -1)) {
      this.displayOrder = { revision: update.revision, value: update.displayOrder };
      admitted = true;
    }
    if (!admitted || !this.sidebar) return false;
    this.sidebar = this.withActivity({ ...this.sidebar, entries: [...entries.values()], revision: Math.max(this.sidebar.revision, update.revision) });
    this.syncSummary();
    return true;
  }

  replaceLocalSidebar(snapshot: WorkbenchThreadSidebarSnapshot) {
    // Draft edits and accepted intents are local projections, not server receipts.
    this.sidebar = snapshot;
  }

  syncSummary() {
    if (!this.sidebar || this.sidebarRevision < 0 || this.sidebarRevision < this.summaryRevision) return;
    this.acceptSummary(createWorkbenchProjectThreadSummary(
      this.sidebar.projectId, this.sidebar.entries, this.sidebarRevision, this.sidebar.displayOrder,
    ));
  }

  private withActivity(snapshot: WorkbenchThreadSidebarSnapshot, replayEntries = false): WorkbenchThreadSidebarSnapshot {
    let revision = snapshot.revision;
    const merged = new Map(snapshot.entries.map(entry => [this.entryKey(entry), entry]));
    for (const [key, change] of this.changedEntries) {
      if (!replayEntries || change.revision <= this.sidebarRevision) continue;
      revision = Math.max(revision, change.revision);
      if (change.value === null) {
        merged.delete(key);
      } else {
        const local = merged.get(key);
        if (local?.entryKind === "draft" && change.value.entryKind === "draft"
          && local.draft.clientUpdatedAt > change.value.draft.clientUpdatedAt) continue;
        merged.set(key, change.value);
      }
    }
    const entries = [...merged.values()].map((entry) => {
      if (entry.entryKind === "draft") return entry;
      const fields = this.activity.get(this.threadKey(entry.identity));
      const floor = Math.max(this.sidebarRevision, this.changedEntries.get(this.entryKey(entry))?.revision ?? -1);
      const activityAt = fields?.activityAt && fields.activityAt.revision > floor ? fields.activityAt : null;
      const orderAt = fields?.orderAt && fields.orderAt.revision > floor ? fields.orderAt : null;
      if (!activityAt && (!orderAt || entry.entryKind !== "thread")) return entry;
      revision = Math.max(revision, activityAt?.revision ?? -1, orderAt?.revision ?? -1);
      return {
        ...entry,
        ...(activityAt ? { activityAt: activityAt.value } : {}),
        ...(orderAt && entry.entryKind === "thread" ? { orderAt: orderAt.value } : {}),
      };
    });
    const displayOrder = this.displayOrder && this.displayOrder.revision > this.sidebarRevision
      ? this.displayOrder : null;
    if (displayOrder) revision = Math.max(revision, displayOrder.revision);
    const delivery = this.delivery && this.delivery.revision > this.sidebarRevision ? this.delivery : null;
    if (delivery) revision = Math.max(revision, delivery.revision);
    return {
      ...snapshot,
      ...delivery?.value,
      ...resolveWorkbenchThreadDisplayOrder(entries, displayOrder?.value ?? snapshot.displayOrder),
      revision,
    };
  }

  private withSummaryActivity(summary: WorkbenchProjectThreadSummary): WorkbenchProjectThreadSummary {
    let revision = summary.revision;
    let lastThreadUpdateAt = summary.lastThreadUpdateAt;
    for (const fields of this.activity.values()) {
      if (!fields.activityAt || fields.activityAt.revision <= this.summaryRevision) continue;
      revision = Math.max(revision, fields.activityAt.revision);
      lastThreadUpdateAt = Math.max(lastThreadUpdateAt ?? 0, fields.activityAt.value);
    }
    const update = <T extends { activityAt: number; identity: WorkbenchThreadActivityUpdate["identity"] }>(entry: T): T => {
      const field = this.activity.get(this.threadKey(entry.identity))?.activityAt;
      return field && field.revision > this.summaryRevision ? { ...entry, activityAt: field.value } : entry;
    };
    return {
      ...summary, revision, lastThreadUpdateAt,
      unsettledThreads: summary.unsettledThreads.map(update),
      pinnedThreads: summary.pinnedThreads.map((entry) => entry.entryKind === "draft" ? entry : update(entry)),
    };
  }

  private retireCoveredFields() {
    for (const [key, change] of this.changedEntries) {
      if (change.revision <= this.sidebarRevision) this.changedEntries.delete(key);
    }
    if (this.delivery && this.delivery.revision <= this.sidebarRevision) this.delivery = null;
    const activityFloor = this.summary ? Math.min(this.sidebarRevision, this.summaryRevision) : this.sidebarRevision;
    for (const [key, fields] of this.activity) {
      if (fields.activityAt && fields.activityAt.revision <= activityFloor) delete fields.activityAt;
      if (fields.orderAt && fields.orderAt.revision <= this.sidebarRevision) delete fields.orderAt;
      if (!fields.activityAt && !fields.orderAt) this.activity.delete(key);
    }
    if (this.displayOrder && this.displayOrder.revision <= this.sidebarRevision) this.displayOrder = null;
  }

  private threadKey(identity: WorkbenchThreadActivityUpdate["identity"]) {
    return `${identity.harness}:${identity.threadId}`;
  }

  private entryKey(entry: WorkbenchThreadSidebarEntry) {
    return entry.entryKind === "draft" ? `draft:${entry.draft.draftId}` : this.threadKey(entry.identity);
  }
}
