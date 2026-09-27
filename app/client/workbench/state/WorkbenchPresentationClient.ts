/*
 * Exports:
 * - default WorkbenchPresentationClient: own app presentation reads, mutations, attachment transfer, and freshness.
 */
import type {
  PresentationDraftInput, PresentationMutation, PresentationSnapshot,
} from "workbench-shared/state/workbench-presentation-state";
import type { WorkbenchControls, WorkbenchLogicalThreadRow } from "workbench-shared/types";
import {
  PresentationMutationSchema, PresentationSnapshotSchema,
} from "workbench-shared/state/workbench-presentation-state";
import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";
import type { LogicalProjectId } from "workbench-shared/workbench/identity";
import {
  createWorkbenchThreadFolder, getWorkbenchThreadDisplayKey, moveWorkbenchThreadDisplayItem,
  projectWorkbenchThreadDisplaySection, renameWorkbenchThreadFolder,
} from "workbench-shared/workbench/thread/thread-display-order";
import { projectLogicalPinnedDisplayOrder, projectLogicalThreadDisplayOrder } from "../WorkbenchProjectProjection";
import {
  createThreadDisplayFolder, getProjectQualifiedThreadDisplayKey,
  moveThreadDisplayLayoutItem, projectThreadDisplayLayoutSection, renameThreadDisplayFolder,
} from "workbench-shared/workbench/thread/thread-display-layout";
import { getThreadSidebarGroup } from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchThreadDisplayOrder } from "workbench-shared/workbench/thread/thread-display-order";
import {
  getWorkbenchHomeThreadKey, resolveWorkbenchHomeThreadSectionKeys,
  type WorkbenchHomeThreadDisplayOrder,
} from "workbench-shared/workbench/thread/home-thread-display-order";
import { getWorkbenchThreadDisplaySection } from "workbench-shared/workbench/thread/thread-display-order";
import { z } from "zod";
import type WorkbenchAppRpcClient from "../app/WorkbenchAppRpcClient";

const path = "/api/workbench-presentation";
const failureSchema = z.object({ error: z.string().max(512) }).strict();
type PresentationState = {
  data: PresentationSnapshot | null;
  error: string | null;
  phase: "idle" | "loading" | "ready" | "failed";
};

export default class WorkbenchPresentationClient {
  private state: PresentationState = { data: null, error: null, phase: "idle" };
  private readonly listeners = new Set<() => void>();
  private readonly requests = new Set<AbortController>();
  private readonly deletedDraftRevisions = new Map<string, number>();
  private closed = false;
  private notifiedRevision = -1;
  private notificationRefresh: Promise<void> | null = null;

  constructor(private readonly options: { fetcher?: typeof fetch; rpc?: WorkbenchAppRpcClient } = {}) {}

  readonly snapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  noticeRevision(revision: number) {
    if (this.closed || revision <= (this.state.data?.revision ?? -1)) return;
    this.notifiedRevision = Math.max(this.notifiedRevision, revision);
    if (this.notificationRefresh) return;
    const operation = this.drainRevisions();
    const settled = operation.finally(() => {
      if (this.notificationRefresh === settled) this.notificationRefresh = null;
    });
    this.notificationRefresh = settled;
  }

  private async drainRevisions() {
    while (!this.closed && this.notifiedRevision > (this.state.data?.revision ?? -1)) {
      const before = this.state.data?.revision ?? -1;
      const noticeBefore = this.notifiedRevision;
      try {
        await this.refresh();
        if ((this.state.data?.revision ?? -1) <= before) {
          if (this.notifiedRevision > noticeBefore) continue;
          this.publish({ ...this.state, error: "Presentation update is not visible yet.", phase: "failed" });
          return;
        }
      }
      catch { return; } // refresh retains the bounded failure in presentation state.
    }
  }

  draft(id: string) {
    return this.state.data?.drafts.find(draft => draft.id === id) ?? null;
  }

  attachmentUrl(draftId: string, attachmentId: string) {
    return `${path}/drafts/${encodeURIComponent(draftId)}/attachments/${encodeURIComponent(attachmentId)}`;
  }

  async putDraft(draft: PresentationDraftInput) {
    const existing = this.draft(draft.id);
    const result = await this.mutate({ kind: "putDraft",
      expectedRevision: existing?.revision ?? this.deletedDraftRevisions.get(draft.id) ?? null, draft });
    this.deletedDraftRevisions.delete(draft.id);
    return result;
  }

