/*
 * Keywords: draft, hydration, save, navigation, attachment, submission.
 * Exports:
 * - default DraftSessionController: own buffered edits, saves, attachments, and submission for either form.
 * - DraftSessionContent: shared image attachment shape.
 * - DraftUpdate: apply a field edit to the latest draft.
 * - DraftSaveOptions: distinguish autosave, submission, and detached writes.
 * - DraftSessionPorts: existing persistence owner and scheduler boundary.
 * - DraftSessionSnapshot: rendered input and lifecycle status.
 */
import type { WorkbenchThreadComposerAttachmentDraft } from "workbench-shared/types";

export interface DraftSessionContent {
  attachments: WorkbenchThreadComposerAttachmentDraft[];
}
export type DraftUpdate<Draft> = (current: Draft) => Draft;

export interface DraftSaveOptions {
  detached: boolean;
  reason: "autosave" | "submission" | "retarget";
}

export interface DraftSessionPorts<Draft> {
  empty: () => Draft;
  /** Null means the draft is not eligible for persistence yet; retain its edits. */
  save: (update: DraftUpdate<Draft>, options: DraftSaveOptions) => Promise<Draft | null> | Draft | null;
  schedule?: (callback: () => void, delay: number) => number;
  cancelSchedule?: (handle: number) => void;
}

export interface DraftSessionSnapshot<Draft> {
  draft: Draft;
  error: string;
  isAttaching: boolean;
  isSubmitting: boolean;
}

export default class DraftSessionController<Draft extends DraftSessionContent> {
  readonly #ports: DraftSessionPorts<Draft>;
  readonly #listeners = new Set<() => void>();
  #snapshot: DraftSessionSnapshot<Draft>;
  #receivedDraft: Draft;
  #pending: DraftUpdate<Draft>[] = [];
  #saving: Promise<boolean> | null = null;
  #timer: number | null = null;
  #attached = false;
  #submitted = false;
  readonly #attachmentReads = new Set<symbol>();

  constructor(draft: Draft, ports: DraftSessionPorts<Draft>) {
    this.#ports = ports;
    this.#receivedDraft = draft;
    this.#snapshot = { draft, error: "", isAttaching: false, isSubmitting: false };
  }

  getSnapshot = () => this.#snapshot;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  attach() {
    this.#attached = true;
  }

  detach() {
    this.#attached = false;
    this.#cancelSave();
    void this.flush();
  }

  receive(draft: Draft) {
    this.#receivedDraft = draft;
    if (this.#pending.length || this.#saving || this.#snapshot.isSubmitting || this.#submitted) return;
    this.#publish({ draft });
  }

  edit(update: DraftUpdate<Draft>) {
    if (this.#snapshot.isSubmitting) return;
    this.#submitted = false;
    this.#pending.push(update);
    this.#publish({ draft: update(this.#snapshot.draft), error: "" });
    this.#scheduleSave();
  }

  async flush(reason: DraftSaveOptions["reason"] = "autosave"): Promise<boolean> {
    this.#cancelSave();
    if (this.#saving) {
      if (!await this.#saving) return false;
      return await this.flush(reason);
    }
    if (!this.#pending.length || this.#submitted || this.#snapshot.isSubmitting) return true;
    const edits = this.#pending;
    const receivedAtStart = this.#receivedDraft;
    this.#pending = [];
    const update = (draft: Draft) => edits.reduce((current, edit) => edit(current), draft);
    const operation = Promise.resolve().then(async () => {
      try {
        const savedDraft = await this.#ports.save(update, { detached: !this.#attached, reason });
        if (savedDraft === null) {
          this.#pending = [...edits, ...this.#pending];
          return false;
        }
        const baseline = this.#receivedDraft !== receivedAtStart ? this.#receivedDraft : savedDraft;
        const draft = this.#pending.reduce<Draft>((current, edit) => edit(current), baseline);
        this.#publish({ draft, error: "" });
        return true;
      } catch (error) {
        this.#pending = [...edits, ...this.#pending];
        this.reportError(error, "Unable to save the draft.");
        return false;
      } finally {
        this.#saving = null;
      }
    });
    this.#saving = operation;
    const saved = await operation;
    if (saved && this.#pending.length && !this.#snapshot.isSubmitting) this.#scheduleSave();
    return saved;
  }

  reset() {
    this.#attachmentReads.clear();
    this.#publish({ isAttaching: false });
    this.edit(this.#ports.empty);
    return this.flush();
  }

  async attachImages(read: () => Promise<readonly { url: string }[]>) {
    if (this.#snapshot.isSubmitting) return;
    const operation = Symbol();
    this.#attachmentReads.add(operation);
    this.#publish({ isAttaching: true, error: "" });
    try {
      const input = await read();
      if (!this.#attachmentReads.has(operation)) return;
      const images = input.map(({ url }) => ({
        id: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID() : `attachment:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        url,
      }));
      if (images.length) this.edit((draft) => ({
        ...draft,
        attachments: [...draft.attachments, ...images.filter((image) => !draft.attachments.some(({ id }) => id === image.id))],
      }));
    } catch (error) {
      if (this.#attachmentReads.has(operation)) this.reportError(error, "Unable to attach the pasted image.");
    } finally {
      this.#attachmentReads.delete(operation);
      this.#publish({ isAttaching: this.#attachmentReads.size > 0 });
    }
  }

  async submit(action: (draft: Draft, options: DraftSaveOptions) => Promise<boolean>): Promise<boolean> {
    if (this.#snapshot.isSubmitting || this.#attachmentReads.size) return false;
    this.#cancelSave();
    this.#publish({ isSubmitting: true, error: "" });
    // A previous autosave must finish before the submission can clear its record.
    if (this.#saving) await this.#saving;
    const draft = this.#snapshot.draft;
    try {
      const sent = await action(draft, { detached: !this.#attached, reason: "submission" });
      if (sent) {
        this.#pending = [];
        this.#submitted = true;
        this.#publish({ draft: this.#ports.empty() });
      }
      return sent;
    } catch (error) {
      this.reportError(error, "Unable to submit the draft.");
      return false;
    } finally {
      this.#publish({ isSubmitting: false });
      if (this.#pending.length) this.#scheduleSave();
    }
  }

  reportError(error: unknown, fallback: string) {
    const message = error instanceof Error ? error.message : fallback;
    console.error(fallback, message.slice(0, 500));
    this.#publish({ error: message });
  }

  #scheduleSave() {
    this.#cancelSave();
    if (this.#saving || this.#snapshot.isSubmitting) return;
    if (!this.#attached) {
      void this.flush();
      return;
    }
    this.#timer = (this.#ports.schedule ?? ((callback, delay) => window.setTimeout(callback, delay)))(() => {
      this.#timer = null;
      void this.flush();
    }, 260);
  }

  #cancelSave() {
    if (this.#timer === null) return;
    (this.#ports.cancelSchedule ?? ((handle) => window.clearTimeout(handle)))(this.#timer);
    this.#timer = null;
  }

  #publish(update: Partial<DraftSessionSnapshot<Draft>>) {
    this.#snapshot = { ...this.#snapshot, ...update };
    for (const listener of this.#listeners) listener();
  }
}
