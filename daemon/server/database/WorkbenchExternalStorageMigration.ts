/*
 * Exports:
 * - default WorkbenchExternalStorageMigration: validate loose storage and transactionally consume it once.
 */
import { readFile, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import { compileWorkbenchDatabaseStatement, insertRow, upsertRow, type WorkbenchDatabaseMutation } from "workbench-shared/database/workbench-database-statements";
import { workbenchDatabaseTables } from "./workbench-database-schema.ts";
import { localCapabilities } from "../lib/workbench/database/schema/local-capability-schema.ts";
import { browseProfiles, browseSessions } from "../lib/workbench/database/schema/browse-persistence-schema.ts";
import { externalStorageImports } from "../lib/workbench/database/schema/external-storage-import-schema.ts";
import { evidenceTables } from "workbench-shared/workbench/database/schema/evidence-schema";
import { ThreadReferenceSchema, TurnReferenceSchema } from "workbench-shared/workbench/identity";
import WorkbenchThreadIdentityRepository from "./thread-identity/WorkbenchThreadIdentityRepository.ts";
import WorkbenchTranscriptAssetStore, { type TranscriptAssetWrite } from "./transcript/WorkbenchTranscriptAssetStore.ts";
import { encodeTranscriptPathSegment } from "../codex-transcript-normalizers.ts";
import WorkbenchLegacyDiffArtifactStore from "./git/WorkbenchLegacyDiffArtifactStore.ts";
import { normalizeThreadId } from "workbench-shared/workbench/git/git-arc-storage";

const capabilitiesSchema = z.object({ browseRawCommandsEnabled: z.boolean().optional().default(false) });
const sessionSchema = z.object({
  cwd: z.string().nullable().optional().default(null),
  inactiveSince: z.string().nullable().optional().default(null),
  lastActionAt: z.string(),
  mode: z.enum(["headed", "headless"]).nullable(),
  name: z.string().min(1),
  projectId: z.string().nullable().optional().default(null),
  projectRootPath: z.string().nullable().optional().default(null),
  threadId: z.string().nullable().optional().default(null),
});
const profileSchema = z.object({
  createdAt: z.string(), lastUsedAt: z.string(),
  name: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/u),
  profilePath: z.string(),
});
const gapMarkerSchema = z.object({
  version: z.literal(1),
  entries: z.array(z.object({
    id: z.string().min(1), threadId: ThreadReferenceSchema, turnId: TurnReferenceSchema.nullable(),
    openedAt: z.number().finite(), errorText: z.string(),
    recoverability: z.enum(["provider", "unrecoverable"]),
  })),
});

export default class WorkbenchExternalStorageMigration {
  constructor(private readonly database: Database.Database, private readonly storageRoot: string) {}

