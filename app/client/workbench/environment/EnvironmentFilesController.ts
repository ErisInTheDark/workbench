/*
 * Exports:
 * - EnvironmentFilesPort: env file discovery, disk reads and overwriting saves, plus durable drafts.
 * - EnvironmentFileState: one discovered file's lazy editor state.
 * - EnvironmentFilesState: discovered files and discovery status.
 * - default EnvironmentFilesController: own env file discovery, lazy loading, drafts, saves and discards for one project.
 */
export interface EnvironmentFilesPort {
  listPaths(): Promise<string[]>;
  read(path: string): Promise<{ content: string; mtimeMs: number }>;
  /** Overwrites the file regardless of newer disk content. */
  save(path: string, content: string, mtimeMs: number): Promise<{ mtimeMs: number }>;
  drafts: {
    read(path: string): Promise<string | null>;
    write(path: string, draft: { baseline: string; content: string; mtimeMs: number }): void;
    clear(path: string): Promise<void>;
  };
}

export interface EnvironmentFileState {
  path: string;
  /** `failed` means the file could not be read; save failures keep `ready` with an error. */
  status: "idle" | "loading" | "ready" | "saving" | "failed";
  /** Disk content as last read or saved. */
  baseline: string;
  content: string;
  dirty: boolean;
  mtimeMs: number;
  error: string;
}

export interface EnvironmentFilesState {
  files: EnvironmentFileState[];
  status: "loading" | "ready" | "failed";
  error: string;
}

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export default class EnvironmentFilesController {
  #state: EnvironmentFilesState = { files: [], status: "loading", error: "" };
  #listeners = new Set<() => void>();
  #disposed = false;

  constructor(private readonly port: EnvironmentFilesPort) {}

  getSnapshot = () => this.#state;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  async discover() {
    this.#publish({ status: "loading", error: "" });
    try {
      const paths = [...await this.port.listPaths()].sort((left, right) => left.localeCompare(right));
      const existing = new Map(this.#state.files.map(file => [file.path, file]));
      this.#publish({
        status: "ready",
        files: paths.map(path => existing.get(path) ?? { path, status: "idle", baseline: "", content: "", dirty: false, mtimeMs: 0, error: "" }),
      });
    } catch (error) {
      this.#publish({ status: "failed", error: message(error, "Environment files could not be listed.") });
    }
  }

  /** Loads disk content on first open; a stored draft wins unless it already matches disk. */
  async open(path: string) {
    const file = this.#file(path);
    if (!file || file.status === "loading" || file.status === "ready" || file.status === "saving") return;
    this.#patch(path, { status: "loading", error: "" });
    try {
      const [disk, draft] = await Promise.all([this.port.read(path), this.port.drafts.read(path)]);
      if (draft === disk.content) await this.port.drafts.clear(path);
      const content = draft ?? disk.content;
      this.#patch(path, { status: "ready", baseline: disk.content, content, dirty: content !== disk.content, mtimeMs: disk.mtimeMs });
    } catch (error) {
      this.#patch(path, { status: "failed", error: message(error, "This file could not be read.") });
    }
  }

  edit(path: string, content: string) {
    const file = this.#file(path);
    if (!file || file.status === "idle" || file.status === "loading" || file.status === "failed") return;
    const dirty = content !== file.baseline;
    this.#patch(path, { content, dirty });
    if (dirty) this.port.drafts.write(path, { baseline: file.baseline, content, mtimeMs: file.mtimeMs });
    else void this.port.drafts.clear(path);
  }

  async save(path: string) {
    const file = this.#file(path);
    if (!file || file.status === "saving" || !file.dirty) return;
    const content = file.content;
    this.#patch(path, { status: "saving", error: "" });
    try {
      const { mtimeMs } = await this.port.save(path, content, file.mtimeMs);
      const current = this.#file(path)!;
      const dirty = current.content !== content;
      this.#patch(path, { status: "ready", baseline: content, dirty, mtimeMs });
      if (dirty) this.port.drafts.write(path, { baseline: content, content: current.content, mtimeMs });
      else await this.port.drafts.clear(path);
    } catch (error) {
      // The editor stays usable with its draft; only reads leave a file in the failed state.
      this.#patch(path, { status: "ready", error: message(error, "This file could not be saved.") });
    }
  }

  async discard(path: string) {
    const file = this.#file(path);
    if (!file || file.status === "saving") return;
    await this.port.drafts.clear(path);
    this.#patch(path, { status: "idle", dirty: false });
    await this.open(path);
  }

  /** Stops publishing; in-flight saves still finish and settle their drafts. */
  dispose() {
    this.#disposed = true;
    this.#listeners.clear();
  }

  #file(path: string) {
    return this.#state.files.find(file => file.path === path);
  }

  #patch(path: string, patch: Partial<EnvironmentFileState>) {
    this.#publish({ files: this.#state.files.map(file => file.path === path ? { ...file, ...patch } : file) });
  }

  #publish(patch: Partial<EnvironmentFilesState>) {
    this.#state = { ...this.#state, ...patch };
    if (this.#disposed) return;
    for (const listener of this.#listeners) listener();
  }
}
