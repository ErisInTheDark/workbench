/*
 * Exports:
 * - WorkbenchThreadStateRelationshipSource: captured parent allocation and membership.
 * - readThreadStateRelationshipSources: read legacy files without changing or following them.
 * - default WorkbenchThreadStateMigration: convert captured facts and verify relational readback before the receipt.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { WorkbenchHarness } from "workbench-shared/types";
import {
  ItemReferenceSchema, NativeThreadIdSchema, NativeTurnIdSchema, ThreadDisplayKeySchema,
  ThreadReferenceSchema, TurnReferenceSchema,
  type ProjectId, type ThreadReference, type WorkbenchThreadId, type WorkbenchTurnId,
} from "workbench-shared/workbench/identity";
import {
  applyWorkbenchDatabaseSchema, type WorkbenchDatabaseSchema,
} from "workbench-shared/database/schema/schema-history";
import {
  WorkbenchHarnessSchema, WorkbenchThreadDraftSchema,
  type WorkbenchDurableQuestionnaire, type WorkbenchThreadLifecycle,
} from "workbench-shared/workbench/thread/thread-state";
import {
  getProjectQualifiedThreadDisplayKey, parseProjectQualifiedThreadDisplayKey,
  ThreadDisplayLayoutSchema, type ThreadDisplayLayout,
  getThreadDisplayThreadKey,
} from "workbench-shared/workbench/thread/thread-display-layout";
import databaseReleases from "workbench-shared/workbench/database/schema/releases";
import type { WorkbenchThreadStateRecord } from "../../workbench-thread-state-record.ts";
import type { WorkbenchStoredSubagent } from "../../workbench-subagent-record.ts";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository.ts";
import { nativeLocationKey } from "../thread-identity/native-location-key.ts";
import WorkbenchTranscriptIdentityRepository from "../transcript/WorkbenchTranscriptIdentityRepository.ts";
import type { WorkbenchThreadIdentityRecord } from "../thread-identity/workbench-thread-identity-types.ts";
import WorkbenchThreadStateRelationalRepository from "./WorkbenchThreadStateRelationalRepository.ts";
import WorkbenchSubagentRelationshipRepository from "./WorkbenchSubagentRelationshipRepository.ts";
import { asRecord, decodeGlobalDocument, parseProjectImport } from "./workbench-thread-state-document-source.ts";

export interface WorkbenchThreadStateRelationshipSource {
  parentThreadId: ThreadReference;
  nextDirectSubagentIndex: number;
  relationships: Array<z.infer<typeof RelationshipSchema>>;
}

const RelationshipMetadataSchema = z.object({
  parentThreadId: z.string().min(1).brand<"ThreadReference">(), projectId: z.string().min(1).brand<"ProjectId">(),
  harness: WorkbenchHarnessSchema, cwd: z.string().min(1), name: z.string().min(1),
  title: z.string().min(1), profileId: z.string().min(1), profileName: z.string().min(1),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  directSubagentIndex: z.number().int().nonnegative(),
});
const RelationshipSchema = z.discriminatedUnion("kind", [
  RelationshipMetadataSchema.extend({ kind: z.literal("active"), threadId: z.string().min(1).brand<"ThreadReference">() }).strict(),
  RelationshipMetadataSchema.extend({ kind: z.literal("reserved"), reservationId: z.uuid() }).strict(),
]);
const ParentRelationshipSourceSchema = z.object({
  parentThreadId: z.string().min(1).brand<"ThreadReference">(),
  schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  nextDirectSubagentIndex: z.number().int().nonnegative().optional(),
  subagents: z.record(z.string(), z.unknown()),
}).strict();
const GlobalRelationshipSourceSchema = z.object({
  version: z.literal(1),
  subagents: z.record(z.string(), z.unknown()),
}).strict();

export async function readThreadStateRelationshipSources(runtimeDirectory: string): Promise<WorkbenchThreadStateRelationshipSource[]> {
  const parents = new Map<ThreadReference, WorkbenchThreadStateRelationshipSource>();
  const read = async (file: string) => {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Subagent import source must be a regular file.");
    return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  };
  const merge = (parentThreadId: ThreadReference, values: unknown[], counter = 0) => {
    const prior = parents.get(parentThreadId);
    const records = new Map<string, Record<string, unknown>>((prior?.relationships ?? []).map(record => [
      record.kind === "reserved" ? record.reservationId : record.threadId, { ...record },
    ]));
    let next = Math.max(counter, prior?.nextDirectSubagentIndex ?? 0);
    const candidates = values.map((value): Record<string, unknown> => {
      const raw = asRecord(value);
      const kind = raw.kind ?? (typeof raw.threadId === "string" && raw.threadId.startsWith("pending:") ? "reserved" : "active");
      const { threadId: rawThreadId, ...metadata } = raw;
      const candidate = {
        ...metadata, kind,
        createdAt: raw.createdAt ?? 0, updatedAt: raw.updatedAt ?? raw.createdAt ?? 0,
        ...(kind === "reserved"
          ? { reservationId: raw.reservationId ?? String(rawThreadId).slice("pending:".length) }
          : { threadId: rawThreadId }),
      };
      return candidate;
    });
    for (const candidate of candidates) {
      const key = z.string().min(1).parse(candidate.kind === "reserved" ? candidate.reservationId : candidate.threadId);
      const previous = records.get(key);
      if (!previous || Number(candidate.updatedAt) >= Number(previous.updatedAt)) records.set(key, candidate);
    }
    const merged = [...records.values()];
    for (const candidate of merged) {
      if (Number.isSafeInteger(candidate.directSubagentIndex) && Number(candidate.directSubagentIndex) >= 0) {
        next = Math.max(next, Number(candidate.directSubagentIndex) + 1);
      }
    }
    const used = new Set<number>();
    const relationships: Array<z.infer<typeof RelationshipSchema>> = [];
    const identifier = (candidate: Record<string, unknown>) => String(candidate.kind === "reserved" ? candidate.reservationId : candidate.threadId);
    for (const candidate of merged.sort((left, right) => Number(left.createdAt) - Number(right.createdAt)
      || identifier(left).localeCompare(identifier(right)))) {
      const supplied = Number(candidate.directSubagentIndex);
      const directSubagentIndex = Number.isSafeInteger(supplied) && supplied >= 0 && !used.has(supplied) ? supplied : next++;
      used.add(directSubagentIndex);
      const record = RelationshipSchema.parse({ ...candidate, directSubagentIndex });
      if (record.parentThreadId !== parentThreadId) throw new Error("Subagent source changes its parent owner.");
      relationships.push(record);
    }
    parents.set(parentThreadId, { parentThreadId, nextDirectSubagentIndex: next, relationships });
  };
  const directory = path.join(runtimeDirectory, "subagents");
  let files: import("node:fs").Dirent[] = [];
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Subagent import directory must not be a link.");
    files = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const file of files.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!file.name.endsWith(".json")) continue;
    const source = ParentRelationshipSourceSchema.parse(await read(path.join(directory, file.name)));
    const parentThreadId = source.parentThreadId;
    const counter = source.nextDirectSubagentIndex ?? 0;
    merge(parentThreadId, Object.values(source.subagents), counter);
  }
  let legacy: unknown = null;
  try { legacy = await read(path.join(runtimeDirectory, "subagents.json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (legacy !== null) {
    const source = GlobalRelationshipSourceSchema.parse(legacy);
    const grouped = new Map<ThreadReference, unknown[]>();
    for (const value of Object.values(source.subagents)) {
      const parent = z.string().min(1).brand<"ThreadReference">().parse(asRecord(value).parentThreadId);
      grouped.set(parent, [...grouped.get(parent) ?? [], value]);
    }
    for (const [parent, values] of grouped) merge(parent, values);
  }
  return [...parents.values()];
}

export default class WorkbenchThreadStateMigration {
  private readonly identities: WorkbenchThreadIdentityRepository;
  private readonly items: WorkbenchTranscriptIdentityRepository;

  constructor(private readonly database: Database.Database) {
    this.identities = new WorkbenchThreadIdentityRepository(database);
    this.items = new WorkbenchTranscriptIdentityRepository(database);
  }

  requiresImport() {
    const imported = this.database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'workbench_thread_state_import'").get();
    return !(imported && this.database.prepare("SELECT 1 FROM workbench_thread_state_import WHERE id = 1").get());
  }

  run(schema: WorkbenchDatabaseSchema, relationships: readonly WorkbenchThreadStateRelationshipSource[], completedAt: number) {
    if (!this.requiresImport()) {
      this.verifyCurrentState();
      return { imported: false };
    }
    const foreignKeys = this.database.pragma("foreign_keys", { simple: true }) === 1;
    if (this.database.inTransaction) throw new Error("Thread-state conversion owns its outer transaction.");
    this.database.pragma("foreign_keys = OFF");
    try {
      return this.database.transaction(() => {
        // Existing histories remain sealed. The domain conversion owns only the new release.
        applyWorkbenchDatabaseSchema(this.database, schema, { targetVersion: databaseReleases.nativeIdentityLookupIndexes.version });
        const projects = (this.database.prepare("SELECT project_id, document_json FROM workbench_thread_state_projects").all() as {
          project_id: ProjectId; document_json: string;
        }[]).map(row => ({ projectId: row.project_id, document: parseProjectImport(row.document_json, row.project_id) }));
        const globals = this.database.prepare("SELECT id, document_json FROM workbench_thread_state_globals").all() as {
          id: string; document_json: string;
        }[];
        const titleRows = this.database.prepare("SELECT * FROM workbench_thread_title_history").all() as {
          project_id: ProjectId; harness_id: WorkbenchHarness; thread_id: string; title: string; used_at: number;
        }[];
        for (const project of projects) for (const record of project.document.records) this.admitRecord(project.projectId, record);
        for (const parent of relationships) {
          const projectIds = new Set(parent.relationships.map(record => record.projectId));
          if (projectIds.size > 1) throw new Error("Retained parent relationships disagree about project ownership.");
          const projectId = [...projectIds][0];
          const existing = this.identities.resolve({ threadId: parent.parentThreadId, ...(projectId ? { projectId } : {}) });
          if (existing) continue;
          if (!projectId) throw new Error("Retained parent has no project ownership evidence.");
          this.identities.admitRetainedReference({
            reference: parent.parentThreadId, projectId,
            projectRoot: this.projectRoot(projectId, parent.relationships.map(record => record.cwd)),
          });
        }
        for (const parent of relationships) for (const record of parent.relationships) {
          this.requireThread(record.parentThreadId, record.projectId);
          if (record.kind === "active" && !this.identities.resolve({ projectId: record.projectId, harness: record.harness, threadId: record.threadId })) {
            this.identities.observe({
              native: { harness: record.harness, nativeThreadId: NativeThreadIdSchema.parse(record.threadId), nativeLocation: record.cwd },
              projectId: record.projectId, projectRoot: this.projectRoot(record.projectId), title: record.title,
              createdAt: record.createdAt, updatedAt: record.updatedAt, activityAt: record.updatedAt,
            });
          }
        }
        const converted = projects.map(project => ({
          projectId: project.projectId,
          records: project.document.records.map(record => this.mapRecord(project.projectId, {
            ...record, settledAt: record.lifecycle.settled ? record.settledAt ?? completedAt : record.settledAt,
          })),
          drafts: project.document.drafts.map(({ pinned, snoozed, ...draft }) => ({
            pinned, snoozed, draft: WorkbenchThreadDraftSchema.parse(draft),
          })),
          profile: project.document.newThreadProfile,
          displayOrder: this.mapLayout(project.document.displayOrder, project.projectId),
        }));
        const canonicalTitles = new Map<string, typeof titleRows[number]>();
        const allTitles = [...titleRows, ...projects.flatMap(project => project.document.records.flatMap(record =>
          (record.titleHistory ?? []).map(entry => ({
            project_id: project.projectId, harness_id: record.identity.harness,
            thread_id: record.identity.threadId, title: entry.title, used_at: entry.usedAt,
          })),
        ))];
        for (const row of allTitles) {
          const threadId = this.requireThread(row.thread_id, row.project_id, row.harness_id).threadId;
          const key = `${threadId}\0${row.title}`;
          const previous = canonicalTitles.get(key);
          if (!previous || row.used_at > previous.used_at) canonicalTitles.set(key, { ...row, thread_id: threadId });
        }
        this.database.prepare("DELETE FROM workbench_thread_title_history").run();
        const writeLegacyTitle = this.database.prepare("INSERT INTO workbench_thread_title_history(project_id, harness_id, thread_id, title, used_at) VALUES (?, ?, ?, ?, ?)");
        for (const row of canonicalTitles.values()) writeLegacyTitle.run(row.project_id, row.harness_id, row.thread_id, row.title, row.used_at);
        applyWorkbenchDatabaseSchema(this.database, schema, { targetVersion: databaseReleases.providerReferences.version });
        const repository = new WorkbenchThreadStateRelationalRepository(this.database, this.identities);
        for (const project of converted) {
          for (const record of project.records) {
            record.titleHistory = [...canonicalTitles.values()].filter(row => row.thread_id === record.identity.threadId)
              .map(row => ({ title: row.title, usedAt: row.used_at }));
          }
        }
        repository.commit({
          records: converted.flatMap(project => project.records),
          drafts: converted.flatMap(project => project.drafts),
          projectProfiles: converted.map(project => ({ projectId: project.projectId, profile: project.profile })),
          layouts: converted.map(project => ({
            owner: { kind: "project" as const, projectId: project.projectId }, revision: 0, displayOrder: project.displayOrder,
          })),
        });
        const relationshipRepository = new WorkbenchSubagentRelationshipRepository(this.database);
        const expectedParents = relationships.map(parent => ({
          ...parent,
          parentThreadId: this.requireThread(parent.parentThreadId).threadId,
          relationships: parent.relationships.map((record): WorkbenchStoredSubagent => {
            const parentThreadId = this.requireThread(record.parentThreadId, record.projectId).threadId;
            return record.kind === "active"
              ? { ...record, parentThreadId, threadId: this.requireThread(record.threadId, record.projectId, record.harness).threadId }
              : { ...record, parentThreadId };
          }),
        }));
        for (const parent of expectedParents) relationshipRepository.importParent(parent);
        for (const global of globals) {
          const document = decodeGlobalDocument(global.document_json, global.id);
          if (global.id !== "pinnedLayout" && global.id !== "homeDisplayOrder") throw new Error("Unsupported thread-state global document.");
          const fields = new Set(["displayOrder", "revision", "version", ...(global.id === "pinnedLayout" ? ["importedProjectIds"] : [])]);
          if (Object.keys(document).some(key => !fields.has(key)) || document.version !== 1) {
            throw new Error("Thread-state import contains unsupported global layout facts.");
          }
          const owner = { kind: global.id === "pinnedLayout" ? "pinned" as const : "home" as const };
          const displayOrder = this.mapLayout(ThreadDisplayLayoutSchema.parse(document.displayOrder ?? {}));
          const revision = z.number().int().nonnegative().parse(document.revision ?? 0);
          const pinnedImports = global.id === "pinnedLayout" ? z.array(z.string().brand<"ProjectId">()).parse(document.importedProjectIds ?? []) : undefined;
          repository.commit({ layouts: [{ owner, revision, displayOrder }], ...(pinnedImports ? { pinnedImports } : {}) });
          this.same(repository.readLayout(owner), { revision, displayOrder }, "global layout");
          if (pinnedImports) this.same(repository.readPinnedImports().sort(), [...pinnedImports].sort(), "pinned imports");
        }
        for (const project of converted) {
          const actual = repository.readRecords({ selection: "project", projectId: project.projectId });
          const order = (records: WorkbenchThreadStateRecord[]) => records.map(record => ({
            ...record, titleHistory: [...record.titleHistory ?? []].sort((left, right) => left.title.localeCompare(right.title)),
          })).sort((left, right) => left.identity.threadId.localeCompare(right.identity.threadId));
          this.same(order(actual), order(project.records), "thread facts");
          this.same(repository.readDrafts(project.projectId).sort((left, right) => left.draft.draftId.localeCompare(right.draft.draftId)),
            [...project.drafts].sort((left, right) => left.draft.draftId.localeCompare(right.draft.draftId)), "draft facts");
          this.same(repository.readProjectProfile(project.projectId), project.profile, "project profile");
          this.same(repository.readLayout({ kind: "project", projectId: project.projectId })?.displayOrder, project.displayOrder, "project layout");
        }
        for (const parent of expectedParents) {
          this.same(relationshipRepository.readParent(parent.parentThreadId), {
            ...parent, relationships: [...parent.relationships].sort((left, right) => left.directSubagentIndex - right.directSubagentIndex),
          }, "subagent allocation");
        }
        const actualTitles = (this.database.prepare("SELECT thread_id, title, used_at FROM workbench_thread_title_history").all() as {
          thread_id: string; title: string; used_at: number;
        }[]).map(row => ({ threadId: row.thread_id, title: row.title, usedAt: row.used_at }));
        const expectedTitles = [...canonicalTitles.values()].map(row => ({ threadId: row.thread_id, title: row.title, usedAt: row.used_at }));
        const compareTitles = (left: typeof actualTitles[number], right: typeof actualTitles[number]) =>
          left.threadId.localeCompare(right.threadId) || left.title.localeCompare(right.title);
        this.same(actualTitles.sort(compareTitles), expectedTitles.sort(compareTitles), "title history");
        this.verifyForeignKeys();
        this.database.prepare("DELETE FROM workbench_thread_state_globals").run();
        this.database.prepare("DELETE FROM workbench_thread_state_projects").run();
        this.database.prepare("INSERT INTO workbench_thread_state_import(id, completed_at) VALUES (1, ?)").run(completedAt);
        return { imported: true };
      })();
    } finally {
      if (foreignKeys) this.database.pragma("foreign_keys = ON");
    }
  }

  private projectRoot(projectId: ProjectId, retainedCwds: readonly string[] = []) {
    const rows = this.database.prepare("SELECT DISTINCT project_root FROM workbench_threads WHERE project_id = ?").all(projectId) as { project_root: string }[];
    const candidates = rows.length ? rows.map(row => row.project_root) : retainedCwds;
    const normalized = new Map(candidates.map(root => [
      nativeLocationKey(root, path.win32.isAbsolute(root) ? "win32" : process.platform), root,
    ]));
    const root = [...normalized.values()][0];
    if (normalized.size !== 1 || !root || !(path.isAbsolute(root) || path.win32.isAbsolute(root))) {
      throw new Error("Stored thread project root is unresolved or ambiguous.");
    }
    return root;
  }

  private admitRecord(projectId: ProjectId, record: WorkbenchThreadStateRecord) {
    if (this.identities.resolve({ projectId, ...record.identity })) return;
    const projectRoot = this.projectRoot(projectId);
    this.identities.observe({
      native: { harness: record.identity.harness, nativeThreadId: NativeThreadIdSchema.parse(record.identity.threadId), nativeLocation: record.entryKind === "subagent" ? record.cwd : projectRoot },
      projectId, projectRoot, title: record.title,
      createdAt: record.entryKind === "subagent" ? record.createdAt : record.activityAt,
      updatedAt: record.entryKind === "subagent" ? record.updatedAt : record.activityAt,
      activityAt: record.activityAt,
    });
  }

  private requireThread(threadId: string, projectId?: ProjectId, harness?: WorkbenchHarness) {
    const identity = this.identities.resolve({ threadId: ThreadReferenceSchema.parse(threadId), projectId, harness });
    if (!identity) throw new Error("Thread-state source has unresolved thread ownership.");
    return identity;
  }

  private mapTurn(identity: WorkbenchThreadIdentityRecord, harness: string, turnId: string) {
    const known = this.identities.resolveTurn({ threadId: identity.threadId, turnId: TurnReferenceSchema.parse(turnId) });
    if (known) return known.turnId;
    const bindings = identity.bindings.filter(binding => binding.harness === harness);
    const binding = bindings[0];
    if (!binding || bindings.some(candidate => candidate.nativeLocation !== binding.nativeLocation || candidate.nativeThreadId !== binding.nativeThreadId)) {
      throw new Error("Thread-state turn has unresolved native ownership.");
    }
    return this.identities.observeTurn({
      kind: "turn", threadId: identity.threadId, turnId: NativeTurnIdSchema.parse(turnId),
      harnessId: harness, nativeLocation: binding.nativeLocation, nativeThreadId: binding.nativeThreadId, nativeTurnId: NativeTurnIdSchema.parse(turnId),
      state: "admitted", createdAt: 0, startedAt: null, endedAt: null, durationMs: null,
    }).turnId;
  }

  private mapItem(threadId: WorkbenchThreadId, turnId: WorkbenchTurnId | null, itemId: string | null) {
    if (itemId === null) return null;
    const known = this.items.resolve({ threadId, itemId: ItemReferenceSchema.parse(itemId), ...(turnId ? { turnId } : {}) });
    if (known) return known.itemId;
    if (!turnId) throw new Error("Thread-state item has no resolvable identity or owning turn.");
    return this.items.admit({ threadId, sources: [], legacyAliases: [{ turnId, alias: itemId }] }).itemId;
  }

  private mapRecord(projectId: ProjectId, record: WorkbenchThreadStateRecord): WorkbenchThreadStateRecord {
    const identity = this.requireThread(record.identity.threadId, projectId, record.identity.harness);
    const turn = (id: string) => this.mapTurn(identity, record.identity.harness, id);
    const lifecycle: WorkbenchThreadLifecycle = "agent" in record.lifecycle && record.lifecycle.agent?.turnId
      ? { ...record.lifecycle, agent: { ...record.lifecycle.agent, turnId: turn(record.lifecycle.agent.turnId) } } as WorkbenchThreadLifecycle
      : "turnId" in record.lifecycle ? { ...record.lifecycle, turnId: turn(record.lifecycle.turnId) } : record.lifecycle;
    const questionnaire = (entry: WorkbenchDurableQuestionnaire) => {
      const turnId = entry.turnId === null ? null : turn(entry.turnId);
      return { ...entry, turnId, itemId: this.mapItem(identity.threadId, turnId, entry.itemId) };
    };
    return {
      ...record, identity: { ...record.identity, threadId: identity.threadId }, lifecycle,
      ...(record.entryKind === "subagent" ? { parentThreadId: this.requireThread(record.parentThreadId, projectId).threadId } : {}),
      pendingQuestionnaire: record.pendingQuestionnaire ? questionnaire(record.pendingQuestionnaire) : null,
      questionnaireHistory: (record.questionnaireHistory ?? []).map(entry => ({
        ...entry, ...questionnaire(entry), threadId: identity.threadId, turnId: turn(entry.turnId),
        insertAfterItemId: this.mapItem(identity.threadId, turn(entry.turnId), entry.insertAfterItemId),
      })),
      ...(record.snoozedUntil ? { snoozedUntil: {
        ...record.snoozedUntil,
        identity: { ...record.snoozedUntil.identity, threadId: this.requireThread(record.snoozedUntil.identity.threadId, record.snoozedUntil.projectId, record.snoozedUntil.identity.harness).threadId },
      } } : {}),
    };
  }

  private mapLayout(layout: ThreadDisplayLayout, projectId?: ProjectId): ThreadDisplayLayout {
    const key = (value: string): string => {
      if (value.startsWith("folder:") || value.startsWith("draft:")) return value;
      const qualified = projectId ? { projectId, threadKey: value } : parseProjectQualifiedThreadDisplayKey(value);
      if (!qualified) throw new Error("Global layout has an unqualified member.");
      const match = /^(?!folder:|draft:)([^:]+):(.+)$/u.exec(qualified.threadKey);
      const mapped = match
        ? getThreadDisplayThreadKey(WorkbenchHarnessSchema.parse(match[1]), this.requireThread(match[2]!, qualified.projectId, WorkbenchHarnessSchema.parse(match[1])).threadId)
        : ThreadDisplayKeySchema.parse(qualified.threadKey);
      return projectId ? mapped : getProjectQualifiedThreadDisplayKey(qualified.projectId, mapped);
    };
    const mapped: ThreadDisplayLayout = {};
    for (const section of ["pinned", "snoozed", "settled"] as const) {
      if (layout[section] && Object.keys(layout[section]).length) mapped[section] = Object.fromEntries(Object.entries(layout[section]).map(([id, position]) => [
        key(id), { above: position.above.map(key), below: position.below.map(key) },
      ]));
    }
    if (layout.folders?.length) mapped.folders = layout.folders.map(folder => ({ ...folder, threadKeys: folder.threadKeys.map(key) }));
    return mapped;
  }

  private same(actual: object | null | undefined, expected: object | null | undefined, fact: string) {
    if (!isDeepStrictEqual(actual, expected)) throw new Error(`Thread-state relational readback differs for ${fact}.`);
  }

  private verifyForeignKeys() {
    if ((this.database.pragma("foreign_key_check") as object[]).length) throw new Error("Thread-state conversion has unresolved relational references.");
  }

  private verifyCurrentState() {
    this.database.transaction(() => {
      this.verifyForeignKeys();
      const repository = new WorkbenchThreadStateRelationalRepository(this.database, this.identities);
      const threads = this.database.prepare("SELECT thread_id FROM workbench_thread_states").all() as { thread_id: WorkbenchThreadId }[];
      const records = repository.readRecords({ selection: "threads", threadIds: threads.map(row => row.thread_id) });
      if (records.length !== threads.length) throw new Error("Current thread-state data has incomplete records.");
      const projects = this.database.prepare(`
        SELECT project_id FROM workbench_thread_drafts
        UNION SELECT project_id FROM workbench_project_thread_profiles
        UNION SELECT project_id FROM workbench_sidebar_project_layouts
      `).all() as { project_id: ProjectId }[];
      for (const { project_id: projectId } of projects) {
        repository.readDrafts(projectId);
        repository.readProjectProfile(projectId);
        repository.readLayout({ kind: "project", projectId });
      }
      repository.readLayout({ kind: "pinned" });
      repository.readLayout({ kind: "home" });
      repository.readPinnedImports();
      const relationships = new WorkbenchSubagentRelationshipRepository(this.database);
      const parents = this.database.prepare("SELECT parent_thread_id FROM workbench_subagent_parents").all() as { parent_thread_id: WorkbenchThreadId }[];
      for (const { parent_thread_id: parentThreadId } of parents) {
        const parent = relationships.readParent(parentThreadId)!;
        if (parent.relationships.some(record => record.directSubagentIndex >= parent.nextDirectSubagentIndex)) {
          throw new Error("Current subagent allocation is behind its stored relationships.");
        }
      }
      for (const table of ["workbench_thread_state_projects", "workbench_thread_state_globals"]) {
        if (!this.database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table)) continue;
        if (this.database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
          throw new Error("Retired thread-state documents were written after conversion.");
        }
      }
    })();
  }
}
