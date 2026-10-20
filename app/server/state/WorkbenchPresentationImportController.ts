/*
 * Default export:
 * - WorkbenchPresentationImportController: import attached-daemon legacy drafts once per app connection.
 */
import { createHash } from "node:crypto";
import WorkbenchDaemonClient, { WorkbenchDaemonRequestError } from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import type {
  PresentationMutation, PresentationSnapshot, WorkbenchPresentationImportStatus,
} from "workbench-shared/state/workbench-presentation-state";
import { DaemonIdSchema, type DaemonId, type DraftId, type ProjectId } from "workbench-shared/workbench/identity";
import type WorkbenchProcessLogger from "workbench-shared/process/WorkbenchProcessLogger";
import type WorkbenchDaemonSources from "../workspace/WorkbenchDaemonSources";
import type WorkbenchDaemonSource from "../workspace/WorkbenchDaemonSource";
import type { DaemonWorkspaceQuery, DaemonWorkspaceObservation } from "workbench-shared/workbench/workspace/workspace-observation";
import type WorkbenchPresentationController from "./WorkbenchPresentationController";

const ATTACHMENT_CHUNK_BYTES = 1024 * 1024;
const MAX_ATTACHMENT_CHUNKS = 1024;
const expectedImportFailures = new Set([
  "Imported draft location is unavailable.",
  "Legacy draft has an unsupported external image URL.",
  "Legacy image changed during transfer.",
  "Legacy image transfer did not advance.",
  "Legacy image content did not match its source.",
  "Legacy image exceeds the app attachment limit.",
]);
type Owner = Pick<WorkbenchPresentationController,
  "read" | "readImportReceipts" | "mutate" | "mutateImportBatch" | "putAttachmentChunk" | "completeAttachment">;
interface ImportSourceConnection {
  daemon: WorkbenchDaemonClient;
  read(query: DaemonWorkspaceQuery): Promise<DaemonWorkspaceObservation>;
  close(): void;
}

export default class WorkbenchPresentationImportController {
  private readonly cancellation = new AbortController();
  private unsubscribe: (() => void) | null = null;
  private running: Promise<void> | null = null;
  private requested: { daemonId: DaemonId; generation: number; hostname: string; source: WorkbenchDaemonSource } | null = null;
  private lastReadyKey: string | null = null;
  private activeKey: string | null = null;
  private source: ImportSourceConnection | null = null;
  private status: WorkbenchPresentationImportStatus = {
    phase: "idle", scanned: 0, imported: 0, failed: 0,
  };
  private readonly listeners = new Set<(status: WorkbenchPresentationImportStatus) => void>();

  constructor(private readonly options: {
    sources: WorkbenchDaemonSources;
    presentation: Owner;
    logger: WorkbenchProcessLogger;
    canAdmit?(): boolean;
  }) {}

