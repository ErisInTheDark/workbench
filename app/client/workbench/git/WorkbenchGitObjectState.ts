/*
 * Exports:
 * - default WorkbenchGitObjectState: one commit or stash under review: its detail, focused file and that file's diff and
 *   preview, read through a content cache shared by every object view.
 * - GitObjectStateSnapshot: observable detail and content state.
 */
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import type { GitObjectDetail, GitObjectRef } from "workbench-shared/workbench/git/git-object-contracts";
import type { GitChangeset, GitChangesetSnapshot } from "./git-changeset";
import GitContentCache from "./GitContentCache";

type Port = Pick<WorkbenchDaemonClient["git"]["object"], "read" | "diff" | "preview">;

export interface GitObjectStateSnapshot extends GitChangesetSnapshot {
  status: "loading" | "ready" | "error";
  error: string;
  detail: GitObjectDetail | null;
}

/** Object content never changes, so every view of any object on any folder shares one bounded cache. */
const sharedContent = new GitContentCache();

export default class WorkbenchGitObjectState implements GitChangeset {
  private snapshot: GitObjectStateSnapshot;
  private readonly listeners = new Set<() => void>();
  private lifetime: object | null = {};
  private contentRequest: object | null = null;

  constructor(
    /** Distinguishes folders: the daemon and project the object belongs to. */
    private readonly source: { daemonId: string | null; projectId: string },
    readonly object: GitObjectRef,
    private readonly port: Port,
    path: string | null,
    private readonly content: GitContentCache = sharedContent,
  ) {
    this.snapshot = {
      status: "loading", error: "", detail: null, rootId: object.sha, path: path ?? "",
      diff: null, preview: null, contentStatus: "idle", contentError: "", selections: [], busy: false,
    };
  }

  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  get file() {
    return this.snapshot.detail?.files.find(file => file.path === this.snapshot.path) ?? null;
  }

  private publish(change: Partial<GitObjectStateSnapshot>) {
    if (!this.lifetime) return;
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }

  async load() {
    const lifetime = this.lifetime;
    this.publish({ status: "loading", error: "" });
    try {
      const detail = await this.port.read({ projectId: this.source.projectId, object: this.object });
      if (this.lifetime !== lifetime) return;
      const path = detail.files.some(file => file.path === this.snapshot.path) ? this.snapshot.path : detail.files[0]?.path ?? "";
      this.publish({ status: "ready", detail, path });
      await this.loadContent();
    } catch (error) {
      if (this.lifetime === lifetime) this.publish({ status: "error", error: error instanceof Error ? error.message : "Unable to read this change." });
    }
  }

  selectFile(path: string) {
    if (path === this.snapshot.path) return;
    this.publish({ path });
    void this.loadContent();
  }

  private key(kind: "diff" | "preview") {
    const file = this.file;
    return file ? JSON.stringify([kind, this.source.daemonId, this.source.projectId, this.object.sha, file.path, file.identity]) : null;
  }

  async loadContent() {
    const file = this.file;
    const key = this.key("diff");
    const token = {};
    this.contentRequest = token;
    if (!file || !key) { this.publish({ diff: null, preview: null, contentStatus: "idle", contentError: "" }); return; }
    const cached = this.content.peek("diff", key);
    const preview = this.content.peek("preview", this.key("preview")!);
    this.publish({ diff: cached, preview, contentStatus: cached ? "ready" : "loading", contentError: "" });
    if (cached) return;
    const request = { projectId: this.source.projectId, object: this.object, path: file.path };
    try {
      const diff = await this.content.read("diff", key, () => this.port.diff(request));
      if (this.contentRequest === token) this.publish({ diff, contentStatus: "ready" });
    } catch (error) {
      if (this.contentRequest === token) {
        this.publish({ contentStatus: "error", contentError: error instanceof Error ? error.message : "Unable to load diff." });
      }
    }
  }

  async loadPreview() {
    const file = this.file;
    const key = this.key("preview");
    const token = this.contentRequest;
    if (!file || !key || this.snapshot.preview?.identity === file.identity) return;
    const request = { projectId: this.source.projectId, object: this.object, path: file.path };
    try {
      const preview = await this.content.read("preview", key, () => this.port.preview(request));
      if (this.contentRequest === token) this.publish({ preview });
    } catch (error) {
      if (this.contentRequest === token) {
        this.publish({ contentError: error instanceof Error ? error.message : "Unable to load preview." });
      }
    }
  }

  dispose() {
    this.lifetime = null;
    this.contentRequest = null;
    this.listeners.clear();
  }
}