  async removeDraft(id: string) {
    const existing = this.draft(id);
    if (!existing || existing.phase !== "unsent") return;
    const result = await this.mutate({ kind: "deleteDraft", draftId: existing.id,
      expectedRevision: existing.revision });
    this.deletedDraftRevisions.set(id, result.revision);
  }

  async setDraftPriority(id: string, priority: { pinned: boolean; snoozed: boolean }) {
    const draft = this.draft(id);
    if (!draft || draft.phase !== "unsent") throw new Error("The unsent draft is unavailable.");
    await this.mutate({
      kind: "setDraftPriority", draftId: draft.id, expectedRevision: draft.revision, ...priority,
    });
  }

  async saveProjectLayout(logicalProjectId: LogicalProjectId,
    rows: readonly WorkbenchLogicalThreadRow[], displayOrder: WorkbenchThreadDisplayOrder) {
    await this.mutate(this.projectLayoutMutation(logicalProjectId, rows, displayOrder));
  }

  async saveHomeLayout(rows: readonly WorkbenchLogicalThreadRow[], order: WorkbenchHomeThreadDisplayOrder) {
    await this.mutate(this.homeLayoutMutation(rows, order));
  }

  async saveHomeAndProjectLayouts(logicalProjectId: LogicalProjectId,
    rows: readonly WorkbenchLogicalThreadRow[], projectOrder: WorkbenchThreadDisplayOrder,
    homeOrder: WorkbenchHomeThreadDisplayOrder) {
    const project = this.projectLayoutMutation(logicalProjectId, rows, projectOrder);
    const home = this.homeLayoutMutation(rows, homeOrder);
    await this.mutate({
      kind: "saveLayouts", expectedRevision: project.expectedRevision,
      layouts: [
        { scope: project.scope, logicalProjectId: project.logicalProjectId,
          folders: project.folders, members: project.members },
        { scope: home.scope, logicalProjectId: home.logicalProjectId,
          folders: home.folders, members: home.members },
      ],
    });
  }

  async updateProjectLayout(logicalProjectId: LogicalProjectId,
    rows: readonly WorkbenchLogicalThreadRow[],
    intent: Parameters<WorkbenchControls["updatePresentationProjectLayout"]>[2],
    homeOrder?: WorkbenchHomeThreadDisplayOrder) {
    const snapshot = this.state.data;
    if (!snapshot) throw new Error("Project layout is unavailable.");
    const scopedRows = rows.filter(row => row.logicalProjectId === logicalProjectId);
    const entries = scopedRows.map(row => row.entry);
    const current = projectLogicalThreadDisplayOrder(logicalProjectId, scopedRows, snapshot);
    let next: WorkbenchThreadDisplayOrder | null;
    if (intent.kind === "rename") {
      next = renameWorkbenchThreadFolder(entries, current, intent.folderId, intent.title);
    } else if (intent.kind === "drop") {
      const folderId = intent.destinationFolderId ?? intent.folderId ?? crypto.randomUUID();
      const withFolder = intent.destinationFolderId ? current : createWorkbenchThreadFolder(
        entries, current, folderId, intent.targetKey, "New folder",
      );
      next = withFolder ? moveWorkbenchThreadDisplayItem(
        entries, withFolder, intent.section, intent.sourceKey, folderId, null,
      ) : null;
    } else {
      next = moveWorkbenchThreadDisplayItem(
        entries, current, intent.section, intent.sourceKey,
        intent.destinationFolderId, intent.beforeKey,
      );
    }
    if (!next) throw new Error("Project layout position is no longer available.");
    if (homeOrder) await this.saveHomeAndProjectLayouts(logicalProjectId, rows, next, homeOrder);
    else await this.saveProjectLayout(logicalProjectId, rows, next);
  }

