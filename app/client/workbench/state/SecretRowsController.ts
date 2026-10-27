/*
 * Exports:
 * - SecretEntry: one stored key with its value, or a key whose value cannot be decrypted here.
 * - SecretRowsPort: one sealed key/value set's read, transactional update and key rules.
 * - SecretRowsState: editable rows, row issues, saved keys and save status.
 * - default SecretRowsController: own sealed key/value row loading, validation and serial autosave against the acknowledged baseline,
 *   such as a project store or an MCP server's environment.
 */
import { InputListRows, type InputListRow } from "../../components/workbench/input-list-rows";

export type SecretEntry = { key: string; value: string } | { key: string; unreadable: true };

export interface SecretRowsPort {
  /** What failure messages call the set, such as "project store". */
  subject: string;
  read(): Promise<{ entries: readonly SecretEntry[] }>;
  update(upserts: { key: string; value: string }[], removals: string[]): Promise<unknown>;
  /** Why a trimmed key can't be stored, or null; such rows are never saved. */
  keyIssue?(key: string): string | null;
}

export interface SecretRowsState {
  rows: InputListRow[];
  issues: Readonly<Record<string, string>>;
  /** Keys saved in the store, or null before the first successful read. */
  savedKeys: ReadonlySet<string> | null;
  status: "loading" | "ready" | "saving" | "failed";
  error: string;
}

type Saved = { value: string } | { unreadable: true };

const UNREADABLE = "This value cannot be decrypted on this device. Enter it again to replace it.";

export default class SecretRowsController {
  #state: SecretRowsState = { rows: InputListRows.create([]), issues: {}, savedKeys: null, status: "loading", error: "" };
  #listeners = new Set<() => void>();
  #saved = new Map<string, Saved>();
  #unreadableRows = new Set<string>();
  #saving = false;
  #disposed = false;

  constructor(private readonly port: SecretRowsPort) {}

  getSnapshot = () => this.#state;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  async load() {
    this.#publish({ status: "loading", error: "" });
    try {
      const snapshot = await this.port.read();
      this.#saved = new Map(snapshot.entries.map(entry => [entry.key, "value" in entry ? { value: entry.value } : { unreadable: true }]));
      const rows = InputListRows.create(snapshot.entries.map(entry => ({ key: entry.key, value: "value" in entry ? entry.value : "" })));
      this.#unreadableRows = new Set(rows.filter(row => this.#saved.get(row.key) && "unreadable" in this.#saved.get(row.key)!).map(row => row.id));
      this.#publish({ rows, issues: this.#issues(rows), savedKeys: new Set(this.#saved.keys()), status: "ready" });
    } catch (error) {
      this.#publish({ status: "failed", error: error instanceof Error ? error.message : `The ${this.port.subject} could not be read.` });
    }
  }

  setRows(rows: InputListRow[]) {
    for (const id of this.#unreadableRows) {
      const row = rows.find(candidate => candidate.id === id);
      const saved = this.#state.rows.find(candidate => candidate.id === id);
      if (!row || row.value !== "" || row.key !== saved?.key) this.#unreadableRows.delete(id);
    }
    this.#publish({ rows, issues: this.#issues(rows) });
    void this.#flush();
  }

  retry() {
    if (this.#state.savedKeys === null) void this.load();
    else void this.#flush();
  }

  /** Stops publishing; an in-flight save still completes and sends any newer edits. */
  dispose() {
    this.#disposed = true;
    this.#listeners.clear();
  }

  #issues(rows: readonly InputListRow[]) {
    const counts = new Map<string, number>();
    for (const row of rows) if (row.key.trim()) counts.set(row.key.trim(), (counts.get(row.key.trim()) ?? 0) + 1);
    const issues: Record<string, string> = {};
    for (const row of rows) {
      const key = row.key.trim();
      const invalid = key ? this.port.keyIssue?.(key) ?? null : null;
      if (!key && row.value.trim()) issues[row.id] = "Enter a key for this value.";
      else if (invalid) issues[row.id] = invalid;
      else if (key && counts.get(key)! > 1) issues[row.id] = "This key is listed more than once.";
      else if (this.#unreadableRows.has(row.id)) issues[row.id] = UNREADABLE;
    }
    return issues;
  }

  #invalid(row: InputListRow) {
    const key = row.key.trim();
    return key ? this.port.keyIssue?.(key) != null : Boolean(row.value.trim());
  }

  #changes() {
    const desired = new Map<string, string | null>();
    const blocked = new Set<string>();
    for (const row of this.#state.rows) {
      const key = row.key.trim();
      if (!key || this.#invalid(row)) continue;
      if (desired.has(key) || blocked.has(key)) {
        blocked.add(key);
        desired.delete(key);
        continue;
      }
      desired.set(key, this.#unreadableRows.has(row.id) ? null : row.value);
    }
    const upserts = Array.from(desired).flatMap(([key, value]) => {
      const saved = this.#saved.get(key);
      return value !== null && !(saved && "value" in saved && saved.value === value) ? [{ key, value }] : [];
    });
    // A row under correction may be a renamed stored key, so removals wait until every row is valid.
    const incomplete = this.#state.rows.some(row => this.#invalid(row));
    const removals = blocked.size || incomplete ? [] : Array.from(this.#saved.keys()).filter(key => !desired.has(key));
    return { upserts, removals };
  }

  async #flush(): Promise<void> {
    if (this.#saving || this.#state.savedKeys === null) return;
    const { upserts, removals } = this.#changes();
    if (!upserts.length && !removals.length) {
      if (this.#state.status !== "ready") this.#publish({ status: "ready", error: "" });
      return;
    }
    this.#saving = true;
    this.#publish({ status: "saving", error: "" });
    try {
      await this.port.update(upserts, removals);
      for (const key of removals) this.#saved.delete(key);
      for (const { key, value } of upserts) this.#saved.set(key, { value });
      this.#saving = false;
      this.#publish({ savedKeys: new Set(this.#saved.keys()) });
      await this.#flush();
    } catch (error) {
      this.#saving = false;
      this.#publish({ status: "failed", error: error instanceof Error ? error.message : `The ${this.port.subject} could not be saved.` });
    }
  }

  #publish(patch: Partial<SecretRowsState>) {
    this.#state = { ...this.#state, ...patch };
    if (this.#disposed) return;
    for (const listener of this.#listeners) listener();
  }
}
