/*
 * Exports:
 * - default WorkbenchWorkingTreeState: own selected-project refresh, the pushed unclaimed-changes summary, selection freshness and
 *   commit, amend, stash and new-branch drafts.
 * - WorkingTreeDraft/WorkingTreeStateSnapshot: observable browser state.
 * - WorkingTreeSummarySource: opens the daemon-pushed summary observation.
 */
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import { WorkbenchDaemonRequestError } from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import type { WorkingTreeDiff, WorkingTreeFileRequest, WorkingTreeMutation, WorkingTreePreview, WorkingTreeRead, WorkingTreeRepository, WorkingTreeResult, WorkingTreeSelection, WorkingTreeSummary } from "workbench-shared/workbench/git/working-tree-contracts";
import { describeWorkingTreeDiff } from "workbench-shared/workbench/git/working-tree-selection";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import GitContentCache from "./GitContentCache";
import type { WorkspaceSourcePhase } from "workbench-shared/workbench/workspace/workspace-observation";

export interface WorkingTreeDraft {
  /** `branch` commits the selection onto a new branch made at HEAD. */
  mode: "commit" | "amend" | "stash" | "branch";
  title: string;
  description: string;
  targetCommit: string | null;
  /** The new branch's name in `branch` mode. */
  branch: string;
}
export interface WorkingTreeStateSnapshot {
  data: WorkingTreeRead;
  summary: WorkingTreeSummary;
  summaryStatus: "idle" | "loading" | "ready" | "error" | "unavailable";
  status: "idle" | "loading" | "ready" | "error" | "unavailable";
  initialising: boolean;
  refreshing: boolean;
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
type Port = Pick<WorkbenchDaemonClient["git"]["workingTree"], "read" | "diff" | "preview" | "mutate">;
/** Opens the daemon-pushed summary of a project's unclaimed changes; `changed` fires on every new fact. */
export type WorkingTreeSummarySource = (changed: () => void) => {
  getSnapshot(): { phase: WorkspaceSourcePhase; failure: string | null; summary: WorkingTreeSummary | null };
  release(): void;
};
type RefPort = Pick<WorkbenchDaemonClient["git"], "mutateRef">;
const blankDraft = (): WorkingTreeDraft => ({ mode: "commit", title: "", description: "", targetCommit: null, branch: "" });

export default class WorkbenchWorkingTreeState {
  private snapshot: WorkingTreeStateSnapshot = {
    data: { repositories: [], errors: [] }, summary: { repositories: [], errors: [] }, summaryStatus: "idle",
    status: "idle", initialising: true, refreshing: false, error: "", operationError: "", rootId: "", path: "",
    diff: null, preview: null, contentStatus: "idle", contentError: "", selections: [],
    draft: blankDraft(), busy: false, result: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly drafts = new Map<string, WorkingTreeDraft>();
  private readonly reviews = new Map<string, { repository: WorkingTreeRepository; selections: WorkingTreeSelection[] }>();
  private readonly content: GitContentCache | null;
  private refreshWork: { lifetime: object; promise: Promise<void> } | null = null;
  private summaryObservation: ReturnType<WorkingTreeSummarySource> | null = null;
  private lastSummary: WorkingTreeSummary | null = null;
  private statusRequest: object = {};
  private readonly demands = new Map<object, "summary" | "full">();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private visible = false;
  private lifetime: object | null = {};
  private contentRequest: object | null = null;
  private previewWork: { token: object; promise: Promise<void> } | null = null;
  constructor(
    readonly projectId: string,
    private readonly port: Port | null,
    private readonly summarySource: WorkingTreeSummarySource | null = null,
    private readonly refs: RefPort | null = null,
  ) {
    this.content = port ? new GitContentCache() : null;
  }

  /** Working-tree content is immutable per file identity within one checkout. */
  private contentKey(request: WorkingTreeFileRequest, cwd: string) {
    return JSON.stringify([request.projectId, request.rootId, cwd, request.path, request.identity]);
  }
  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get repository() { return this.snapshot.data.repositories.find(repository => repository.rootId === this.snapshot.rootId) ?? null; }
  get file() { return this.repository?.files.find(file => file.path === this.snapshot.path) ?? null; }
  get mutationBlocked() {
    return !this.port || this.snapshot.busy || this.snapshot.refreshing || this.snapshot.initialising || this.snapshot.status !== "ready"
      || this.snapshot.data.errors.some(error => error.rootId === this.snapshot.rootId);
  }

  private publish(change: Partial<WorkingTreeStateSnapshot>) {
    if (!this.lifetime) return;
    const review = this.reviews.get(change.rootId ?? this.snapshot.rootId);
    if (review && change.selections) review.selections = change.selections;
    this.snapshot = { ...this.snapshot, ...change, selections: review?.selections ?? change.selections ?? [] };
    this.listeners.forEach(listener => listener());
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (visible) this.driveDemand();
  }

  acquireDemand(kind: "summary" | "full") {
    const token = {};
    this.demands.set(token, kind);
    this.syncSummaryObservation();
    this.driveDemand();
    return () => {
      this.demands.delete(token);
      this.syncSummaryObservation();
      this.scheduleNext();
    };
  }

  private get wantsFull() { return [...this.demands.values()].includes("full"); }

  /** Refresh whatever is demanded now (e.g. on focus); a pushed summary needs no refresh. */
  refreshDemanded() { this.driveDemand(); }

  private driveDemand() {
    if (!this.visible || !this.lifetime || !this.demands.size) return;
    if (this.wantsFull) void this.refresh();
    // Without a pushed summary, a full read is the only source of the summary.
    else if (!this.summarySource) void this.refresh();
  }

  /** The daemon pushes the summary when changed paths or claims move, so summary demand holds an observation, not a timer. */
  private syncSummaryObservation() {
    const wanted = Boolean(this.summarySource && this.lifetime && this.demands.size);
    if (!wanted) {
      this.summaryObservation?.release();
      this.summaryObservation = null;
      return;
    }
    if (this.summaryObservation || !this.summarySource) return;
    const observation = this.summarySource(() => this.acceptSummary());
    this.summaryObservation = observation;
    this.acceptSummary();
  }

  private acceptSummary() {
    const fact = this.summaryObservation?.getSnapshot();
    if (!fact || !this.lifetime) return;
    const summaryStatus = fact.phase === "unavailable" ? "unavailable" as const
      : fact.phase === "failed" ? "error" as const
        : fact.summary ? fact.summary.errors.length ? "error" as const : "ready" as const : "loading" as const;
    const changed = fact.summary !== null && fact.summary !== this.lastSummary;
    if (fact.summary) this.lastSummary = fact.summary;
    this.publish({
      summaryStatus,
      summary: fact.summary ?? (fact.failure
        ? { ...this.snapshot.summary, errors: [{ rootId: "", message: fact.failure }] } : this.snapshot.summary),
    });
    // A pushed change to which paths are dirty or claimed refreshes an open review at once instead of at the next poll.
    if (changed && this.wantsFull && this.visible && this.snapshot.status !== "idle") void this.refresh();
  }

  private scheduleNext() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.visible || !this.lifetime || !this.demands.size || this.snapshot.busy) return;
    if (!this.wantsFull && this.summarySource) return;
    this.timer = setTimeout(() => { this.timer = null; this.driveDemand(); }, 5_000);
  }

