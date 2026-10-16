/*
 * Exports:
 * - TextFileDocumentPort: one text file's disk reads, mtime-guarded saves and durable draft.
 * - TextFileDocumentState: loaded content, saved baseline, save and conflict status and history availability.
 * - TextFileEditOptions: how an edit joins history and whether it persists a draft immediately.
 * - default TextFileDocumentController: own one text file's load, edits, undo/redo, drafts, saves, conflicts and clean refreshes.
 */

export interface TextFileDocumentPort {
  read(): Promise<{ content: string; mtimeMs: number }>;
  save(content: string, expectedMtimeMs: number, force: boolean): Promise<
    | { kind: "saved"; mtimeMs: number }
    | { kind: "conflict"; message: string }
  >;
  drafts: {
    /** `mtimeMs` is the disk version the draft was based on, when known. */
    read(): { content: string; mtimeMs: number | null } | null;
    write(draft: { baseline: string; content: string; mtimeMs: number }): void;
    clear(): Promise<void>;
  };
}

export interface TextFileDocumentState {
  status: "loading" | "ready" | "failed";
  content: string;
  baseline: string;
  dirty: boolean;
  saving: boolean;
  /** A save found newer disk content; the user chooses overwrite or reload. */
  conflict: string | null;
  error: string;
  canUndo: boolean;
  canRedo: boolean;
}

export interface TextFileEditOptions {
  /** Consecutive edits with the same key replace one history entry; `windowMs` bounds how far apart they may be. */
  coalesce?: { key: string; windowMs?: number };
  /** Skip draft persistence for high-frequency edits; call `persistDraft` once they settle. */
  transient?: boolean;
}

interface HistoryEntry {
  content: string;
  coalesceKey: string | null;
  at: number;
}

const HISTORY_LIMIT = 200;

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export default class TextFileDocumentController {
  #state: TextFileDocumentState = {
    status: "loading", content: "", baseline: "", dirty: false, saving: false, conflict: null, error: "", canUndo: false, canRedo: false,
  };
  #history: HistoryEntry[] = [];
  #historyIndex = -1;
  #mtimeMs = 0;
  #listeners = new Set<() => void>();
  #disposed = false;

  constructor(private readonly port: TextFileDocumentPort, private readonly now: () => number = Date.now) {}

  getSnapshot = () => this.#state;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  /** A stored draft wins over disk unless it already matches; its mtime keeps saves conflict-guarded. */
  async load() {
    this.#publish({ status: "loading", error: "" });
    try {
      const disk = await this.port.read();
      const draft = this.port.drafts.read();
      if (draft?.content === disk.content) await this.port.drafts.clear();
      const restored = draft && draft.content !== disk.content ? draft : null;
      const content = restored?.content ?? disk.content;
      this.#mtimeMs = restored?.mtimeMs ?? disk.mtimeMs;
      this.#history = [{ content, coalesceKey: null, at: this.now() }];
      this.#historyIndex = 0;
      this.#publish({ status: "ready", baseline: disk.content, content, conflict: null });
    } catch (error) {
      this.#publish({ status: "failed", error: message(error, "This file could not be read.") });
    }
  }

  edit(content: string, options: TextFileEditOptions = {}) {
    if (this.#state.status !== "ready" || content === this.#state.content) return;
    const at = this.now();
    const top = this.#history[this.#historyIndex];
    const key = options.coalesce?.key ?? null;
    const windowMs = options.coalesce?.windowMs;
    const joins = key !== null && top?.coalesceKey === key && this.#historyIndex > 0
      && (windowMs === undefined || at - top.at <= windowMs);
    this.#history = this.#history.slice(0, this.#historyIndex + (joins ? 0 : 1));
    this.#history.push({ content, coalesceKey: key, at });
    if (this.#history.length > HISTORY_LIMIT) this.#history.splice(0, this.#history.length - HISTORY_LIMIT);
    this.#historyIndex = this.#history.length - 1;
    this.#publish({ content });
    if (!options.transient) this.persistDraft();
  }

  undo() { this.#travel(-1); }
  redo() { this.#travel(1); }

  persistDraft() {
    const { content, baseline } = this.#state;
    if (content === baseline) void this.port.drafts.clear().catch(() => undefined);
    else this.port.drafts.write({ baseline, content, mtimeMs: this.#mtimeMs });
  }

  /** Restores the saved baseline as an ordinary, undoable edit. */
  revert() {
    this.edit(this.#state.baseline);
  }

  async save({ force = false }: { force?: boolean } = {}) {
    if (this.#state.status !== "ready" || this.#state.saving) return;
    const content = this.#state.content;
    this.#publish({ saving: true, error: "" });
    try {
      const result = await this.port.save(content, this.#mtimeMs, force);
      if (result.kind === "conflict") {
        this.#publish({ saving: false, conflict: result.message });
        return;
      }
      this.#mtimeMs = result.mtimeMs;
      this.#publish({ saving: false, baseline: content, conflict: null });
      this.persistDraft();
    } catch (error) {
      this.#publish({ saving: false, error: message(error, "This file could not be saved.") });
    }
  }

  /** Replaces the editor with disk content, keeping the replaced text one undo away. */
  async reloadFromDisk() {
    try {
      const disk = await this.port.read();
      this.#mtimeMs = disk.mtimeMs;
      this.#publish({ baseline: disk.content, conflict: null, error: "" });
      this.edit(disk.content);
      await this.port.drafts.clear();
    } catch (error) {
      this.#publish({ error: message(error, "This file could not be read.") });
    }
  }

  /** Follows outside writes only while there is nothing local to lose. */
  async refreshIfClean() {
    if (this.#state.status !== "ready" || this.#state.dirty || this.#state.saving) return;
    try {
      const disk = await this.port.read();
      if (this.#state.dirty || this.#state.saving || disk.mtimeMs === this.#mtimeMs) return;
      this.#mtimeMs = disk.mtimeMs;
      this.#publish({ baseline: disk.content });
      this.edit(disk.content, { transient: true });
    } catch {
      // A failed background refresh keeps the current clean view; the next explicit action reports errors.
    }
  }

  dismissConflict() {
    this.#publish({ conflict: null });
  }

  dispose() {
    this.#disposed = true;
    this.#listeners.clear();
  }

  #travel(step: number) {
    const index = this.#historyIndex + step;
    const entry = this.#history[index];
    if (this.#state.status !== "ready" || !entry) return;
    this.#historyIndex = index;
    // Typing after undo or redo starts a new entry instead of overwriting the one travelled to.
    this.#history[index] = { ...entry, coalesceKey: null };
    this.#publish({ content: entry.content });
    this.persistDraft();
  }

  #publish(patch: Partial<TextFileDocumentState>) {
    if (this.#disposed) return;
    const next = { ...this.#state, ...patch };
    next.dirty = next.status === "ready" && next.content !== next.baseline;
    next.canUndo = this.#historyIndex > 0;
    next.canRedo = this.#historyIndex < this.#history.length - 1;
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }
}