  async updatePinnedLayout(
    rows: readonly WorkbenchLogicalThreadRow[],
    intent:
      | { kind: "move"; sourceKey: string; destinationFolderId: string | null; beforeKey: string | null }
      | { kind: "drop"; sourceKey: string; targetKey: string; destinationFolderId: string | null;
        folderId?: string }
      | { kind: "rename"; folderId: string; title: string },
  ) {
    const snapshot = this.state.data;
    if (!snapshot) throw new Error("Pinned layout is unavailable.");
    const entries = rows.filter(row => getThreadSidebarGroup(row.entry) === "pinned").map(row => ({
      key: getProjectQualifiedThreadDisplayKey(row.logicalProjectId, getWorkbenchThreadDisplayKey(row.entry)),
      section: "pinned" as const,
    }));
    const current = projectLogicalPinnedDisplayOrder(rows, snapshot);
    let next: WorkbenchThreadDisplayOrder | null;
    if (intent.kind === "rename") {
      next = renameThreadDisplayFolder(current, intent.folderId, intent.title);
    } else if (intent.kind === "drop") {
      const folderId = intent.destinationFolderId ?? intent.folderId ?? crypto.randomUUID();
      const withFolder = intent.destinationFolderId ? current : createThreadDisplayFolder(
        entries, current, folderId, intent.targetKey, "New folder",
      );
      next = withFolder ? moveThreadDisplayLayoutItem(
        entries, withFolder, "pinned", intent.sourceKey, folderId, null,
      ) : null;
    } else {
      next = moveThreadDisplayLayoutItem(
        entries, current, "pinned", intent.sourceKey, intent.destinationFolderId, intent.beforeKey,
      );
    }
    if (!next) throw new Error("Pinned layout position is no longer available.");
    await this.savePinnedLayout(rows, next);
  }

  async savePinnedLayout(rows: readonly WorkbenchLogicalThreadRow[], order: WorkbenchThreadDisplayOrder) {
    const snapshot = this.state.data;
    if (!snapshot) throw new Error("Pinned layout is unavailable.");
    const pinned = rows.filter(row => getThreadSidebarGroup(row.entry) === "pinned");
    const entries = pinned.map(row => ({
      key: getProjectQualifiedThreadDisplayKey(row.logicalProjectId, getWorkbenchThreadDisplayKey(row.entry)),
      section: "pinned" as const,
    }));
    const byKey = new Map(pinned.map(row => [
      getProjectQualifiedThreadDisplayKey(row.logicalProjectId, getWorkbenchThreadDisplayKey(row.entry)), row,
    ]));
    const folders: Extract<PresentationMutation, { kind: "saveLayout" }>["folders"] = [];
    const members: Extract<PresentationMutation, { kind: "saveLayout" }>["members"] = [];
    for (const item of projectThreadDisplayLayoutSection(entries, entries, order, "pinned")) {
      const folderId = item.itemKind === "folder" ? item.folder.folderId : null;
      if (item.itemKind === "folder") folders.push({
        id: item.folder.folderId, scope: "pinned", logicalProjectId: null,
        title: item.folder.title, position: folders.length,
      });
      for (const entry of item.itemKind === "folder" ? item.entries : [item.entry]) {
        const row = byKey.get(entry.key);
        if (!row) throw new Error("A pinned row lost its daemon source.");
        const existing = snapshot.members.find(member => member.scope === "pinned"
          && (row.entry.entryKind === "draft"
            ? member.kind === "draft" && member.draftId === row.entry.draft.draftId
            : member.kind === "thread" && member.thread?.threadId === row.entry.identity.threadId
              && member.thread.location.daemonId === row.location.daemonId
              && member.thread.location.projectId === row.location.projectId));
        members.push({
          id: existing?.id ?? crypto.randomUUID(), scope: "pinned", logicalProjectId: null,
          folderId, position: members.length,
          kind: row.entry.entryKind === "draft" ? "draft" : "thread",
          draftId: row.entry.entryKind === "draft" ? row.entry.draft.draftId : null,
          thread: row.entry.entryKind === "draft" ? null : {
            location: row.location, threadId: row.entry.identity.threadId,
          },
        });
      }
    }
    await this.mutate({
      kind: "saveLayout", scope: "pinned", logicalProjectId: null,
      expectedRevision: snapshot.revision, folders, members,
    });
  }