  activate() {
    this.lifetime ??= {};
    this.syncSummaryObservation();
  }

  dispose() {
    this.lifetime = null;
    this.visible = false;
    this.demands.clear();
    this.syncSummaryObservation();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.contentRequest = null;
    this.content?.clear();
    this.previewWork = null;
    this.statusRequest = {};
    this.listeners.clear();
  }

  async refresh() {
    const lifetime = this.lifetime;
    const port = this.port;
    if (!lifetime || !port || !this.projectId || this.snapshot.busy) return;
    if (this.refreshWork) {
      const existing = this.refreshWork;
      await existing.promise;
      if (existing.lifetime !== lifetime && this.lifetime === lifetime) await this.refresh();
      return;
    }
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const statusRequest = {};
    this.statusRequest = statusRequest;
    const preferCached = this.snapshot.status === "idle";
    this.publish({ refreshing: true, status: preferCached ? "loading" : this.snapshot.status });
    const work = async () => {
      try {
        const data = await port.read({ projectId: this.projectId, preferCached });
        if (this.lifetime !== lifetime || this.snapshot.busy) return;
        const content = this.acceptRead(data, statusRequest);
        if (data.cacheHit) {
          const fresh = await port.read({ projectId: this.projectId });
          if (this.lifetime !== lifetime) return;
          await this.acceptRead(fresh, statusRequest);
        } else await content;
      } catch (error) {
        if (this.lifetime !== lifetime || this.snapshot.busy) return;
        const unavailable = error instanceof WorkbenchDaemonRequestError && error.code === -32601;
        this.publish({
          status: unavailable ? "unavailable" : "error",
          ...(this.statusRequest === statusRequest ? { summaryStatus: unavailable ? "unavailable" as const : "error" as const } : {}),
          error: unavailable
            ? "This daemon does not support the working-tree view yet."
            : error instanceof Error ? error.message : "Unable to read working-tree changes.",
        });
      }
    };
    const promise = work().finally(() => {
      this.refreshWork = null;
      if (this.lifetime === lifetime) this.publish({ refreshing: false });
      if (this.lifetime === lifetime) this.scheduleNext();
    });
    this.refreshWork = { lifetime, promise };
    await promise;
  }