  async run() {
    let orphanedGapCount = 0;
    const imports: Array<{
      source: string;
      statements: WorkbenchDatabaseMutation[] | (() => WorkbenchDatabaseMutation[]);
      convert?: () => void;
    }> = [];
    const sources = ["settings/local-capabilities.json", "runtime/browse-sessions.json", "runtime/browse-persistent-sessions.json", "workbench-transcript-capture-gap.json"] as const;
    for (const source of sources) {
      if (this.database.prepare("SELECT 1 FROM workbench_external_storage_imports WHERE source_kind = ? AND source_scope = ?").get(source, "")) continue;
      let raw: string;
      try { raw = await readFile(path.join(this.storageRoot, source), "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        imports.push({ source, statements: [] });
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        const statements: WorkbenchDatabaseMutation[] = [];
        switch (source) {
          case "workbench-transcript-capture-gap.json": {
            const marker = gapMarkerSchema.parse(parsed);
            imports.push({ source, statements: () => {
              const identities = new WorkbenchThreadIdentityRepository(this.database);
              return marker.entries.flatMap(entry => {
                const thread = identities.resolve({ threadId: entry.threadId, harness: "codex" });
                if (!thread) {
                  // Historical markers can outlive their thread; retain the rollback source without resurrecting it.
                  orphanedGapCount++;
                  return [];
                }
                const turn = entry.turnId ? identities.resolveTurn({ threadId: thread.threadId, turnId: entry.turnId }) : null;
                const existing = this.database.prepare("SELECT thread_id FROM transcript_capture_gaps WHERE id = ?")
                  .get(entry.id) as { thread_id: string } | undefined;
                if (existing && existing.thread_id !== thread.threadId) throw new Error("Capture-gap import changes its thread owner.");
                // Old recovery committed its DB record before removing the pending marker.
                return upsertRow(evidenceTables.transcriptCaptureGaps, {
                  id: entry.id, thread_id: thread.threadId, turn_id: turn?.turnId ?? null,
                  state: entry.recoverability === "provider" ? "open" : "unrecoverable",
                  opened_at: entry.openedAt, closed_at: entry.recoverability === "provider" ? null : entry.openedAt,
                  error_text: entry.errorText.slice(0, 500), reason: "sqlite transcript settlement failed",
                }, {
                  conflictColumns: ["id"],
                  updateColumns: ["turn_id", "state", "opened_at", "closed_at", "error_text", "reason"],
                });
              });
            } });
            continue;
          }
          case "settings/local-capabilities.json": {
            const value = capabilitiesSchema.parse(parsed);
            statements.push(insertRow(localCapabilities, { id: "global", browse_raw_commands_enabled: value.browseRawCommandsEnabled ? 1 : 0 }));
            break;
          }
          case "runtime/browse-sessions.json": {
            for (const value of z.object({ sessions: z.array(sessionSchema) }).parse(parsed).sessions) {
              statements.push(insertRow(browseSessions, {
                name: value.name, cwd: value.cwd, inactive_since: value.inactiveSince, last_action_at: value.lastActionAt,
                mode: value.mode, project_id: value.projectId, project_root_path: value.projectRootPath, thread_id: value.threadId,
              }));
            }
            break;
          }
          case "runtime/browse-persistent-sessions.json": {
            const profileRoot = path.resolve(this.storageRoot, "runtime/browse-profiles");
            for (const value of z.object({ sessions: z.array(profileSchema) }).parse(parsed).sessions) {
              const supplied = path.resolve(value.profilePath);
              const relative = path.relative(profileRoot, supplied);
              const profilePath = relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)
                ? supplied : path.join(profileRoot, value.name);
              statements.push(insertRow(browseProfiles, { name: value.name, created_at: value.createdAt, last_used_at: value.lastUsedAt, profile_path: profilePath }));
            }
            break;
          }
        }
        imports.push({ source, statements });
      } catch (error) {
        throw new Error(`Invalid external storage input: ${source}.`, { cause: error });
      }
    }
    const imageSource = "transcripts/codex/threads";
    if (!this.database.prepare("SELECT 1 FROM workbench_external_storage_imports WHERE source_kind = ? AND source_scope = ''").get(imageSource)) {
      const images = await this.#currentThreadImages();
      imports.push({ source: imageSource, statements: [], convert: () => {
        const store = new WorkbenchTranscriptAssetStore(this.database);
        for (const { filePath, ...input } of images) store.write({ ...input, bytes: readFileSync(filePath) });
      } });
    }
    const diffSource = "git-checkpoint-diffs/threads";
    if (!this.database.prepare("SELECT 1 FROM workbench_external_storage_imports WHERE source_kind = ? AND source_scope = ''").get(diffSource)) {
      const artifacts = await this.#currentThreadDiffs();
      imports.push({ source: diffSource, statements: [], convert: () => {
        const store = new WorkbenchLegacyDiffArtifactStore(this.database);
        for (const { filePath, ...input } of artifacts) store.write({ ...input, diff: readFileSync(filePath, "utf8") });
      } });
    }
    this.database.transaction(() => {
      for (const { source, statements, convert } of imports) {
        try {
          convert?.();
          const mutations = typeof statements === "function" ? statements() : statements;
          for (const statement of [...mutations, insertRow(externalStorageImports, {
            source_kind: source, source_scope: "", imported_at: Date.now(),
          })]) {
            const compiled = compileWorkbenchDatabaseStatement(workbenchDatabaseTables, statement);
            this.database.prepare(compiled.sql).run(...compiled.parameters);
          }
        } catch (error) {
          throw new Error(`External storage conversion failed: ${source}.`, { cause: error });
        }
      }
    })();
    if (orphanedGapCount) {
      console.warn(`[database] retained ${orphanedGapCount} orphaned capture-gap markers in the legacy rollback input; no current thread owners exist.`);
    }
  }

  async #currentThreadImages() {
    // Historical journals without a current thread owner remain untouched rollback inputs.
    const images: Array<Omit<TranscriptAssetWrite, "bytes"> & { filePath: string }> = [];
    const mimeTypes = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" } as const;
    for (const binding of this.#threadBindings("codex")) {
      const address = encodeTranscriptPathSegment(binding.reference);
      const directory = path.join(this.storageRoot, "transcripts/codex/threads", address, "assets");
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        const match = /^([a-f0-9]{64})\.(png|jpg|webp|gif)$/u.exec(entry.name);
        if (!entry.isFile() || !match) throw new Error("Invalid transcript image import file.");
        images.push({
          threadId: binding.threadId, compatibilityAddress: address,
          expectedDigest: match[1]!, mimeType: mimeTypes[match[2] as keyof typeof mimeTypes],
          filePath: path.join(directory, entry.name),
        });
      }
    }
    return images;
  }

  async #currentThreadDiffs() {
    const artifacts: Array<{ threadId: string; artifactId: string; filePath: string }> = [];
    for (const binding of this.#threadBindings(null)) {
      const address = normalizeThreadId(binding.reference);
      if (address === "." || address === "..") throw new Error("Invalid legacy diff thread address.");
      const directory = path.join(this.storageRoot, "git-checkpoint-diffs/threads", address);
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        const match = /^([a-f0-9]{64})\.diff$/u.exec(entry.name);
        if (!entry.isFile() || !match) throw new Error("Invalid legacy diff import file.");
        artifacts.push({ threadId: binding.threadId, artifactId: match[1]!, filePath: path.join(directory, entry.name) });
      }
    }
    return artifacts;
  }

  #threadBindings(harness: string | null) {
    return this.database.prepare(`
      SELECT id AS threadId, id AS reference FROM workbench_threads
      UNION SELECT thread_id, native_thread_id FROM thread_turns WHERE (? IS NULL OR harness_id = ?) AND native_thread_id IS NOT NULL
      UNION SELECT thread_id, native_thread_id FROM workbench_pending_import_threads WHERE (? IS NULL OR harness_id = ?)
      UNION SELECT thread_id, alias FROM workbench_thread_legacy_aliases
    `).all(harness, harness, harness, harness) as Array<{ threadId: string; reference: string }>;
  }
}