  private projectLayoutMutation(logicalProjectId: LogicalProjectId,
    rows: readonly WorkbenchLogicalThreadRow[], displayOrder: WorkbenchThreadDisplayOrder):
    Extract<PresentationMutation, { kind: "saveLayout" }> {
    const snapshot = this.state.data;
    if (!snapshot) throw new Error("Project layout is unavailable.");
    const scopedRows = rows.filter(row => row.logicalProjectId === logicalProjectId);
    const rowByKey = new Map(scopedRows.map(row => [getWorkbenchThreadDisplayKey(row.entry), row]));
    const existingMemberId = (row: WorkbenchLogicalThreadRow) =>
      snapshot.members.find(member => member.scope === "project"
        && member.logicalProjectId === logicalProjectId
        && (row.entry.entryKind === "draft"
          ? member.kind === "draft" && member.draftId === row.entry.draft.draftId
          : member.kind === "thread" && member.thread?.threadId === row.entry.identity.threadId
            && member.thread.location.daemonId === row.location.daemonId
            && member.thread.location.projectId === row.location.projectId))?.id ?? crypto.randomUUID();
    const folders: Extract<PresentationMutation, { kind: "saveLayout" }>["folders"] = [];
    const members: Extract<PresentationMutation, { kind: "saveLayout" }>["members"] = [];
    for (const section of ["pinned", "snoozed", "settled"] as const) {
      for (const item of projectWorkbenchThreadDisplaySection(
        scopedRows.map(row => row.entry), displayOrder, section,
      )) {
        const folderId = item.itemKind === "folder" ? item.folder.folderId : null;
        if (item.itemKind === "folder") folders.push({
          id: item.folder.folderId, scope: "project", logicalProjectId,
          title: item.folder.title, position: folders.length,
        });
        for (const entry of item.itemKind === "folder" ? item.entries : [item.entry]) {
          const row = rowByKey.get(getWorkbenchThreadDisplayKey(entry));
          if (!row) throw new Error("A project layout row lost its source.");
          members.push({
            id: existingMemberId(row), scope: "project", logicalProjectId,
            folderId, position: members.length,
            kind: entry.entryKind === "draft" ? "draft" : "thread",
            draftId: entry.entryKind === "draft" ? entry.draft.draftId : null,
            thread: entry.entryKind === "draft" ? null : {
              location: row.location, threadId: entry.identity.threadId,
            },
          });
        }
      }
    }
    return {
      kind: "saveLayout", scope: "project", logicalProjectId,
      expectedRevision: snapshot.revision, folders, members,
    };
  }

  private homeLayoutMutation(rows: readonly WorkbenchLogicalThreadRow[], order: WorkbenchHomeThreadDisplayOrder):
    Extract<PresentationMutation, { kind: "saveLayout" }> {
    const snapshot = this.state.data;
    if (!snapshot) throw new Error("Home layout is unavailable.");
    const entries = rows.flatMap(row => {
      const section = getWorkbenchThreadDisplaySection(row.entry);
      return section ? [{ key: getWorkbenchHomeThreadKey(row.logicalProjectId, row.entry), section, row }] : [];
    });
    const byKey = new Map(entries.map(entry => [entry.key, entry.row]));
    const members: Extract<PresentationMutation, { kind: "saveLayout" }>["members"] = [];
    for (const section of ["pinned", "snoozed", "settled"] as const) {
      for (const key of resolveWorkbenchHomeThreadSectionKeys(entries, order, section)) {
        const row = byKey.get(key);
        if (!row) throw new Error("A home layout row lost its daemon source.");
        const existing = snapshot.members.find(member => member.scope === "home"
          && (row.entry.entryKind === "draft"
            ? member.kind === "draft" && member.draftId === row.entry.draft.draftId
            : member.kind === "thread" && member.thread?.threadId === row.entry.identity.threadId
              && member.thread.location.daemonId === row.location.daemonId
              && member.thread.location.projectId === row.location.projectId));
        members.push({
          id: existing?.id ?? crypto.randomUUID(), scope: "home", logicalProjectId: null,
          folderId: null, position: members.length,
          kind: row.entry.entryKind === "draft" ? "draft" : "thread",
          draftId: row.entry.entryKind === "draft" ? row.entry.draft.draftId : null,
          thread: row.entry.entryKind === "draft" ? null : {
            location: row.location, threadId: row.entry.identity.threadId,
          },
        });
      }
    }
    return {
      kind: "saveLayout", scope: "home", logicalProjectId: null,
      expectedRevision: snapshot.revision, folders: [], members,
    };
  }