  private acceptRead(incoming: WorkingTreeRead, statusRequest: object) {
    const data: WorkingTreeRead = {
      ...incoming,
      repositories: [...incoming.repositories, ...this.snapshot.data.repositories.filter(repository =>
        incoming.errors.some(error => error.rootId === repository.rootId)
        && !incoming.repositories.some(fresh => fresh.rootId === repository.rootId),
      )],
    };
    const oldRepository = this.repository;
    const oldFile = this.file;
    const repository = data.repositories.find(repository => repository.rootId === this.snapshot.rootId) ?? data.repositories[0];
    for (const repository of data.repositories) {
      const previous = this.reviews.get(repository.rootId);
      const sameHead = previous?.repository.head === repository.head && previous.repository.cwd === repository.cwd;
      // A file's identity covers both its base and worktree content, so a pick survives HEAD moving exactly when it still means the same change.
      const selections = previous?.repository.cwd === repository.cwd ? previous.selections.filter(selection =>
        repository.files.some(file => file.path === selection.path && file.identity === selection.identity && !file.ownerIds.length),
      ) : [];
      for (const file of repository.files) {
        if (file.ownerIds.length) continue;
        const oldFile = previous?.repository.files.find(old => old.path === file.path);
        if (!previous || (sameHead && (!oldFile || oldFile.ownerIds.length))) {
          selections.push({ path: file.path, identity: file.identity, lineIds: null });
        }
      }
      this.reviews.set(repository.rootId, { repository, selections });
    }
    const file = repository?.files.find(file => file.path === this.snapshot.path)
      ?? repository?.files.find(file => !file.ownerIds.length) ?? repository?.files[0];
    this.publish({
      data, rootId: repository?.rootId ?? "", path: file?.path ?? "",
      ...(this.statusRequest === statusRequest ? { summary: {
        repositories: data.repositories.map(item => ({
          rootId: item.rootId, label: item.label, dirty: item.files.some(changed => !changed.ownerIds.length),
          unclaimed: item.files.filter(changed => !changed.ownerIds.length).length,
        })),
        errors: data.errors,
      }, summaryStatus: data.errors.length ? "error" as const : "ready" as const } : {}),
      status: data.errors.length && !repository ? "error" : "ready",
      error: data.errors.map(error => error.message).join("\n"),
    });
    return file?.identity !== oldFile?.identity || repository?.rootId !== oldRepository?.rootId || this.snapshot.initialising
      ? this.loadContent() : Promise.resolve();
  }

  selectRoot(rootId: string) {
    if (this.snapshot.busy || rootId === this.snapshot.rootId) return;
    this.drafts.set(this.snapshot.rootId, this.snapshot.draft);
    const repository = this.snapshot.data.repositories.find(repository => repository.rootId === rootId);
    this.publish({ rootId, path: (repository?.files.find(file => !file.ownerIds.length) ?? repository?.files[0])?.path ?? "", draft: this.drafts.get(rootId) ?? blankDraft(), result: null });
    void this.loadContent();
  }

  selectFile(path: string) {
    if (this.snapshot.path === path) return;
    this.publish({ path });
    void this.loadContent();
  }

