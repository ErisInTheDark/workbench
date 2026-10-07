/*
 * Exports:
 * - ApprovalReviewSettingsState: reviewer settings presentation state.
 * - selectedReviewerReady: whether the selected reviewer can judge requests; null while unknown.
 * - default ApprovalReviewSettingsController: own auto-approve settings reads and fenced writes for one daemon.
 */
import type { ApprovalReviewerId } from "workbench-shared/workbench/approval-review/approval-reviewers";
import type {
  ApprovalReviewSettingsSnapshot, ApprovalReviewSettingsUpdate,
} from "workbench-shared/workbench/approval-review/approval-review-settings";

export interface ApprovalReviewSettingsState {
  settings: ApprovalReviewSettingsSnapshot | null;
  busy: boolean;
  error: string;
}

export function selectedReviewerReady(settings: ApprovalReviewSettingsSnapshot | null) {
  if (!settings) return null;
  if (!settings.selected) return false;
  return settings.reviewers.find(reviewer => reviewer.id === settings.selected)?.ready ?? false;
}

export default class ApprovalReviewSettingsController {
  private snapshot: ApprovalReviewSettingsState = { settings: null, busy: false, error: "" };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private disposed = false;

  constructor(private readonly port: {
    read(): Promise<ApprovalReviewSettingsSnapshot>;
    update(update: ApprovalReviewSettingsUpdate): Promise<ApprovalReviewSettingsSnapshot>;
  }) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  refresh() { return this.perform(() => this.port.read(), "Unable to read auto-approve settings."); }
  select(reviewer: ApprovalReviewerId | null) {
    return this.perform(() => this.port.update({ selected: reviewer }), "Unable to choose that reviewer.");
  }
  /** Save (string) or clear (null) a Workbench-held reviewer key. */
  saveSecret(reviewer: ApprovalReviewerId, value: string | null) {
    return this.perform(() => this.port.update({ secrets: { [reviewer]: value } }), "Unable to save the API key.");
  }

  dispose() {
    this.disposed = true;
    this.generation += 1;
    this.listeners.clear();
  }

  private async perform(operation: () => Promise<ApprovalReviewSettingsSnapshot>, failure: string) {
    if (this.disposed) return;
    // The newest request owns the snapshot; an older reply never overwrites it.
    const generation = ++this.generation;
    this.publish({ ...this.snapshot, busy: true, error: "" });
    try {
      const settings = await operation();
      if (!this.disposed && generation === this.generation) this.publish({ settings, busy: false, error: "" });
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        this.publish({ ...this.snapshot, busy: false, error: error instanceof Error ? error.message.slice(0, 300) : failure });
      }
    }
  }

  private publish(snapshot: ApprovalReviewSettingsState) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
