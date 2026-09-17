/*
 * Exports:
 * - default WorkbenchWorkingTreeState: own selected-project refresh, selection freshness and mutation drafts.
 * - WorkingTreeDraft/WorkingTreeStateSnapshot: observable browser state.
 */
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import { WorkbenchDaemonRequestError } from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import type { WorkingTreeDiff, WorkingTreeMutation, WorkingTreePreview, WorkingTreeRead, WorkingTreeResult, WorkingTreeSelection } from "workbench-shared/workbench/git/working-tree-contracts";
import { describeWorkingTreeDiff } from "workbench-shared/workbench/git/working-tree-selection";

export interface WorkingTreeDraft { mode: "commit" | "amend" | "stash"; title: string; description: string; targetCommit: string | null }
export interface WorkingTreeStateSnapshot {
  data: WorkingTreeRead;
  status: "idle" | "loading" | "ready" | "error" | "unavailable";
  error: string;
  operationError: string;
  rootId: string;
  path: string;
  diff: WorkingTreeDiff | null;
  preview: WorkingTreePreview | null;
  contentStatus: "idle" | "loading" | "ready" | "error";
  contentError: string;
  selections: WorkingTreeSelection[];
  draft: WorkingTreeDraft;
  busy: boolean;
  result: WorkingTreeResult | null;
}
type Port = WorkbenchDaemonClient["git"]["workingTree"];
const blankDraft = (): WorkingTreeDraft => ({ mode: "commit", title: "", description: "", targetCommit: null });