  async loadContent() {
    if (!this.lifetime || !this.content) return;
    const file = this.file;
    const token = {};
    this.contentRequest = token;
    if (!file || !this.repository) {
      this.publish({ diff: null, preview: null, contentError: "", contentStatus: "idle", initialising: false });
      return;
    }
    const request = { projectId: this.projectId, rootId: this.snapshot.rootId, path: file.path, identity: file.identity };
    const cwd = this.repository.cwd;
    const key = this.contentKey(request, cwd);
    const cached = this.content.peek("diff", key);
    this.publish({
      diff: cached, preview: this.content.peek("preview", key), contentError: "",
      contentStatus: cached ? "ready" : "loading",
    });
    if (cached) { this.publish({ initialising: false }); return; }
    const port = this.port!;
    try {
      const diff = await this.content.read("diff", key, () => port.diff(request));
      if (this.contentRequest !== token || !this.lifetime) return;
      this.publish({ diff, contentStatus: "ready" });
    } catch (error) {
      if (this.contentRequest === token) this.publish({ contentStatus: "error", contentError: error instanceof Error ? error.message : "Unable to load diff." });
    } finally {
      if (this.contentRequest === token) this.publish({ initialising: false });
    }
  }

  async loadPreview() {
    const file = this.file;
    const token = this.contentRequest;
    const content = this.content;
    if (!this.lifetime || !content || !token || !file || this.snapshot.preview?.identity === file.identity) return;
    if (this.previewWork?.token === token) return await this.previewWork.promise;
    const port = this.port!;
    const request = { projectId: this.projectId, rootId: this.snapshot.rootId, path: file.path, identity: file.identity };
    const work = async () => {
      try {
        const preview = await content.read("preview", this.contentKey(request, this.repository!.cwd), () => port.preview(request));
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
    // Commit and branch drafts are the same message, so moving between them keeps what was typed.
    const carried = (mode === "branch" && this.snapshot.draft.mode === "commit") || (mode === "commit" && this.snapshot.draft.mode === "branch")
      ? { ...this.snapshot.draft, mode, branch: stored?.branch ?? "" } : null;
    this.publish({ draft: carried ?? stored ?? {
      mode, title: mode === "amend" ? title : "", description: mode === "amend" ? body.join("\n").trim() : "",
      targetCommit: mode === "amend" ? this.repository?.head ?? null : null, branch: "",
    }, result: null });
  }

  reviewHead() {
    if (this.snapshot.busy || this.snapshot.draft.mode !== "amend") return;
    const [title = "", ...body] = (this.repository?.message.trimEnd() ?? "").split("\n");
    this.publish({ draft: { ...this.snapshot.draft, title, description: body.join("\n").trim(), targetCommit: this.repository?.head ?? null }, operationError: "" });
  }

  async submit(mode: "commit" | "amend" | "stash" | "discard" | "branch" = this.snapshot.draft.mode, scope?: Pick<WorkingTreeMutation, "rootId" | "expectedHead" | "selections">) {
    const repository = this.repository;
    if (!repository || !this.port || this.mutationBlocked) return;
    if (mode === "amend" && this.snapshot.draft.targetCommit !== repository.head) {
      this.publish({ operationError: "HEAD changed. Review the new HEAD before amending." });
      return;
    }
    const selections = scope?.selections ?? this.snapshot.selections;
    this.publish({ busy: true, result: null, operationError: "" });
    let branched = false;
    try {
      // The new branch starts at HEAD, so the commit's expected HEAD still holds after creating it.
      if (mode === "branch") {
        if (!this.refs) throw new Error("Branching is unavailable on this device.");
        await this.refs.mutateRef({ projectId: ProjectIdSchema.parse(this.projectId), action: "createBranch", branch: this.snapshot.draft.branch.trim() });
        branched = true;
      }
      const result = await this.port.mutate({
        projectId: this.projectId, rootId: scope?.rootId ?? repository.rootId, expectedHead: scope ? scope.expectedHead : repository.head,
        targetCommit: mode === "amend" ? this.snapshot.draft.targetCommit : null, mode: mode === "branch" ? "commit" : mode, selections,
        title: this.snapshot.draft.title, description: this.snapshot.draft.description,
      });
      this.publish({ result, selections: result.status === "complete" ? [] : this.snapshot.selections });
      if (result.status === "complete" && !scope) this.setDraftAfterSubmit();
    } catch (error) {
      this.publish({
        operationError: error instanceof Error ? error.message : "Git operation failed.",
        // The branch exists and is checked out now, so a retry only needs to commit.
        ...branched ? { draft: { ...this.snapshot.draft, mode: "commit" as const, branch: "" } } : {},
      });
    } finally {
      this.publish({ busy: false });
      await this.refresh();
    }
  }

  private setDraftAfterSubmit() {
    this.drafts.delete(`${this.snapshot.rootId}:${this.snapshot.draft.mode}`);
    this.publish({ draft: blankDraft() });
  }
}
