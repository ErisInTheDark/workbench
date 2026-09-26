/*
 * Default export:
 * - WorkbenchPresentationImportController: reconcile attached-daemon legacy presentation once per app connection.
 */
import { createHash } from "node:crypto";
import WorkbenchSocketClient from "workbench-shared/workbench/WorkbenchSocketClient";
import WorkbenchDaemonClient, { WorkbenchDaemonRequestError } from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import { isWorkbenchRpcFailure } from "workbench-shared/workbench/workbench-rpc";
import {
  WorkbenchGlobalThreadStateOpenResultSchema,
  WorkbenchHomeThreadDisplayOrderSchema,
  type WorkbenchProjectThreadSidebars,
} from "workbench-shared/workbench/thread/thread-state";
import { WorkbenchThreadDisplayOrderSchema } from "workbench-shared/workbench/thread/thread-display-order";
import type { WorkbenchPresentationManifestPage } from "workbench-shared/workbench/thread/thread-presentation-export";
import type {
  PresentationMutation, PresentationSnapshot, WorkbenchPresentationImportStatus,
} from "workbench-shared/state/workbench-presentation-state";
import {
  homeLegacyPresentationLayout, pinnedLegacyPresentationLayout, projectLegacyPresentationLayout,
} from "workbench-shared/state/workbench-presentation-legacy-layout";
import { DaemonIdSchema, type DaemonId, type DraftId, type ProjectId } from "workbench-shared/workbench/identity";
import type WorkbenchProcessLogger from "workbench-shared/process/WorkbenchProcessLogger";
import type WorkbenchNetworkController from "../network/WorkbenchNetworkController";
import type WorkbenchPresentationController from "./WorkbenchPresentationController";

type Source = WorkbenchPresentationManifestPage["sources"][number];
const ATTACHMENT_CHUNK_BYTES = 1024 * 1024;
const MAX_ATTACHMENT_CHUNKS = 1024;
const expectedImportFailures = new Set([
  "Imported draft location is unavailable.",
  "Legacy draft has an unsupported external image URL.",
  "Legacy image changed during transfer.",
  "Legacy image transfer did not advance.",
  "Legacy image content did not match its source.",
  "Legacy image exceeds the app attachment limit.",
  "Legacy layout changed during transfer.",
  "Legacy layout length changed during transfer.",
  "Legacy layout transfer did not advance.",
  "Legacy layout transfer is incomplete.",
  "Legacy project layout source is unavailable.",
]);
type Owner = Pick<WorkbenchPresentationController,
  "read" | "readImportReceipts" | "mutate" | "mutateImportBatch" | "putAttachmentChunk" | "completeAttachment">;
type Network = Pick<WorkbenchNetworkController, "snapshot" | "connection" | "subscribe">;
interface ImportSourceConnection {
  daemon: WorkbenchDaemonClient;
  request<TResponse>(method: string, params: object): Promise<TResponse>;
  close(): void;
}

export default class WorkbenchPresentationImportController {
  private readonly cancellation = new AbortController();
  private unsubscribe: (() => void) | null = null;
  private running: Promise<void> | null = null;
  private requested: { daemonId: DaemonId; port: number; hostname: string } | null = null;
  private lastReadyKey: string | null = null;
  private activeKey: string | null = null;
  private source: ImportSourceConnection | null = null;
  private status: WorkbenchPresentationImportStatus = {
    phase: "idle", scanned: 0, imported: 0, failed: 0,
  };
  private readonly listeners = new Set<(status: WorkbenchPresentationImportStatus) => void>();

  constructor(private readonly options: {
    network: Network;
    presentation: Owner;
    logger: WorkbenchProcessLogger;
    openSource?: (port: number, signal: AbortSignal) => ImportSourceConnection;
  }) {}

  start() {
    this.unsubscribe = this.options.network.subscribe(() => this.observe());
    this.observe();
    return this.running;
  }

  snapshot() { return this.status; }

