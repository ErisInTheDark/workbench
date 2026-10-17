/*
 * Exports:
 * - TextFileDocumentPort: one text file's disk reads, mtime-guarded saves and durable draft with its undo history.
 * - TextFileDocumentState: loaded content, saved baseline, save and conflict status and history availability.
 * - TextFileEditOptions: how an edit joins history and whether it persists a draft immediately.
 * - default TextFileDocumentController: own one text file's load, edits, undo/redo, drafts, saves, conflicts and clean refreshes.
 */
import {
  cloneEditHistory, createHistoryPatch, createInitialEditHistory, materializeHistoryContent, normalizeEditHistory,
  trimEditHistory, type EditHistoryState,
} from "../state/edit-history";

export interface TextFileDocumentPort {
  read(): Promise<{ content: string; mtimeMs: number }>;
  save(content: string, expectedMtimeMs: number, force: boolean): Promise<
    | { kind: "saved"; mtimeMs: number }
    | { kind: "conflict"; message: string }
  >;
  drafts: {
    /** `mtimeMs` is the disk version the draft was based on, when known; `history` leads to `content` when stored. */
    read(): { content: string; mtimeMs: number | null; history?: EditHistoryState | null } | null;
    write(draft: { baseline: string; content: string; mtimeMs: number; history: EditHistoryState }): void;
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

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export default class TextFileDocumentController {
  #state: TextFileDocumentState = {
    status: "loading", content: "", baseline: "", dirty: false, saving: false, conflict: null, error: "", canUndo: false, canRedo: false,
  };
  #history: EditHistoryState = { currentIndex: 0, frames: [] };
  /** The coalesce key and time of the edit that made the current frame; travelling clears it, and it is never stored. */
  #coalesce: { key: string; at: number } | null = null;
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
      this.#history = restored ? normalizeEditHistory(restored.history ?? null, content) : createInitialEditHistory(content);
      this.#coalesce = null;
      this.#publish({ status: "ready", baseline: disk.content, content, conflict: null });
    } catch (error) {
      this.#publish({ status: "failed", error: message(error, "This file could not be read.") });
    }
  }

  edit(content: string, options: TextFileEditOptions = {}) {
    if (this.#state.status !== "ready" || content === this.#state.content) return;
    const at = this.now();
    const index = this.#history.currentIndex;
    const key = options.coalesce?.key ?? null;
    const windowMs = options.coalesce?.windowMs;
    const joins = key !== null && this.#coalesce?.key === key && index > 0
      && (windowMs === undefined || at - this.#coalesce.at <= windowMs);
    // A joining edit replaces the current frame with one patch from the frame before it.
    const base = joins ? index - 1 : index;
    const frames = this.#history.frames.slice(0, base + 1);
    const patch = createHistoryPatch(materializeHistoryContent(this.#history, base), content);
    if (patch) frames.push({ type: "patch", patch, timestamp: at });
    this.#history = trimEditHistory({ currentIndex: frames.length - 1, frames });
    this.#coalesce = key !== null && patch ? { key, at } : null;
    this.#publish({ content });
    if (!options.transient) this.persistDraft();
  }

  undo() { this.#travel(-1); }
  redo() { this.#travel(1); }

  persistDraft() {
    const { content, baseline } = this.#state;
    if (content === baseline) void this.port.drafts.clear().catch(() => undefined);
    else this.port.drafts.write({ baseline, content, mtimeMs: this.#mtimeMs, history: cloneEditHistory(this.#history)! });
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
    const index = this.#history.currentIndex + step;
    if (this.#state.status !== "ready" || index < 0 || index >= this.#history.frames.length) return;
    this.#history = { ...this.#history, currentIndex: index };
    // Typing after undo or redo starts a new entry instead of overwriting the one travelled to.
    this.#coalesce = null;
    this.#publish({ content: materializeHistoryContent(this.#history, index) });
    this.persistDraft();
  }

  #publish(patch: Partial<TextFileDocumentState>) {
    if (this.#disposed) return;
    const next = { ...this.#state, ...patch };
    next.dirty = next.status === "ready" && next.content !== next.baseline;
    next.canUndo = this.#history.currentIndex > 0;
    next.canRedo = this.#history.currentIndex < this.#history.frames.length - 1;
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }
}