  start() {
    this.unsubscribe = this.options.sources.subscribe(() => this.observe());
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

  async drain() {
    await this.running;
  }

  resumeAdmission() {
    if (this.cancellation.signal.aborted) return;
    this.observe();
    if (this.requested && !this.running) this.drive();
  }

  private observe() {
    if (this.cancellation.signal.aborted || this.options.canAdmit?.() === false) return;
    const source = this.options.sources.attached;
    const daemon = source?.getSnapshot();
    if (!source || !daemon || !source.available) {
      this.retireSource();
      return;
    }
    const key = `${daemon.daemonId}:${daemon.generation}`;
    if (this.activeKey && this.activeKey !== key) this.retireSource();
    if (this.lastReadyKey === key) return;
    this.lastReadyKey = key;
    this.requested = { daemonId: DaemonIdSchema.parse(daemon.daemonId), generation: daemon.generation, hostname: daemon.hostname, source };
    if (this.running) return;
    this.drive();
  }

  private drive() {
    const operation = (async () => {
      while (this.requested && !this.cancellation.signal.aborted && this.options.canAdmit?.() !== false) {
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
      if (this.requested && !this.cancellation.signal.aborted && this.options.canAdmit?.() !== false) this.drive();
    });
  }

  private async reconcile(target: { daemonId: DaemonId; generation: number; hostname: string; source: WorkbenchDaemonSource }) {
    const startedAt = Date.now();
    this.publishStatus({ phase: "running", scanned: 0, imported: 0, failed: 0 });
    const source = this.openSource(target.source);
    this.source = source;
    this.activeKey = `${target.daemonId}:${target.generation}`;
    const { daemon } = source;
    let scanned = 0;
    let imported = 0;
    let skipped = 0;
    let failed = 0;
    this.options.logger.line("app", "presentation import started");
    try {
      const catalogue = await source.read({ kind: "catalogue" });
      if (catalogue.kind !== "catalogue" || !catalogue.locations) throw new Error("Attached project catalogue is unavailable.");
      const locations = catalogue.locations;
      this.assertCurrent(target.daemonId, target.generation);
      this.options.presentation.mutate({
        kind: "registerLocations", daemonId: target.daemonId, hostname: target.hostname, catalog: locations,
      });
      const snapshot = this.options.presentation.read();
      let cursor: string | null = null;
      do {
        const page = await daemon.presentationExport.manifest({ cursor, limit: 200 });
        this.assertCurrent(target.daemonId, target.generation);
        scanned += page.sources.length;
        const present = this.options.presentation.readImportReceipts(target.daemonId,
          page.sources.map(source => ({ kind: "draft" as const, sourceId: source.sourceId }))).present;
        const accepted = new Set(present.map(source => source.sourceId));
        const missing = page.sources.filter(source => !accepted.has(source.sourceId));
        skipped += page.sources.length - missing.length;
        for (let index = 0; index < missing.length;) {
          this.cancellation.signal.throwIfAborted();
          const source = missing[index]!;
          const draftIds: DraftId[] = [];
          while (index < missing.length && draftIds.length < 10) {
            const candidate = missing[index];
            if (candidate?.projectId !== source.projectId) break;
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
        }
        this.publishStatus({ phase: "running", scanned, imported, failed });
        cursor = page.nextCursor;
      } while (cursor !== null);
      this.publishStatus({ phase: failed ? "partial" : "complete", scanned, imported, failed });
      this.options.logger.line("app", `presentation import ${failed ? "partial" : "complete"}: ${imported} added, ${skipped} present, ${failed} failed of ${scanned} in ${Date.now() - startedAt}ms`);
    } finally {
      if (this.source === source) this.retireSource();
      this.activeKey = null;
    }
  }

  private retireSource() {
    const source = this.source;
    this.source = null;
    source?.close();
  }

  private assertCurrent(daemonId: DaemonId, generation: number) {
    this.cancellation.signal.throwIfAborted();
    const current = this.options.sources.attached?.getSnapshot();
    if (!this.source || current?.daemonId !== daemonId || current.generation !== generation
      || current.connection !== "current") {
      throw new Error("Attached daemon changed during presentation import.");
    }
  }

  private assertActive(daemonId: DaemonId) {
    const generation = this.options.sources.attached?.getSnapshot().generation;
    if (generation === undefined || this.activeKey !== `${daemonId}:${generation}`) {
      throw new Error("Attached daemon changed during presentation import.");
    }
    this.assertCurrent(daemonId, generation);
  }

  private openSource(source: WorkbenchDaemonSource): ImportSourceConnection {
    const cancellation = new AbortController();
    const release = source.retain();
    return {
      daemon: new WorkbenchDaemonClient({
        request: (method, params) => source.request(method, params, {}, { signal: cancellation.signal }),
      }),
      read: query => new Promise((resolve, reject) => {
        let observation: ReturnType<WorkbenchDaemonSource["observe"]> | null = null;
        const finish = () => {
          observation?.release();
          cancellation.signal.removeEventListener("abort", abort);
        };
        const abort = () => { finish(); reject(new Error("Presentation import source changed.")); };
        const changed = () => {
          if (!observation) return;
          const fact = observation.getSnapshot();
          if (fact.phase === "current" && fact.value) { finish(); resolve(fact.value); }
          else if (fact.phase === "failed" || fact.phase === "unavailable" || fact.failure) {
            finish();
            reject(new Error(fact.failure ?? "Presentation import source is unavailable."));
          }
        };
        cancellation.signal.addEventListener("abort", abort, { once: true });
        observation = source.observe(query, changed);
        if (cancellation.signal.aborted) abort();
        else changed();
      }),
      close: () => { cancellation.abort(); release(); },
    };
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