  subscribe(listener: (status: WorkbenchPresentationImportStatus) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async close() {
    this.cancellation.abort();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.retireSource();
    await this.running;
    this.listeners.clear();
  }

  private observe() {
    if (this.cancellation.signal.aborted) return;
    const daemon = this.options.network.snapshot().daemon;
    const port = this.options.network.connection().localPort;
    if (!daemon || daemon.state !== "ready" || !port) {
      this.retireSource();
      return;
    }
    const key = `${daemon.daemonId}:${port}`;
    if (this.activeKey && this.activeKey !== key) this.retireSource();
    if (this.lastReadyKey === key) return;
    this.lastReadyKey = key;
    this.requested = { daemonId: DaemonIdSchema.parse(daemon.daemonId), port, hostname: daemon.hostname };
    if (this.running) return;
    this.drive();
  }

  private drive() {
    const operation = (async () => {
      while (this.requested && !this.cancellation.signal.aborted) {
        const target = this.requested;
        this.requested = null;
        try {
          await this.reconcile(target);
        } catch (error) {
          if (this.cancellation.signal.aborted) break;
          this.publishStatus({ ...this.status, phase: "failed", failed: Math.max(this.status.failed, 1) });
          this.warn("job", error);
        }
      }
    })();
    this.running = operation.finally(() => {
      this.running = null;
      if (this.requested && !this.cancellation.signal.aborted) this.drive();
    });
  }

  private async reconcile(target: { daemonId: DaemonId; port: number; hostname: string }) {
    const startedAt = Date.now();
    this.publishStatus({ phase: "running", scanned: 0, imported: 0, failed: 0 });
    const source = this.options.openSource?.(target.port, this.cancellation.signal)
      ?? this.openSource(target.port);
    this.source = source;
    this.activeKey = `${target.daemonId}:${target.port}`;
    const { daemon, request } = source;
    let scanned = 0;
    let imported = 0;
    let skipped = 0;
    let failed = 0;
    let globalOpened = false;
    this.options.logger.line("app", "presentation import started");
    try {
      const locations = await daemon.projects.locations();
      this.assertCurrent(target.daemonId, target.port);
      this.options.presentation.mutate({
        kind: "registerLocations", daemonId: target.daemonId, hostname: target.hostname, catalog: locations,
      });
      const snapshot = this.options.presentation.read();
      let cursor: string | null = null;
      let sidebars: WorkbenchProjectThreadSidebars | null = null;
      do {
        const page = await daemon.presentationExport.manifest({ cursor, limit: 200 });
        this.assertCurrent(target.daemonId, target.port);
        scanned += page.sources.length;
        const receiptSources = page.sources.map(source => ({
          kind: source.kind === "draft" ? "draft" as const : "layout" as const,
          sourceId: source.sourceId,
        }));
        const present = this.options.presentation.readImportReceipts(target.daemonId, receiptSources).present;
        const accepted = new Set(present.map(source => `${source.kind}:${source.sourceId}`));
        const missing = page.sources.filter((source, index) =>
          !accepted.has(`${receiptSources[index]!.kind}:${source.sourceId}`));
        skipped += page.sources.length - missing.length;
        for (let index = 0; index < missing.length;) {
          this.cancellation.signal.throwIfAborted();
          const source = missing[index]!;
          if (source.kind === "draft") {
            const draftIds: DraftId[] = [];
            while (index < missing.length && draftIds.length < 10) {
              const candidate = missing[index];
              if (candidate?.kind !== "draft" || candidate.projectId !== source.projectId) break;
              draftIds.push(candidate.sourceId);
              index++;
            }
            try {
              const outcome = await this.importDrafts(target.daemonId, source.projectId, draftIds, daemon, snapshot);
              imported += outcome.imported;
              failed += outcome.failed;
            } catch (error) {
              this.assertActive(target.daemonId);
              failed += draftIds.length;
              this.warn("drafts", error);
            }
            continue;
          }
          index++;
          try {
            if (!sidebars) {
              const result = WorkbenchGlobalThreadStateOpenResultSchema.parse(
                await request("workbench/thread-state/global/open", { version: 7 }));
              globalOpened = true;
              sidebars = result.projectSidebars;
            }
            await this.importLayout(target.daemonId, source, daemon, snapshot, sidebars);
            imported++;
          } catch (error) {
            this.assertActive(target.daemonId);
            failed++;
            this.warn("layout", error);
          }
        }
        this.publishStatus({ phase: "running", scanned, imported, failed });
        cursor = page.nextCursor;
      } while (cursor !== null);
      this.publishStatus({ phase: failed ? "partial" : "complete", scanned, imported, failed });
      this.options.logger.line("app", `presentation import ${failed ? "partial" : "complete"}: ${imported} added, ${skipped} present, ${failed} failed of ${scanned} in ${Date.now() - startedAt}ms`);
    } catch (error) {
      if (this.lastReadyKey === `${target.daemonId}:${target.port}`) this.lastReadyKey = null;
      throw error;
    } finally {
      if (globalOpened && !this.cancellation.signal.aborted) {
        try { await request("workbench/thread-state/global/close", {}); }
        catch (error) { this.warn("observation close", error); }
      }
      if (this.source === source) this.retireSource();
      this.activeKey = null;
    }
  }

  private retireSource() {
    const source = this.source;
    this.source = null;
    source?.close();
  }

  private assertCurrent(daemonId: DaemonId, port: number) {
    this.cancellation.signal.throwIfAborted();
    const current = this.options.network.snapshot().daemon;
    if (!this.source || current?.daemonId !== daemonId
      || this.options.network.connection().localPort !== port) {
      throw new Error("Attached daemon changed during presentation import.");
    }
  }

  private assertActive(daemonId: DaemonId) {
    const port = this.options.network.connection().localPort;
    if (!port || this.activeKey !== `${daemonId}:${port}`) {
      throw new Error("Attached daemon changed during presentation import.");
    }
    this.assertCurrent(daemonId, port);
  }

  private openSource(port: number): ImportSourceConnection {
    const socket = new WorkbenchSocketClient({
      resolveUrl: async () => `ws://127.0.0.1:${port}`,
    });
    const request = async <TResponse>(method: string, params: object): Promise<TResponse> => {
      this.cancellation.signal.throwIfAborted();
      const response = await socket.sendRequest<TResponse>({ method, params });
      this.cancellation.signal.throwIfAborted();
      if (isWorkbenchRpcFailure(response)) {
        const data = response.error.data && typeof response.error.data === "object" && !Array.isArray(response.error.data)
          ? response.error.data : null;
        throw new WorkbenchDaemonRequestError(response.error.message, response.error.code, data);
      }
      return response.result;
    };
    return { daemon: new WorkbenchDaemonClient({ request }), request, close: () => socket.dispose() };
  }

  private async importDrafts(
    daemonId: DaemonId, projectId: ProjectId, draftIds: DraftId[], daemon: WorkbenchDaemonClient,
    snapshot: PresentationSnapshot,
  ) {
    const logicalProjectId = snapshot.locations.find(location =>
      location.target.daemonId === daemonId && location.target.projectId === projectId)?.logicalProjectId;
    if (!logicalProjectId) throw new Error("Imported draft location is unavailable.");
    let cursor: string | null = null;
    let imported = 0;
    let failed = 0;
    const batch: PresentationMutation[] = [];
    const flush = () => {
      if (!batch.length) return;
      this.options.presentation.mutateImportBatch(batch);
      batch.length = 0;
    };
    do {
      const page = await daemon.presentationExport.project({ projectId, draftIds, cursor, limit: 10 });
      this.assertActive(daemonId);
      for (const source of page.drafts) {
        this.assertActive(daemonId);
        if (source.attachments.some(attachment => attachment.kind !== "inline")) {
          failed++;
          this.warn("draft image", new Error("Legacy draft has an unsupported external image URL."));
          continue;
        }
        const id = snapshot.sourceMappings.find(item => item.daemonId === daemonId
          && item.sourceKind === "draft" && item.sourceId === source.draftId)?.targetId ?? crypto.randomUUID();
        const importDraft: Extract<PresentationMutation, { kind: "importDraft" }> = {
          kind: "importDraft", daemonId, sourceId: source.draftId, sourceRevision: page.sourceRevision,
          pinned: source.pinned, snoozed: source.snoozed,
          draft: {
            id, logicalProjectId, target: { daemonId, projectId }, prompt: source.prompt,
            selection: source.profileId
              ? { kind: "profile", profileId: source.profileId, settings: source.composerSettings }
              : { kind: "custom", settings: source.composerSettings },
            updatedAt: source.updatedAt,
          },
          attachments: source.attachments.flatMap(attachment => attachment.kind === "inline"
            ? [{ id: attachment.id, mediaType: attachment.mediaType, contentHash: attachment.contentHash }]
            : []),
        };
        const finish: Extract<PresentationMutation, { kind: "finishImportDraft" }> = {
          kind: "finishImportDraft", daemonId, sourceId: source.draftId, draftId: id,
          sourceRevision: page.sourceRevision,
        };
        if (!source.attachments.length) {
          batch.push(importDraft, finish);
          if (batch.length === 20) flush();
          imported++;
          continue;
        }
        flush();
        try {
          this.options.presentation.mutate(importDraft);
          for (const attachment of source.attachments) {
            if (attachment.kind !== "inline") continue;
            if (attachment.byteLength > ATTACHMENT_CHUNK_BYTES * MAX_ATTACHMENT_CHUNKS) {
              throw new Error("Legacy image exceeds the app attachment limit.");
            }
            const hash = createHash("sha256");
            let pending = Buffer.alloc(0);
            let length = 0;
            let chunkIndex = 0;
            let offset = 0;
            do {
              const part = await daemon.presentationExport.attachment({
                projectId, draftId: source.draftId, attachmentId: attachment.id, offset,
              });
              this.assertActive(daemonId);
              if (part.byteLength !== attachment.byteLength || part.contentHash !== attachment.contentHash
                || part.mediaType !== attachment.mediaType) throw new Error("Legacy image changed during transfer.");
              const bytes = Buffer.from(part.bytes, "base64");
              length += bytes.length;
              if (length > attachment.byteLength) throw new Error("Legacy image content did not match its source.");
              hash.update(bytes);
              pending = Buffer.concat([pending, bytes]);
              if (pending.length >= ATTACHMENT_CHUNK_BYTES) {
                this.options.presentation.putAttachmentChunk(id, attachment.id, chunkIndex++,
                  pending.subarray(0, ATTACHMENT_CHUNK_BYTES));
                pending = pending.subarray(ATTACHMENT_CHUNK_BYTES);
              }
              if (part.nextOffset !== null && part.nextOffset <= offset) throw new Error("Legacy image transfer did not advance.");
              offset = part.nextOffset ?? -1;
            } while (offset >= 0);
            if (pending.length) this.options.presentation.putAttachmentChunk(id, attachment.id, chunkIndex++, pending);
            if (length !== attachment.byteLength || hash.digest("hex") !== attachment.contentHash) {
              throw new Error("Legacy image content did not match its source.");
            }
            if (!chunkIndex || chunkIndex > MAX_ATTACHMENT_CHUNKS) throw new Error("Legacy image exceeds the app attachment limit.");
            this.options.presentation.completeAttachment(id, attachment.id, chunkIndex,
              attachment.mediaType, attachment.contentHash);
          }
          this.options.presentation.mutate(finish);
          imported++;
        } catch (error) {
          this.assertActive(daemonId);
          failed++;
          this.warn("draft image", error);
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    flush();
    return { imported, failed };
  }

  private async importLayout(
    daemonId: DaemonId, source: Exclude<Source, { kind: "draft" }>, daemon: WorkbenchDaemonClient,
    snapshot: PresentationSnapshot, sidebars: WorkbenchProjectThreadSidebars,
  ) {
    const scope = source.kind === "projectLayout"
      ? { scope: "project" as const, projectId: source.projectId }
      : { scope: source.kind === "homeLayout" ? "home" as const : "pinned" as const };
    const chunks: Buffer[] = [];
    let offset = 0;
    let revision: number | null = null;
    let totalBytes: number | null = null;
    do {
      const part = await daemon.presentationExport.layout({ ...scope, sourceRevision: revision, offset });
      this.assertActive(daemonId);
      if (revision !== null && revision !== part.sourceRevision) throw new Error("Legacy layout changed during transfer.");
      if (totalBytes !== null && totalBytes !== part.totalBytes) throw new Error("Legacy layout length changed during transfer.");
      revision = part.sourceRevision;
      totalBytes = part.totalBytes;
      chunks.push(Buffer.from(part.bytes, "base64"));
      if (part.nextOffset !== null && part.nextOffset <= offset) throw new Error("Legacy layout transfer did not advance.");
      offset = part.nextOffset ?? -1;
    } while (offset >= 0);
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== totalBytes) throw new Error("Legacy layout transfer is incomplete.");
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    const mappings = snapshot.sourceMappings;
    let mutation: Extract<PresentationMutation, { kind: "importLayout" }>;
    if (source.kind === "projectLayout") {
      const logicalProjectId = snapshot.locations.find(location =>
        location.target.daemonId === daemonId && location.target.projectId === source.projectId)?.logicalProjectId;
      const sidebar = sidebars.projects.find(item => item.projectId === source.projectId);
      if (!logicalProjectId || !sidebar) throw new Error("Legacy project layout source is unavailable.");
      const layout = WorkbenchThreadDisplayOrderSchema.parse(
        (value as { displayOrder?: unknown }).displayOrder);
      mutation = projectLegacyPresentationLayout({
        daemonId, projectId: source.projectId, logicalProjectId, sidebar, displayOrder: layout,
        sourceRevision: revision ?? 0, mappings,
      });
    } else if (source.kind === "homeLayout") {
      mutation = homeLegacyPresentationLayout({
        daemonId, sidebars, displayOrder: WorkbenchHomeThreadDisplayOrderSchema.parse(value),
        sourceRevision: revision ?? 0, mappings,
      });
    } else {
      mutation = pinnedLegacyPresentationLayout({
        daemonId, sidebars, displayOrder: WorkbenchThreadDisplayOrderSchema.parse(value),
        sourceRevision: revision ?? 0, mappings,
      });
    }
    this.assertActive(daemonId);
    this.options.presentation.mutateImportBatch([mutation]);
  }

  private warn(kind: string, error: unknown) {
    const reason = error instanceof WorkbenchDaemonRequestError
      ? `daemon rejected request (${error.code})`
      : error instanceof Error && error.name === "ZodError"
        ? "source schema was invalid"
        : error instanceof Error && expectedImportFailures.has(error.message)
          ? error.message
          : "unexpected failure";
    this.options.logger.error("app", `presentation import ${kind} failed: ${reason}`);
  }

  private publishStatus(status: WorkbenchPresentationImportStatus) {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }
}