  async uploadAttachment(draftId: string, attachmentId: string, sourceUrl: string, signal?: AbortSignal) {
    this.assertOpen();
    signal?.throwIfAborted();
    if (!["unsent", "importing"].includes(this.draft(draftId)?.phase ?? "")) {
      throw new Error("Save the draft before attaching an image.");
    }
    const source = await (this.options.fetcher ?? fetch)(sourceUrl, { signal });
    signal?.throwIfAborted();
    if (!source.ok) throw new Error(`Draft image could not be read (HTTP ${source.status}).`);
    const mediaType = source.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mediaType)) {
      throw new Error("Draft image type is unsupported.");
    }
    const bytes = new Uint8Array(await source.arrayBuffer());
    const chunkSize = 1024 * 1024;
    const count = Math.ceil(bytes.length / chunkSize);
    if (!count || count > 1024) throw new Error("Draft image exceeds its size limit.");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hash = [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const url = this.attachmentUrl(draftId, attachmentId);
    for (let index = 0; index < count; index++) {
      signal?.throwIfAborted();
      const chunk = bytes.slice(index * chunkSize, (index + 1) * chunkSize);
      const response = await (this.options.fetcher ?? fetch)(`${url}/chunks/${index}`, {
        method: "PUT", body: chunk, signal,
      });
      signal?.throwIfAborted();
      if (!response.ok) throw await this.responseError(response);
    }
    signal?.throwIfAborted();
    const response = await (this.options.fetcher ?? fetch)(`${url}/complete`, {
      method: "POST", signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count, mediaType, hash }),
    });
    signal?.throwIfAborted();
    if (!response.ok) throw await this.responseError(response);
    const snapshot = this.parseSnapshot(await response.json());
    signal?.throwIfAborted();
    this.accept(snapshot);
    return url;
  }

  async refresh(): Promise<PresentationSnapshot> {
    this.assertOpen();
    const revisionBeforeRead = this.state.data?.revision ?? -1;
    if (!this.state.data) this.publish({ ...this.state, phase: "loading" });
    const controller = new AbortController();
    this.requests.add(controller);
    try {
      let value: unknown;
      if (this.options.rpc?.available) {
        value = await this.options.rpc.requestRaw({ method: "app/presentation/read", params: {} });
      } else {
        const response = await (this.options.fetcher ?? fetch)(path, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw await this.responseError(response);
        value = await response.json();
      }
      const data = this.parseSnapshot(value);
      controller.signal.throwIfAborted();
      this.accept(data);
      return this.state.data!;
    } catch (error) {
      if (!this.closed && (this.state.data?.revision ?? -1) <= revisionBeforeRead) {
        this.publish({ ...this.state, error: this.message(error), phase: "failed" });
      }
      throw error;
    } finally {
      this.requests.delete(controller);
    }
  }

  async mutate(input: PresentationMutation, signal?: AbortSignal): Promise<PresentationSnapshot> {
    this.assertOpen();
    signal?.throwIfAborted();
    const mutation = PresentationMutationSchema.parse(input);
    const controller = new AbortController();
    this.requests.add(controller);
    try {
      let value: unknown;
      if (this.options.rpc?.available) {
        value = await this.options.rpc.requestRaw({
          method: "app/presentation/mutate", params: { mutation },
        });
      } else {
        const response = await (this.options.fetcher ?? fetch)(`${path}/mutate`, {
          method: "POST", cache: "no-store",
          signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(mutation),
        });
        if (!response.ok) throw await this.responseError(response);
        value = await response.json();
      }
      signal?.throwIfAborted();
      const data = this.parseSnapshot(value);
      signal?.throwIfAborted();
      controller.signal.throwIfAborted();
      this.accept(data);
      return data;
    } catch (error) {
      if (this.closed) throw error;
      if (signal?.aborted) throw error;
      try {
        await this.refresh();
      } catch (refreshError) {
        throw new AggregateError([error, refreshError], "Presentation write and reconciliation both failed.");
      }
      throw error;
    } finally {
      this.requests.delete(controller);
    }
  }

  private parseSnapshot(value: unknown) {
    const parsed = PresentationSnapshotSchema.safeParse(value);
    if (!parsed.success) {
      reportClientSchemaError("Rejected Workbench presentation response", parsed.error);
      throw new Error("Workbench presentation returned invalid data.");
    }
    return parsed.data;
  }

  private async responseError(response: Response) {
    const value: unknown = await response.json().catch(() => null);
    const parsed = failureSchema.safeParse(value);
    if (!parsed.success) reportClientSchemaError("Rejected Workbench presentation error response", parsed.error);
    return new Error(parsed.success ? parsed.data.error : `Presentation request failed (HTTP ${response.status}).`);
  }

  private message(error: unknown) {
    return error instanceof Error ? error.message.slice(0, 512) : "Presentation state is unavailable.";
  }

  private accept(data: PresentationSnapshot) {
    if (this.closed || this.state.data && data.revision < this.state.data.revision) return;
    this.publish({ data, error: null, phase: "ready" });
  }

  private publish(state: PresentationState) {
    if (this.closed) return;
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  private assertOpen() {
    if (this.closed) throw new Error("Presentation state has closed.");
  }

  dispose() {
    this.closed = true;
    this.deletedDraftRevisions.clear();
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
    this.listeners.clear();
  }
}
