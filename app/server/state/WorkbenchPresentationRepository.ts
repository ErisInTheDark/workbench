/*
 * Exports:
 * - WorkbenchPresentationRepositoryOptions: durable shared-presentation database path.
 * - default WorkbenchPresentationRepository: own relational project, draft, layout and import transactions.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import migrateWorkbenchDatabase from "workbench-shared/database/workbench-database-migration";
import recoverWorkbenchDatabase from "workbench-shared/database/recover-workbench-database";
import { assertSchemaReleaseManifest } from "workbench-shared/database/schema/schema-release-manifest";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";
import { WorkbenchComposerProfileSelectionSchema } from "workbench-shared/workbench/thread/thread-state";
import {
  PresentationDraftInputSchema, PresentationMutationSchema, PresentationSnapshotSchema,
  type PresentationMutation, type PresentationSnapshot,
} from "workbench-shared/state/workbench-presentation-state";
import { presentationSchema, type PresentationRows } from "workbench-shared/state/workbench-presentation-schema";
import releases from "workbench-shared/state/workbench-presentation-releases";
import resolveWorkbenchDataRoot from "workbench-shared/workbench-data-root";

export interface WorkbenchPresentationRepositoryOptions {
  databasePath?: string;
  onDiagnostic?(message: string): void;
}

type DraftRow = PresentationRows["drafts"];
type LocationRow = PresentationRows["locations"];
type ReceiptRow = PresentationRows["receipts"];

const fallbackSelection = WorkbenchComposerProfileSelectionSchema.parse({
  kind: "custom",
  settings: {
    agentPath: null, agentSource: null, harness: "codex", model: "",
    reasoningEffort: null, serviceTier: null,
  },
});

export default class WorkbenchPresentationRepository {
  readonly databasePath: string;
  private database: Database.Database | null = null;
  private opening: Promise<void> | null = null;

  constructor(private readonly options: WorkbenchPresentationRepositoryOptions = {}) {
    this.databasePath = path.resolve(options.databasePath
      ?? path.join(resolveWorkbenchDataRoot(), "app", "presentation-state.sqlite3"));
  }

  async start(beforeMigration?: (backupPath: string) => void) {
    if (this.database || this.opening) throw new Error("Presentation database has already started.");
    this.opening = this.open(beforeMigration);
    try { await this.opening; }
    finally { this.opening = null; }
  }

  private async open(beforeMigration?: (backupPath: string) => void) {
    assertSchemaReleaseManifest(presentationSchema, releases, "presentation");
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
    await recoverWorkbenchDatabase(this.databasePath, presentationSchema, beforeMigration);
    const database = new Database(this.databasePath);
    try {
      database.pragma("foreign_keys = ON");
      await migrateWorkbenchDatabase(database, presentationSchema, { beforeMigration });
      database.prepare("INSERT OR IGNORE INTO presentation_metadata(id, revision) VALUES ('singleton', 0)").run();
      this.database = database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  async close() {
    await this.opening;
    this.database?.close();
    this.database = null;
  }

  async resume(backupPath?: string) {
    if (this.database) return;
    if (backupPath) {
      const { restoreWorkbenchDatabaseBackup } = await import("workbench-shared/database/workbench-database-migration");
      await restoreWorkbenchDatabaseBackup(backupPath, this.databasePath);
    }
    await this.start();
  }

  read(): PresentationSnapshot {
    const db = this.requireDatabase();
    const metadata = db.prepare("SELECT revision FROM presentation_metadata WHERE id = 'singleton'")
      .get() as PresentationRows["metadata"];
    const daemons = db.prepare("SELECT * FROM presentation_daemons ORDER BY id")
      .all() as PresentationRows["daemons"][];
    const projects = db.prepare("SELECT * FROM presentation_projects ORDER BY label, id")
      .all() as PresentationRows["projects"][];
    const locations = db.prepare("SELECT * FROM presentation_locations ORDER BY daemon_id, project_id")
      .all() as LocationRow[];
    const defaults = db.prepare("SELECT * FROM presentation_new_thread_defaults ORDER BY daemon_id, project_id")
      .all() as PresentationRows["defaults"][];
    const drafts = db.prepare("SELECT * FROM presentation_drafts WHERE phase IN ('unsent', 'submitting') ORDER BY updated_at DESC, id")
      .all() as DraftRow[];
    const attachments = db.prepare("SELECT draft_id, id, media_type, content_hash FROM presentation_draft_attachments ORDER BY draft_id, id")
      .all() as Array<Pick<PresentationRows["attachments"], "draft_id" | "id" | "media_type" | "content_hash">>;
    const folders = db.prepare("SELECT * FROM presentation_folders ORDER BY scope, position, id")
      .all() as PresentationRows["folders"][];
    const members = db.prepare("SELECT * FROM presentation_layout_members ORDER BY scope, position, id")
      .all() as PresentationRows["members"][];
    const divergences = db.prepare("SELECT * FROM presentation_source_divergences ORDER BY daemon_id, source_kind, source_id")
      .all() as PresentationRows["divergences"][];
    const sourceMappings = db.prepare("SELECT * FROM presentation_source_mappings ORDER BY daemon_id, source_kind, source_id")
      .all() as PresentationRows["mappings"][];
    return PresentationSnapshotSchema.parse({
      revision: metadata.revision,
      daemons: daemons.map(row => ({ id: row.id, hostname: row.hostname })),
      projects: projects.map(row => ({ id: row.id, matchKey: row.match_key, label: row.label })),
      locations: locations.map(row => ({
        target: { daemonId: row.daemon_id, projectId: row.project_id },
        logicalProjectId: row.logical_project_id, identityKey: row.identity_key,
        name: row.name, rootPath: row.root_path,
      })),
      defaults: defaults.map(row => ({
        target: { daemonId: row.daemon_id, projectId: row.project_id },
        selection: this.selection(row.selection_json), revision: row.revision,
      })),
      drafts: drafts.map(row => ({
        id: row.id, logicalProjectId: row.logical_project_id,
        target: { daemonId: row.daemon_id, projectId: row.project_id },
        prompt: row.prompt, selection: this.selection(row.selection_json),
        pinned: Boolean(row.pinned), snoozed: Boolean(row.snoozed),
        updatedAt: row.updated_at, revision: row.revision, phase: row.phase,
        launchId: row.launch_id, acceptedThreadId: row.accepted_thread_id,
        attachments: attachments.filter(item => item.draft_id === row.id).map(item => ({
          id: item.id, mediaType: item.media_type, contentHash: item.content_hash,
        })),
      })),
      folders: folders.map(row => ({
        id: row.id, scope: row.scope, logicalProjectId: row.logical_project_id,
        title: row.title, position: row.position,
      })),
      members: members.map(row => ({
        id: row.id, scope: row.scope, logicalProjectId: row.logical_project_id,
        folderId: row.folder_id, kind: row.kind, draftId: row.draft_id,
        thread: row.kind === "thread" && row.daemon_id && row.project_id && row.thread_id
          ? { location: { daemonId: row.daemon_id, projectId: row.project_id }, threadId: row.thread_id } : null,
        position: row.position,
      })),
      divergences: divergences.map(row => ({
        daemonId: row.daemon_id, sourceKind: row.source_kind, sourceId: row.source_id,
        importedRevision: row.imported_revision, latestRevision: row.latest_revision,
      })),
      sourceMappings: sourceMappings.map(row => ({
        daemonId: row.daemon_id, sourceKind: row.source_kind,
        sourceId: row.source_id, targetId: row.target_id, sourceRevision: row.source_revision,
      })),
    });
  }

  mutate(value: PresentationMutation) {
    const mutation = PresentationMutationSchema.parse(value);
    const db = this.requireDatabase();
    db.transaction(() => {
      switch (mutation.kind) {
        case "registerLocations": this.registerLocations(mutation); break;
        case "putDraft": this.putDraft(mutation); break;
        case "deleteDraft": this.deleteDraft(mutation); break;
        case "setDraftPriority": this.setDraftPriority(mutation); break;
        case "deleteAttachment": this.deleteAttachment(mutation); break;
        case "reserveLaunch": this.reserveLaunch(mutation); break;
        case "completeLaunch": this.completeLaunch(mutation); break;
        case "saveLayout": this.saveLayout(mutation); break;
        case "saveLayouts": this.saveLayouts(mutation); break;
        case "importDraft": this.importDraft(mutation); break;
        case "finishImportDraft": this.finishImportDraft(mutation); break;
        case "importLayout": this.importLayout(mutation); break;
      }
    })();
    return this.read();
  }

  readAttachment(draftId: string, id: string) {
    const db = this.requireDatabase();
    const meta = db.prepare(
      "SELECT media_type, content_length FROM presentation_draft_attachments WHERE draft_id = ? AND id = ?",
    ).get(draftId, id) as { media_type: string; content_length: number } | undefined;
    if (!meta) return undefined;
    return {
      ...meta,
      chunks: () => db.prepare(`
        SELECT content FROM presentation_attachment_chunks
        WHERE draft_id = ? AND attachment_id = ? ORDER BY chunk_index
      `).iterate(draftId, id) as Iterable<{ content: Buffer }>,
    };
  }

  putAttachmentChunk(draftId: string, id: string, index: number, bytes: Buffer) {
    if (!Number.isSafeInteger(index) || index < 0 || !bytes.length || bytes.length > 1024 * 1024) {
      throw new Error("Attachment chunk is invalid.");
    }
    const db = this.requireDatabase();
    db.transaction(() => {
      const draft = this.draft(draftId);
      if (!draft || (draft.phase !== "unsent" && draft.phase !== "importing")) {
        throw new Error("Attachment owner is unavailable.");
      }
      if (db.prepare("SELECT 1 FROM presentation_draft_attachments WHERE draft_id = ? AND id = ?")
        .get(draftId, id)) throw new Error("Attachment is already complete.");
      db.prepare(`
        INSERT INTO presentation_attachment_chunks(draft_id, attachment_id, chunk_index, content)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(draft_id, attachment_id, chunk_index) DO UPDATE SET content = excluded.content
      `).run(draftId, id, index, bytes);
    })();
  }

  completeAttachment(draftId: string, id: string, count: number, mediaType: string, expectedHash: string) {
    if (!Number.isSafeInteger(count) || count < 1 || count > 1024
      || !/^image\/(?:png|jpeg|webp|gif)$/u.test(mediaType)
      || !/^[a-f0-9]{64}$/u.test(expectedHash)) {
      throw new Error("Attachment completion is invalid.");
    }
    const db = this.requireDatabase();
    db.transaction(() => {
      const draft = this.draft(draftId);
      if (!draft || (draft.phase !== "unsent" && draft.phase !== "importing")) {
        throw new Error("Attachment owner is unavailable.");
      }
      const chunks = db.prepare(`
        SELECT chunk_index, content FROM presentation_attachment_chunks
        WHERE draft_id = ? AND attachment_id = ? ORDER BY chunk_index
      `).iterate(draftId, id) as Iterable<{ chunk_index: number; content: Buffer }>;
      const hash = createHash("sha256");
      let length = 0;
      let index = 0;
      for (const part of chunks) {
        if (part.chunk_index !== index) throw new Error("Attachment transfer is incomplete.");
        hash.update(part.content);
        length += part.content.length;
        index += 1;
      }
      if (index !== count) throw new Error("Attachment transfer is incomplete.");
      if (hash.digest("hex") !== expectedHash) {
        throw new Error("Attachment content does not match its expected digest.");
      }
      db.prepare(`
        INSERT INTO presentation_draft_attachments(draft_id, id, media_type, content_length, content_hash)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(draft_id, id) DO UPDATE SET
          media_type = excluded.media_type, content_length = excluded.content_length,
          content_hash = excluded.content_hash
      `).run(draftId, id, mediaType, length, expectedHash);
      db.prepare("UPDATE presentation_drafts SET revision = ? WHERE id = ?")
        .run(this.nextRevision(), draftId);
    })();
    return this.read();
  }

  private requireDatabase() {
    if (!this.database) throw new Error("Presentation database is not ready.");
    return this.database;
  }

  private nextRevision() {
    const db = this.requireDatabase();
    db.prepare("UPDATE presentation_metadata SET revision = revision + 1 WHERE id = 'singleton'").run();
    return (db.prepare("SELECT revision FROM presentation_metadata WHERE id = 'singleton'")
      .pluck().get() as number);
  }

  private draft(id: string) {
    return this.requireDatabase().prepare("SELECT * FROM presentation_drafts WHERE id = ?").get(id) as DraftRow | undefined;
  }

  private selection(json: string) {
    const conformed = conformToZodSchema(WorkbenchComposerProfileSelectionSchema, JSON.parse(json), fallbackSelection);
    if (conformed.repairedPaths.length) {
      this.options.onDiagnostic?.(`Saved draft selection needs review: repairedPaths=${conformed.repairedPaths.length}`);
    }
    return conformed.data;
  }

  private registerLocations(input: Extract<PresentationMutation, { kind: "registerLocations" }>) {
    const db = this.requireDatabase();
    const now = Date.now();
    const priorDaemon = db.prepare("SELECT hostname FROM presentation_daemons WHERE id = ?")
      .get(input.daemonId) as { hostname: string } | undefined;
    let changed = !priorDaemon || priorDaemon.hostname !== input.hostname;
    let bumped = false;
    db.prepare(`
      INSERT INTO presentation_daemons(id, hostname, last_seen_at) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET hostname = excluded.hostname, last_seen_at = excluded.last_seen_at
    `).run(input.daemonId, input.hostname, now);
    for (const location of input.catalog.data) {
      const key = location.identityKey;
      const existing = db.prepare("SELECT id FROM presentation_projects WHERE match_key = ?")
        .get(key) as { id: string } | undefined;
      const priorLocation = db.prepare(`
        SELECT * FROM presentation_locations WHERE daemon_id = ? AND project_id = ?
      `).get(input.daemonId, location.project.id) as LocationRow | undefined;
      const logicalId = existing?.id ?? randomUUID();
      const label = location.identityKey.startsWith("remote://") && !location.identityKey.startsWith("remote://file:")
        ? location.identityKey.slice("remote://".length) : location.project.rootPath;
      if (!existing) db.prepare("INSERT INTO presentation_projects(id, match_key, label) VALUES (?, ?, ?)")
        .run(logicalId, key, label);
      changed ||= !priorLocation || priorLocation.logical_project_id !== logicalId
        || priorLocation.identity_key !== location.identityKey
        || priorLocation.name !== location.project.name
        || priorLocation.root_path !== location.project.rootPath;
      db.prepare(`
        INSERT INTO presentation_locations
          (daemon_id, project_id, logical_project_id, identity_key, name, root_path, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(daemon_id, project_id) DO UPDATE SET
          logical_project_id = excluded.logical_project_id, identity_key = excluded.identity_key,
          name = excluded.name, root_path = excluded.root_path, observed_at = excluded.observed_at
      `).run(input.daemonId, location.project.id, logicalId, location.identityKey,
        location.project.name, location.project.rootPath, now);
      const displaced = db.prepare(`
        SELECT count(*) FROM presentation_drafts
        WHERE daemon_id = ? AND project_id = ? AND logical_project_id <> ?
          AND phase IN ('unsent', 'importing')
      `).pluck().get(input.daemonId, location.project.id, logicalId) as number;
      if (displaced) changed = true;
      const revision = displaced ? this.nextRevision() : 0;
      bumped ||= displaced > 0;
      db.prepare(`
        UPDATE presentation_drafts SET logical_project_id = ?, revision = ?
        WHERE daemon_id = ? AND project_id = ? AND logical_project_id <> ? AND phase IN ('unsent', 'importing')
      `).run(logicalId, revision,
        input.daemonId, location.project.id, logicalId);
    }
    if (changed && !bumped) this.nextRevision();
  }

  private requireTarget(target: { daemonId: string; projectId: string }, logicalProjectId: string) {
    const row = this.requireDatabase().prepare(`
      SELECT * FROM presentation_locations WHERE daemon_id = ? AND project_id = ?
    `).get(target.daemonId, target.projectId) as LocationRow | undefined;
    if (!row || row.logical_project_id !== logicalProjectId) {
      throw new Error("Draft target is not a location of the selected project.");
    }
    return row;
  }

  private putDraft(input: Extract<PresentationMutation, { kind: "putDraft" }>) {
    const db = this.requireDatabase();
    const draft = PresentationDraftInputSchema.parse(input.draft);
    this.requireTarget(draft.target, draft.logicalProjectId);
    const previous = this.draft(draft.id);
    if (input.expectedRevision === null ? Boolean(previous) : previous?.revision !== input.expectedRevision) {
      throw new Error("Draft changed in another browser.");
    }
    if (previous && previous.phase !== "unsent") throw new Error("Draft is already submitting or closed.");
    const selectionJson = JSON.stringify(draft.selection);
    if (previous && previous.logical_project_id === draft.logicalProjectId
      && previous.daemon_id === draft.target.daemonId && previous.project_id === draft.target.projectId
      && previous.prompt === draft.prompt && areDeeplyEqual(this.selection(previous.selection_json), draft.selection)) return;
    const revision = this.nextRevision();
    db.prepare(`
      INSERT INTO presentation_drafts
        (id, logical_project_id, daemon_id, project_id, prompt, selection_json, phase,
          launch_id, accepted_thread_id, revision, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'unsent', NULL, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        logical_project_id = excluded.logical_project_id, daemon_id = excluded.daemon_id,
        project_id = excluded.project_id, prompt = excluded.prompt,
        selection_json = excluded.selection_json, revision = excluded.revision,
        updated_at = excluded.updated_at
    `).run(draft.id, draft.logicalProjectId, draft.target.daemonId, draft.target.projectId,
      draft.prompt, selectionJson, revision, draft.updatedAt);
    if (!previous || previous.daemon_id === draft.target.daemonId
      && previous.project_id === draft.target.projectId
      && !areDeeplyEqual(this.selection(previous.selection_json), draft.selection)) {
      db.prepare(`
        INSERT INTO presentation_new_thread_defaults(daemon_id, project_id, selection_json, revision)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(daemon_id, project_id) DO UPDATE SET
          selection_json = excluded.selection_json, revision = excluded.revision
      `).run(draft.target.daemonId, draft.target.projectId, selectionJson, revision);
    }
  }

  private setDraftPriority(input: Extract<PresentationMutation, { kind: "setDraftPriority" }>) {
    const draft = this.draft(input.draftId);
    if (!draft || draft.phase !== "unsent" || draft.revision !== input.expectedRevision) {
      throw new Error("Draft changed before its priority could be saved.");
    }
    if (Boolean(draft.pinned) === input.pinned && Boolean(draft.snoozed) === input.snoozed) return;
    this.requireDatabase().prepare(`
      UPDATE presentation_drafts SET pinned = ?, snoozed = ?, revision = ? WHERE id = ?
    `).run(input.pinned ? 1 : 0, input.snoozed ? 1 : 0, this.nextRevision(), input.draftId);
  }

  private deleteDraft(input: Extract<PresentationMutation, { kind: "deleteDraft" }>) {
    const db = this.requireDatabase();
    const draft = this.draft(input.draftId);
    if (!draft || draft.revision !== input.expectedRevision) throw new Error("Draft changed in another browser.");
    if (draft.phase === "deleted") return;
    const revision = this.nextRevision();
    db.prepare("UPDATE presentation_drafts SET phase = 'deleted', revision = ? WHERE id = ?")
      .run(revision, input.draftId);
    db.prepare("DELETE FROM presentation_layout_members WHERE draft_id = ?").run(input.draftId);
    if (!draft.launch_id) {
      db.prepare("DELETE FROM presentation_draft_attachments WHERE draft_id = ?").run(input.draftId);
      db.prepare("DELETE FROM presentation_attachment_chunks WHERE draft_id = ?").run(input.draftId);
    }
  }

  private deleteAttachment(input: Extract<PresentationMutation, { kind: "deleteAttachment" }>) {
    const db = this.requireDatabase();
    const draft = this.draft(input.draftId);
    if (!draft || draft.phase !== "unsent" || draft.revision !== input.expectedRevision) {
      throw new Error("Draft changed before attachment removal.");
    }
    const removed = db.prepare("DELETE FROM presentation_draft_attachments WHERE draft_id = ? AND id = ?")
      .run(input.draftId, input.attachmentId).changes;
    db.prepare("DELETE FROM presentation_attachment_chunks WHERE draft_id = ? AND attachment_id = ?")
      .run(input.draftId, input.attachmentId);
    if (removed) db.prepare("UPDATE presentation_drafts SET revision = ? WHERE id = ?")
      .run(this.nextRevision(), input.draftId);
  }

  private reserveLaunch(input: Extract<PresentationMutation, { kind: "reserveLaunch" }>) {
    const draft = this.draft(input.draftId);
    if (!draft || draft.phase !== "unsent" || draft.revision !== input.expectedRevision) {
      throw new Error("Draft is no longer ready to launch.");
    }
    this.requireDatabase().prepare(`
      UPDATE presentation_drafts SET phase = 'submitting', launch_id = ?, revision = ? WHERE id = ?
    `).run(input.launchId, this.nextRevision(), input.draftId);
  }

  private completeLaunch(input: Extract<PresentationMutation, { kind: "completeLaunch" }>) {
    const db = this.requireDatabase();
    const draft = this.draft(input.draftId);
    if (!draft || draft.launch_id !== input.launchId) throw new Error("Launch does not own this draft.");
    if (draft.accepted_thread_id) {
      if (draft.accepted_thread_id !== input.threadId) throw new Error("Launch accepted a different thread.");
      return;
    }
    const revision = this.nextRevision();
    db.prepare(`
      UPDATE presentation_drafts SET phase = CASE WHEN phase = 'deleted' THEN 'deleted' ELSE 'accepted' END,
        accepted_thread_id = ?, revision = ? WHERE id = ?
    `).run(input.threadId, revision, input.draftId);
    if (draft.phase !== "deleted") db.prepare(`
      UPDATE presentation_layout_members SET kind = 'thread', draft_id = NULL,
        daemon_id = ?, project_id = ?, thread_id = ?, revision = ? WHERE draft_id = ?
    `).run(draft.daemon_id, draft.project_id, input.threadId, revision, input.draftId);
    db.prepare("DELETE FROM presentation_draft_attachments WHERE draft_id = ?").run(input.draftId);
    db.prepare("DELETE FROM presentation_attachment_chunks WHERE draft_id = ?").run(input.draftId);
  }

  private saveLayout(input: Extract<PresentationMutation, { kind: "saveLayout" }>) {
    this.saveLayouts({ kind: "saveLayouts", expectedRevision: input.expectedRevision, layouts: [input] });
  }

  private saveLayouts(input: Extract<PresentationMutation, { kind: "saveLayouts" }>) {
    const db = this.requireDatabase();
    const current = (db.prepare("SELECT revision FROM presentation_metadata WHERE id = 'singleton'")
      .pluck().get() as number);
    if (current !== input.expectedRevision) throw new Error("Layout changed in another browser.");
    const scopes = input.layouts.map(layout => `${layout.scope}:${layout.logicalProjectId ?? ""}`);
    if (new Set(scopes).size !== scopes.length) throw new Error("Layout scope is duplicated.");
    for (const layout of input.layouts) this.replaceLayout(layout);
  }

  private replaceLayout(input: Extract<PresentationMutation, { kind: "saveLayouts" }>["layouts"][number]) {
    const db = this.requireDatabase();
    if ((input.scope === "project") !== (input.logicalProjectId !== null)
      || input.folders.some(folder => folder.scope !== input.scope
      || folder.logicalProjectId !== input.logicalProjectId)
      || input.members.some(member => member.scope !== input.scope
        || member.logicalProjectId !== input.logicalProjectId)) {
      throw new Error("Layout member belongs to another scope.");
    }
    const folderIds = new Set(input.folders.map(folder => folder.id));
    for (const member of input.members) this.validateLayoutMember(member, folderIds);
    const where = "scope = ? AND logical_project_id IS ?";
    db.prepare(`DELETE FROM presentation_layout_members WHERE ${where}`).run(input.scope, input.logicalProjectId);
    db.prepare(`DELETE FROM presentation_folders WHERE ${where}`).run(input.scope, input.logicalProjectId);
    const revision = this.nextRevision();
    const insertFolder = db.prepare(`
      INSERT INTO presentation_folders(id, scope, logical_project_id, title, position, revision)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const folder of input.folders) insertFolder.run(
      folder.id, folder.scope, folder.logicalProjectId, folder.title, folder.position, revision,
    );
    const insertMember = db.prepare(`
      INSERT INTO presentation_layout_members
        (id, scope, logical_project_id, folder_id, kind, draft_id, daemon_id, project_id, thread_id, position, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const member of input.members) insertMember.run(
      member.id, member.scope, member.logicalProjectId, member.folderId, member.kind,
      member.draftId, member.thread?.location.daemonId ?? null,
      member.thread?.location.projectId ?? null, member.thread?.threadId ?? null,
      member.position, revision,
    );
  }

  private importDraft(input: Extract<PresentationMutation, { kind: "importDraft" }>) {
    const db = this.requireDatabase();
    const receipt = this.receipt(input.daemonId, "draft", input.sourceId);
    if (receipt) {
      if (receipt.target_id !== input.draft.id) throw new Error("Import source maps to another draft.");
      if (receipt.source_revision !== input.sourceRevision) this.noteDivergence(
        input.daemonId, "draft", input.sourceId, receipt.source_revision, input.sourceRevision);
      return;
    }
    this.mapSource(input.daemonId, "draft", input.sourceId, input.draft.id, input.sourceRevision);
    const draft = PresentationDraftInputSchema.parse(input.draft);
    this.requireTarget(draft.target, draft.logicalProjectId);
    const existing = this.draft(draft.id);
    if (existing && existing.phase !== "importing") throw new Error("Imported draft ID belongs to another owner.");
    if (existing) {
      if (existing.prompt !== draft.prompt || existing.logical_project_id !== draft.logicalProjectId
        || existing.daemon_id !== draft.target.daemonId || existing.project_id !== draft.target.projectId
        || Boolean(existing.pinned) !== input.pinned || Boolean(existing.snoozed) !== input.snoozed
        || !areDeeplyEqual(this.selection(existing.selection_json), draft.selection)) {
        throw new Error("Imported draft content changed during attachment transfer.");
      }
      return;
    }
    const revision = this.nextRevision();
    db.prepare(`
      INSERT INTO presentation_drafts
        (id, logical_project_id, daemon_id, project_id, prompt, selection_json, phase,
          launch_id, accepted_thread_id, revision, updated_at, pinned, snoozed)
      VALUES (?, ?, ?, ?, ?, ?, 'importing', NULL, NULL, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        prompt = excluded.prompt, selection_json = excluded.selection_json,
        revision = excluded.revision, updated_at = excluded.updated_at
    `).run(draft.id, draft.logicalProjectId, draft.target.daemonId, draft.target.projectId,
      draft.prompt, JSON.stringify(draft.selection), revision, draft.updatedAt,
      input.pinned ? 1 : 0, input.snoozed ? 1 : 0);
    // Expected attachment metadata is retained until every content digest is checked.
    db.prepare("DELETE FROM presentation_import_attachments WHERE daemon_id = ? AND source_id = ?")
      .run(input.daemonId, input.sourceId);
    for (const attachment of input.attachments) {
      db.prepare(`
        INSERT INTO presentation_import_attachments
          (daemon_id, source_id, attachment_id, draft_id, media_type, content_hash, source_revision)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(input.daemonId, input.sourceId, attachment.id, draft.id,
        attachment.mediaType, attachment.contentHash, input.sourceRevision);
    }
  }

  private finishImportDraft(input: Extract<PresentationMutation, { kind: "finishImportDraft" }>) {
    const db = this.requireDatabase();
    const mapping = this.sourceMapping(input.daemonId, "draft", input.sourceId);
    if (mapping?.target_id !== input.draftId || mapping.source_revision !== input.sourceRevision) {
      throw new Error("Import source maps to another draft.");
    }
    if (this.receipt(input.daemonId, "draft", input.sourceId)) return;
    const draft = this.draft(input.draftId);
    if (!draft || draft.phase !== "importing") throw new Error("Imported draft is not ready.");
    const expected = db.prepare(`
      SELECT attachment_id, content_hash, source_revision FROM presentation_import_attachments
      WHERE daemon_id = ? AND source_id = ?
    `).all(input.daemonId, input.sourceId) as Array<{ attachment_id: string; content_hash: string; source_revision: number }>;
    for (const item of expected) {
      if (item.source_revision !== input.sourceRevision) throw new Error("Import source revision changed.");
      const content = db.prepare(`
        SELECT content_hash FROM presentation_draft_attachments WHERE draft_id = ? AND id = ?
      `).get(input.draftId, item.attachment_id) as { content_hash: string } | undefined;
      if (content?.content_hash !== item.content_hash) throw new Error("Imported attachment content is incomplete.");
    }
    const revision = this.nextRevision();
    db.prepare("UPDATE presentation_drafts SET phase = 'unsent', revision = ? WHERE id = ?")
      .run(revision, input.draftId);
    db.prepare("DELETE FROM presentation_import_attachments WHERE daemon_id = ? AND source_id = ?")
      .run(input.daemonId, input.sourceId);
    db.prepare(`
      INSERT INTO presentation_import_receipts(daemon_id, source_kind, source_id, target_id, source_revision)
      VALUES (?, 'draft', ?, ?, ?)
    `).run(input.daemonId, input.sourceId, input.draftId, input.sourceRevision);
  }

  private receipt(daemonId: string, kind: string, sourceId: string) {
    return this.requireDatabase().prepare(`
      SELECT * FROM presentation_import_receipts
      WHERE daemon_id = ? AND source_kind = ? AND source_id = ?
    `).get(daemonId, kind, sourceId) as ReceiptRow | undefined;
  }

  private sourceMapping(daemonId: string, kind: "draft" | "folder" | "member", sourceId: string) {
    return this.requireDatabase().prepare(`
      SELECT target_id, source_revision FROM presentation_source_mappings
      WHERE daemon_id = ? AND source_kind = ? AND source_id = ?
    `).get(daemonId, kind, sourceId) as { target_id: string; source_revision: number | null } | undefined;
  }

  private sourceTarget(daemonId: string, kind: "draft" | "folder" | "member", sourceId: string) {
    return this.sourceMapping(daemonId, kind, sourceId)?.target_id;
  }

  private mapSource(daemonId: string, kind: "draft" | "folder" | "member",
    sourceId: string, targetId: string, sourceRevision: number) {
    const existing = this.sourceMapping(daemonId, kind, sourceId);
    if (existing && (existing.target_id !== targetId || existing.source_revision !== sourceRevision)) {
      throw new Error("Import source revision or target changed during transfer.");
    }
    if (existing) return;
    this.requireDatabase().prepare(`
      INSERT INTO presentation_source_mappings(daemon_id, source_kind, source_id, target_id, source_revision)
      VALUES (?, ?, ?, ?, ?)
    `).run(daemonId, kind, sourceId, targetId, sourceRevision);
  }

  private importLayout(input: Extract<PresentationMutation, { kind: "importLayout" }>) {
    const db = this.requireDatabase();
    const receipt = this.receipt(input.daemonId, "layout", input.sourceId);
    if (receipt) {
      if (receipt.source_revision !== input.sourceRevision) this.noteDivergence(
        input.daemonId, "layout", input.sourceId, receipt.source_revision, input.sourceRevision);
      return;
    }
    if ((input.scope === "project") !== (input.logicalProjectId !== null)
      || input.folders.some(folder => folder.scope !== input.scope
      || folder.logicalProjectId !== input.logicalProjectId)
      || input.members.some(member => member.scope !== input.scope
        || member.logicalProjectId !== input.logicalProjectId)) {
      throw new Error("Imported layout member belongs to another scope.");
    }
    const base = (db.prepare(`
      SELECT MAX(position) FROM presentation_layout_members
      WHERE scope = ? AND logical_project_id IS ?
    `).pluck().get(input.scope, input.logicalProjectId) as number | null) ?? -1;
    const revision = this.nextRevision();
    const insertFolder = db.prepare(`
      INSERT INTO presentation_folders(id, scope, logical_project_id, title, position, revision)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const folderIds = new Set(input.folders.map(folder => folder.sourceId));
    for (const [index, folder] of [...input.folders].sort((a, b) => a.position - b.position).entries()) {
      this.mapSource(input.daemonId, "folder", folder.sourceId, folder.id, input.sourceRevision);
      insertFolder.run(folder.id, folder.scope, folder.logicalProjectId, folder.title, base + index + 1, revision);
    }
    const insertMember = db.prepare(`
      INSERT INTO presentation_layout_members
        (id, scope, logical_project_id, folder_id, kind, draft_id, daemon_id, project_id, thread_id, position, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [index, member] of [...input.members].sort((a, b) => a.position - b.position).entries()) {
      if (member.folderId && !folderIds.has(member.folderId)) {
        throw new Error("Imported folder membership is unresolved.");
      }
      const targetFolderId = member.folderId
        ? this.sourceTarget(input.daemonId, "folder", member.folderId) : null;
      const targetDraftId = member.kind === "draft" && member.draftId
        ? this.sourceTarget(input.daemonId, "draft", member.draftId) : null;
      this.validateLayoutMember({ ...member, folderId: targetFolderId ?? null,
        draftId: targetDraftId ?? null }, new Set(input.folders.map(folder => folder.id)));
      this.mapSource(input.daemonId, "member", member.sourceId, member.id, input.sourceRevision);
      insertMember.run(
        member.id, member.scope, member.logicalProjectId, targetFolderId, member.kind,
        targetDraftId, member.thread?.location.daemonId ?? null,
        member.thread?.location.projectId ?? null, member.thread?.threadId ?? null,
        base + index + 1, revision,
      );
    }
    db.prepare(`
      INSERT INTO presentation_import_receipts(daemon_id, source_kind, source_id, target_id, source_revision)
      VALUES (?, 'layout', ?, ?, ?)
    `).run(input.daemonId, input.sourceId, input.logicalProjectId ?? input.scope, input.sourceRevision);
  }

  private validateLayoutMember(member: {
    scope: "project" | "home" | "pinned";
    logicalProjectId: string | null;
    folderId: string | null;
    kind: "draft" | "thread";
    draftId: string | null;
    thread: { location: { daemonId: string; projectId: string }; threadId: string } | null;
  }, folderIds: ReadonlySet<string>) {
    if (member.folderId && !folderIds.has(member.folderId)) {
      throw new Error("Layout folder membership is unresolved.");
    }
    if (member.kind === "draft") {
      if (!member.draftId || member.thread) throw new Error("Layout draft membership is invalid.");
      const draft = this.draft(member.draftId);
      if (!draft || draft.phase !== "unsent" && draft.phase !== "submitting") {
        throw new Error("Layout draft membership is unresolved.");
      }
      if (member.scope === "project" && draft.logical_project_id !== member.logicalProjectId) {
        throw new Error("Layout draft belongs to another project.");
      }
      return;
    }
    if (member.draftId || !member.thread) throw new Error("Layout thread address is invalid.");
    const location = this.requireDatabase().prepare(`
      SELECT logical_project_id FROM presentation_locations
      WHERE daemon_id = ? AND project_id = ?
    `).get(member.thread.location.daemonId, member.thread.location.projectId) as
      { logical_project_id: string } | undefined;
    if (!location) throw new Error("Layout thread location is unavailable.");
    if (member.scope === "project" && location.logical_project_id !== member.logicalProjectId) {
      throw new Error("Layout thread belongs to another project.");
    }
  }

  private noteDivergence(daemonId: string, sourceKind: "draft" | "layout", sourceId: string,
    importedRevision: number, latestRevision: number) {
    if (latestRevision <= importedRevision) return;
    const recorded = this.requireDatabase().prepare(`
      SELECT latest_revision FROM presentation_source_divergences
      WHERE daemon_id = ? AND source_kind = ? AND source_id = ?
    `).get(daemonId, sourceKind, sourceId) as { latest_revision: number } | undefined;
    if (recorded && recorded.latest_revision >= latestRevision) return;
    this.requireDatabase().prepare(`
      INSERT INTO presentation_source_divergences
        (daemon_id, source_kind, source_id, imported_revision, latest_revision)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(daemon_id, source_kind, source_id) DO UPDATE SET
        latest_revision = MAX(latest_revision, excluded.latest_revision)
    `).run(daemonId, sourceKind, sourceId, importedRevision, latestRevision);
    this.nextRevision();
    this.options.onDiagnostic?.("Legacy presentation source changed after app import.");
  }
}
