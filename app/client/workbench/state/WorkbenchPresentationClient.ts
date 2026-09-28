/*
 * Exports:
 * - default WorkbenchPresentationClient: own app presentation reads, mutations, attachment transfer, and freshness.
 */
import type {
  PresentationDraftInput, PresentationSnapshot,
} from "workbench-shared/state/workbench-presentation-state";
import type { WorkbenchControls, WorkbenchLogicalThreadRow } from "workbench-shared/types";
import {
  PresentationSnapshotSchema,
} from "workbench-shared/state/workbench-presentation-state";
import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";
import type { LogicalProjectId } from "workbench-shared/workbench/identity";
import type { WorkbenchThreadDisplayOrder } from "workbench-shared/workbench/thread/thread-display-order";
import type { WorkbenchHomeThreadDisplayOrder } from "workbench-shared/workbench/thread/home-thread-display-order";
import { z } from "zod";
import type WorkbenchWorkspaceClient from "../app/WorkbenchWorkspaceClient";
import type { WorkspaceQueryHandle } from "../app/WorkbenchWorkspaceClient";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import type { WorkspaceHomeLayoutIntent, WorkspaceLayoutRequest } from "workbench-shared/workbench/workspace/workspace-commands";
import { WorkbenchPresentationIntentSchema, type WorkbenchPresentationIntent } from "workbench-shared/http/workbench-app-rpc";

type LayoutIntent = {
  [Action in WorkspaceLayoutRequest["action"]]: Omit<Extract<WorkspaceLayoutRequest, { action: Action }>, "expectedRevision">;
}[WorkspaceLayoutRequest["action"]];

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
  private observation: WorkspaceQueryHandle<"presentation"> | null = null;

  constructor(private readonly options: { fetcher?: typeof fetch; workspace: WorkbenchWorkspaceClient }) {}

  readonly snapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  start() {
    this.assertOpen();
    if (this.observation) return;
    const update = () => {
      const fact = observation.getSnapshot();
      if (fact.value?.data) this.accept(fact.value.data);
      if (fact.failure) this.publish({ ...this.state, error: fact.failure, phase: "failed" });
    };
    const observation = this.options.workspace.observe({ kind: "presentation" }, update);
    this.observation = observation;
    update();
  }

  ready(): Promise<PresentationSnapshot> {
    this.assertOpen();
    this.start();
    if (this.state.data) return Promise.resolve(this.state.data);
    return new Promise((resolve, reject) => {
      const changed = () => {
        if (!this.closed && !this.state.data && !this.state.error) return;
        this.listeners.delete(changed);
        if (this.closed) reject(new Error("Presentation state has closed."));
        else if (this.state.data) resolve(this.state.data);
        else reject(new Error(this.state.error ?? "Presentation state is unavailable."));
      };
      this.listeners.add(changed);
      changed();
    });
  }

  draft(id: string) {
    return this.state.data?.drafts.find(draft => draft.id === id) ?? null;
  }

  attachmentUrl(draftId: string, attachmentId: string) {
    return `${path}/drafts/${encodeURIComponent(draftId)}/attachments/${encodeURIComponent(attachmentId)}`;
  }

  async putDraft(draft: PresentationDraftInput,
    placement?: Extract<WorkbenchPresentationIntent, { kind: "putDraft" }>["placement"]) {
    const existing = this.draft(draft.id);
    const result = await this.mutate({ kind: "putDraft",
      expectedRevision: existing?.revision ?? this.deletedDraftRevisions.get(draft.id) ?? null, draft, placement });
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
    _rows: readonly WorkbenchLogicalThreadRow[], displayOrder: WorkbenchThreadDisplayOrder) {
    await this.layout({ action: "projectSave", logicalProjectId, order: displayOrder });
  }

  async saveHomeLayout(_rows: readonly WorkbenchLogicalThreadRow[], order: WorkbenchHomeThreadDisplayOrder) {
    await this.layout({ action: "homeSave", order });
  }

  async updateHomeLayout(intent: WorkspaceHomeLayoutIntent) {
    await this.layout({ action: "homeEdit", intent });
  }

  async saveHomeAndProjectLayouts(logicalProjectId: LogicalProjectId,
    _rows: readonly WorkbenchLogicalThreadRow[], projectOrder: WorkbenchThreadDisplayOrder,
    homeOrder: WorkbenchHomeThreadDisplayOrder) {
    await this.layout({ action: "projectAndHomeSave", logicalProjectId, order: projectOrder, homeOrder });
  }

  async updateProjectLayout(logicalProjectId: LogicalProjectId,
    _rows: readonly WorkbenchLogicalThreadRow[],
    intent: Parameters<WorkbenchControls["updatePresentationProjectLayout"]>[2],
    homeOrder?: WorkbenchHomeThreadDisplayOrder) {
    await this.layout({ action: "projectEdit", logicalProjectId, intent, homeOrder });
  }

  async updatePinnedLayout(
    _rows: readonly WorkbenchLogicalThreadRow[],
    intent:
      | { kind: "move"; sourceKey: string; destinationFolderId: string | null; beforeKey: string | null }
      | { kind: "drop"; sourceKey: string; targetKey: string; destinationFolderId: string | null;
        folderId?: string }
      | { kind: "rename"; folderId: string; title: string },
  ) {
    await this.layout({ action: "pinnedEdit", intent });
  }

  async savePinnedLayout(_rows: readonly WorkbenchLogicalThreadRow[], order: WorkbenchThreadDisplayOrder) {
    await this.layout({ action: "pinnedSave", order });
  }

  private async layout(intent: LayoutIntent) {
    this.assertOpen();
    if (!this.state.data) throw new Error("Layout facts are unavailable.");
    const result = await this.options.workspace.rpc.requestRaw({
      method: "workspace/layout", params: { ...intent, expectedRevision: this.state.data.revision },
    });
    this.accept(this.parseSnapshot(result));
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
    this.start();
    const value = await this.options.workspace.waitFor(this.observation!);
    if (value.kind !== "presentation" || !value.data) throw new Error("Presentation facts are unavailable.");
    this.accept(value.data);
    return value.data;
  }

  async mutate(input: WorkbenchPresentationIntent, signal?: AbortSignal): Promise<PresentationSnapshot> {
    this.assertOpen();
    signal?.throwIfAborted();
    const mutation = WorkbenchPresentationIntentSchema.parse(input);
    const controller = new AbortController();
    this.requests.add(controller);
    try {
      const value = await this.options.workspace.rpc.requestRaw({
          method: "app/presentation/mutate", params: { mutation },
        }, { signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal });
      signal?.throwIfAborted();
      const data = this.parseSnapshot(value);
      signal?.throwIfAborted();
      controller.signal.throwIfAborted();
      this.accept(data);
      return data;
    } catch (error) {
      if (this.closed) throw error;
      if (signal?.aborted) throw error;
      this.publish({ ...this.state, error: this.message(error), phase: "failed" });
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
    if (areDeeplyEqual(this.state, state)) return;
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  private assertOpen() {
    if (this.closed) throw new Error("Presentation state has closed.");
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.observation?.release();
    this.deletedDraftRevisions.clear();
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
    for (const listener of [...this.listeners]) listener();
    this.listeners.clear();
  }
}