export default class WorkbenchWorkingTreeState {
  private snapshot: WorkingTreeStateSnapshot = {
    data: { repositories: [], errors: [] }, status: "idle", error: "", operationError: "", rootId: "", path: "",
    diff: null, preview: null, contentStatus: "idle", contentError: "", selections: [],
    draft: blankDraft(), busy: false, result: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly drafts = new Map<string, WorkingTreeDraft>();
  private refreshWork: { lifetime: object; promise: Promise<void> } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private visible = false;
  private lifetime: object | null = {};
  private contentRequest: object | null = null;
  private previewWork: { token: object; promise: Promise<void> } | null = null;
  constructor(readonly projectId: string, private readonly port: Port) {}
  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get repository() { return this.snapshot.data.repositories.find(repository => repository.rootId === this.snapshot.rootId) ?? null; }
  get file() { return this.repository?.files.find(file => file.path === this.snapshot.path) ?? null; }

  private publish(change: Partial<WorkingTreeStateSnapshot>) {
    if (!this.lifetime) return;
    this.snapshot = { ...this.snapshot, ...change };
    this.listeners.forEach(listener => listener());
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (visible) void this.refresh();
  }

  activate() {
    this.lifetime ??= {};
  }

  dispose() {
    this.lifetime = null;
    this.visible = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.contentRequest = null;
    this.listeners.clear();
  }

  async refresh() {
    const lifetime = this.lifetime;
    if (!lifetime || !this.projectId || this.snapshot.busy) return;
    if (this.refreshWork) {
      const existing = this.refreshWork;
      await existing.promise;
      if (existing.lifetime !== lifetime && this.lifetime === lifetime) await this.refresh();
      return;
    }
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.publish({ status: this.snapshot.status === "idle" ? "loading" : this.snapshot.status });
    const work = async () => {
      try {
        const data = await this.port.read({ projectId: this.projectId });
        if (this.lifetime !== lifetime || this.snapshot.busy) return;
        const oldRepository = this.repository;
        const oldFile = this.file;
        const repository = data.repositories.find(repository => repository.rootId === this.snapshot.rootId) ?? data.repositories[0];
        const sameHead = oldRepository?.head === repository?.head && oldRepository?.rootId === repository?.rootId;
        const selections = sameHead ? this.snapshot.selections.filter(selection =>
          repository?.files.some(file => file.path === selection.path && file.identity === selection.identity && !file.ownerIds.length),
        ) : [];
        const file = repository?.files.find(file => file.path === this.snapshot.path) ?? repository?.files[0];
        this.publish({
          data, rootId: repository?.rootId ?? "", path: file?.path ?? "", selections,
          status: "ready", error: data.errors.map(error => error.message).join("\n"),
        });
        if (file?.identity !== oldFile?.identity || repository?.rootId !== oldRepository?.rootId) await this.loadContent();
      } catch (error) {
        if (this.lifetime !== lifetime || this.snapshot.busy) return;
        this.publish({
          status: error instanceof WorkbenchDaemonRequestError && error.code === -32601 ? "unavailable" : "error",
          error: error instanceof WorkbenchDaemonRequestError && error.code === -32601
            ? "This daemon does not support the working-tree view yet."
            : error instanceof Error ? error.message : "Unable to read working-tree changes.",
        });
      }
    };
    const promise = work().finally(() => {
      this.refreshWork = null;
      if (this.visible && this.lifetime === lifetime && !this.snapshot.busy) this.timer = setTimeout(() => { this.timer = null; void this.refresh(); }, 5_000);
    });
    this.refreshWork = { lifetime, promise };
    await promise;
  }

  selectRoot(rootId: string) {
    if (this.snapshot.busy || rootId === this.snapshot.rootId) return;
    this.drafts.set(this.snapshot.rootId, this.snapshot.draft);
    const repository = this.snapshot.data.repositories.find(repository => repository.rootId === rootId);
    this.publish({ rootId, path: repository?.files[0]?.path ?? "", selections: [], draft: this.drafts.get(rootId) ?? blankDraft(), result: null });
    void this.loadContent();
  }

  selectFile(path: string) {
    if (this.snapshot.path === path) return;
    this.publish({ path });
    void this.loadContent();
  }

  async loadContent() {
    if (!this.lifetime) return;
    const file = this.file;
    const token = {};
    this.contentRequest = token;
    this.publish({ diff: null, preview: null, contentError: "", contentStatus: file ? "loading" : "idle" });
    if (!file) return;
    const request = { projectId: this.projectId, rootId: this.snapshot.rootId, path: file.path, identity: file.identity };
    try {
      const diff = await this.port.diff(request);
      if (this.contentRequest !== token || !this.lifetime) return;
      this.publish({ diff, contentStatus: "ready" });
    } catch (error) {
      if (this.contentRequest === token) this.publish({ contentStatus: "error", contentError: error instanceof Error ? error.message : "Unable to load diff." });
    }
  }

  async loadPreview() {
    const file = this.file;
    const token = this.contentRequest;
    if (!this.lifetime || !token || !file || this.snapshot.preview?.identity === file.identity) return;
    if (this.previewWork?.token === token) return await this.previewWork.promise;
    const work = async () => {
      try {
        const preview = await this.port.preview({ projectId: this.projectId, rootId: this.snapshot.rootId, path: file.path, identity: file.identity });
        if (this.contentRequest === token) this.publish({ preview });
      } catch (error) {
        if (this.contentRequest === token) this.publish({ contentError: error instanceof Error ? error.message : "Unable to load preview." });
      }
    };
    const promise = work().finally(() => { if (this.previewWork?.token === token) this.previewWork = null; });
    this.previewWork = { token, promise };
    await promise;
  }

  toggleFile(path: string) {
    if (this.snapshot.busy) return;
    const file = this.repository?.files.find(file => file.path === path);
    if (!file || file.ownerIds.length) return;
    const existing = this.snapshot.selections.find(selection => selection.path === path);
    this.publish({ selections: existing
      ? this.snapshot.selections.filter(selection => selection.path !== path)
      : [...this.snapshot.selections, { path, identity: file.identity, lineIds: null }] });
  }

  selectAll(checked: boolean) {
    if (this.snapshot.busy) return;
    this.publish({ selections: checked ? this.repository?.files.filter(file => !file.ownerIds.length)
      .map(file => ({ path: file.path, identity: file.identity, lineIds: null })) ?? [] : [] });
  }

  setLines(ids: readonly string[], included: boolean) {
    const file = this.file;
    const diff = this.snapshot.diff;
    if (!file?.partial || file.ownerIds.length || !diff || this.snapshot.busy) return;
    const all = describeWorkingTreeDiff(diff.patch).rows.filter(row => row.selectable).map(row => row.id);
    const existing = this.snapshot.selections.find(selection => selection.path === file.path);
    const selected = new Set(existing ? existing.lineIds ?? all : []);
    for (const id of ids) if (all.includes(id)) { if (included) selected.add(id); else selected.delete(id); }
    const others = this.snapshot.selections.filter(selection => selection.path !== file.path);
    this.publish({ selections: selected.size ? [...others, {
      path: file.path, identity: file.identity, lineIds: selected.size === all.length ? null : [...selected],
    }] : others });
  }

  setDraft(change: Partial<WorkingTreeDraft>) {
    if (this.snapshot.busy) return;
    this.publish({ draft: { ...this.snapshot.draft, ...change } });
  }

  setMode(mode: WorkingTreeDraft["mode"]) {
    if (this.snapshot.busy || mode === this.snapshot.draft.mode) return;
    this.drafts.set(`${this.snapshot.rootId}:${this.snapshot.draft.mode}`, this.snapshot.draft);
    const stored = this.drafts.get(`${this.snapshot.rootId}:${mode}`);
    const [title = "", ...body] = (this.repository?.message.trimEnd() ?? "").split("\n");
    this.publish({ draft: stored ?? {
      mode, title: mode === "amend" ? title : "", description: mode === "amend" ? body.join("\n").trim() : "",
      targetCommit: mode === "amend" ? this.repository?.head ?? null : null,
    }, result: null });
  }

  reviewHead() {
    if (this.snapshot.busy || this.snapshot.draft.mode !== "amend") return;
    const [title = "", ...body] = (this.repository?.message.trimEnd() ?? "").split("\n");
    this.publish({ draft: { mode: "amend", title, description: body.join("\n").trim(), targetCommit: this.repository?.head ?? null }, operationError: "" });
  }

  async submit(mode: "commit" | "amend" | "stash" | "discard" = this.snapshot.draft.mode, scope?: Pick<WorkingTreeMutation, "rootId" | "expectedHead" | "selections">) {
    const repository = this.repository;
    if (!repository || this.snapshot.busy || this.snapshot.status !== "ready") return;
    if (mode === "amend" && this.snapshot.draft.targetCommit !== repository.head) {
      this.publish({ operationError: "HEAD changed. Review the new HEAD before amending." });
      return;
    }
    const selections = scope?.selections ?? this.snapshot.selections;
    this.publish({ busy: true, result: null, operationError: "" });
    try {
      const result = await this.port.mutate({
        projectId: this.projectId, rootId: scope?.rootId ?? repository.rootId, expectedHead: scope ? scope.expectedHead : repository.head,
        targetCommit: mode === "amend" ? this.snapshot.draft.targetCommit : null, mode, selections,
        title: this.snapshot.draft.title, description: this.snapshot.draft.description,
      });
      this.publish({ result, selections: result.status === "complete" ? [] : this.snapshot.selections });
      if (result.status === "complete" && !scope) this.setDraftAfterSubmit();
    } catch (error) {
      this.publish({ operationError: `${error instanceof Error ? error.message : "Git operation failed."} Inspect the refreshed tree before retrying.` });
    } finally {
      // Drain a pre-mutation read before admitting the required fresh inspection.
      await this.refreshWork?.promise;
      this.publish({ busy: false });
      await this.refresh();
    }
  }

  private setDraftAfterSubmit() {
    this.drafts.delete(`${this.snapshot.rootId}:${this.snapshot.draft.mode}`);
    this.publish({ draft: blankDraft() });
  }
}
