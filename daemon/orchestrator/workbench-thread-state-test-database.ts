/*
 * Exports:
 * - createThreadStateTestDatabase: real relational repositories with explicit synthetic provider metadata admission.
 */
import { after } from "node:test";
import Database from "better-sqlite3";
import { installWorkbenchDatabaseSchema } from "./database/workbench-database-schema";
import WorkbenchThreadStateRelationalRepository from "./database/thread-state/WorkbenchThreadStateRelationalRepository";
import WorkbenchSubagentRelationshipRepository from "./database/thread-state/WorkbenchSubagentRelationshipRepository";
import WorkbenchTranscriptIdentityRepository from "./database/transcript/WorkbenchTranscriptIdentityRepository";
import WorkbenchThreadStateStore from "./WorkbenchThreadStateStore";
import type { WorkbenchThreadStateStoreDatabase } from "./WorkbenchThreadStateStore";
import type { WorkbenchSubagentPersistence, WorkbenchThreadStateCommit } from "./database/thread-state/workbench-thread-state-persistence";
import type { WorkbenchThreadStateRecord } from "./workbench-thread-state-record";
import type { WorkbenchHarnessId } from "workbench-shared/workbench/thread/thread-state";
import { parseProjectDocument } from "./database/thread-state/workbench-thread-state-document-source";
import { normalizeThreadDisplayLayout } from "workbench-shared/workbench/thread/thread-display-layout";

export function createThreadStateTestDatabase(sqlite = new Database(":memory:")) {
  sqlite.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(sqlite);
  for (const harness of ["codex", "copilot", "opencode"]) {
    sqlite.prepare("INSERT OR IGNORE INTO workbench_harnesses(id) VALUES (?)").run(harness);
  }
  after(() => { if (sqlite.open) sqlite.close(); });
  const repository = new WorkbenchThreadStateRelationalRepository(sqlite);
  const relationships = new WorkbenchSubagentRelationshipRepository(sqlite);
  const items = new WorkbenchTranscriptIdentityRepository(sqlite);
  const operations: string[] = [];

  const admitThread = (projectId: string, threadId: string, harness: WorkbenchHarnessId = "codex") => {
    sqlite.prepare("INSERT OR IGNORE INTO workbench_harnesses(id) VALUES (?)").run(harness);
    sqlite.prepare(`
      INSERT OR IGNORE INTO workbench_threads(
        id, project_id, project_root, title, transcript_content_version, created_at, updated_at, activity_at, identity_origin
      ) VALUES (?, ?, ?, ?, 0, 1, 1, 1, 'workbench')
    `).run(threadId, projectId, `C:/${projectId}`, threadId);
    const owner = sqlite.prepare("SELECT project_id FROM workbench_threads WHERE id = ?").get(threadId) as { project_id: string };
    if (owner.project_id !== projectId) return;
    sqlite.prepare(`
      INSERT INTO workbench_pending_import_threads(thread_id, harness_id, native_location, native_thread_id, discovered_at, last_seen_at)
      VALUES (?, ?, ?, ?, 1, 1) ON CONFLICT(thread_id) DO UPDATE SET harness_id = excluded.harness_id
    `).run(threadId, harness, `C:/${projectId}`, threadId);
  };
  const admitTurn = (record: WorkbenchThreadStateRecord, turnId: string) => {
    sqlite.prepare(`
      INSERT OR IGNORE INTO thread_turns(
        id, thread_id, turn_index, harness_id, native_location, native_thread_id, native_turn_id, state, created_at
      ) VALUES (?, ?, (SELECT COALESCE(MAX(turn_index) + 1, 0) FROM thread_turns WHERE thread_id = ?), ?, '', ?, ?, 'inProgress', 1)
    `).run(turnId, record.identity.threadId, record.identity.threadId, record.identity.harness, record.identity.threadId, turnId);
  };
  const admitRecord = (record: WorkbenchThreadStateRecord) => {
    const owner = sqlite.prepare("SELECT project_id FROM workbench_threads WHERE id = ?")
      .get(record.identity.threadId) as { project_id: string } | undefined;
    if (!owner) throw new Error(`Fixture provider did not admit thread ${record.identity.threadId}`);
    admitThread(owner.project_id, record.identity.threadId, record.identity.harness);
    if (record.entryKind === "subagent") admitThread(record.projectId, record.parentThreadId);
    const lifecycle = record.lifecycle;
    const turnId = "turnId" in lifecycle ? lifecycle.turnId : "agent" in lifecycle ? lifecycle.agent?.turnId : null;
    if (turnId) admitTurn(record, turnId);
    for (const questionnaire of [record.pendingQuestionnaire, ...record.questionnaireHistory ?? []]) {
      if (!questionnaire) continue;
      if (questionnaire.turnId) admitTurn(record, questionnaire.turnId);
      for (const itemId of [questionnaire.itemId, "insertAfterItemId" in questionnaire ? questionnaire.insertAfterItemId : null]) {
        if (typeof itemId === "string" && itemId) items.admit({ threadId: record.identity.threadId, itemId, sources: [], legacyAliases: [] });
      }
    }
  };
  const database: WorkbenchThreadStateStoreDatabase & WorkbenchSubagentPersistence & {
    commitThreadState(changes: WorkbenchThreadStateCommit): Promise<void>;
  } = {
    readThreadStateProject: async projectId => {
      operations.push("read:project");
      return repository.readProject(projectId);
    },
    readThreadStateTitleHistories: async projectId => repository.readTitleHistories(projectId),
    writeThreadStateProject: async (projectId, document, titleHistories) => {
      operations.push("commit");
      sqlite.transaction(() => {
        for (const record of document.records) {
          admitThread(projectId, record.identity.threadId, record.identity.harness);
          admitRecord(record);
        }
        repository.writeProject(projectId, document, titleHistories);
      })();
    },
    readThreadStateGlobal: async id => repository.readGlobal(id),
    writeThreadStateGlobal: async document => { repository.writeGlobal(document); },
    readThreadStateArchiveDeadline: async () => repository.readNextArchiveEligibility(),
    readThreadStateArchiveEligible: async before => repository.readArchiveEligible(before),
    commitThreadState: async changes => {
      operations.push("commit");
      sqlite.transaction(() => {
        for (const record of changes.records ?? []) admitRecord(record);
        repository.commit(changes);
      })();
    },
    readSubagents: async query => relationships.read(query),
    readOwnedSubagents: async (parent, project, ids) => relationships.getOwnedMany(parent, project, ids),
    reserveSubagent: async record => {
      admitThread(record.projectId, record.parentThreadId);
      return relationships.reserve(record);
    },
    activateSubagent: async (parent, reservation, record) => {
      admitThread(record.projectId, record.threadId, record.harness);
      relationships.activate(parent, reservation, record);
    },
    removeSubagent: async (parent, identifier) => { relationships.remove(parent, identifier); },
  };
  const persistence = new WorkbenchThreadStateStore(database);
  return {
    ...database, operations, sqlite, repository, persistence, admitThread,
    async readThreadStateRecords(query: import("./database/thread-state/workbench-thread-state-persistence").WorkbenchThreadRecordQuery) {
      return repository.readRecords(query);
    },
    async seedProject(projectId: string, source: object) {
      const project = parseProjectDocument(JSON.stringify(source), projectId);
      for (const record of project.records) admitThread(projectId, record.identity.threadId, record.identity.harness);
      await database.commitThreadState({
        records: project.records,
        drafts: project.drafts.map(({ pinned, snoozed, ...draft }) => ({ draft, pinned, snoozed })),
        projectProfiles: [{ projectId, profile: project.newThreadProfile }],
        layouts: [{ owner: { kind: "project", projectId }, revision: 0, displayOrder: project.displayOrder }],
      });
    },
    async seedGlobal(id: "pinnedLayout" | "homeDisplayOrder", source: { displayOrder?: object; revision?: number; importedProjectIds?: string[] }) {
      await database.commitThreadState({
        layouts: [{
          owner: { kind: id === "pinnedLayout" ? "pinned" : "home" }, revision: source.revision ?? 0,
          displayOrder: normalizeThreadDisplayLayout(source.displayOrder),
        }],
        ...(source.importedProjectIds ? { pinnedImports: source.importedProjectIds } : {}),
      });
    },
  };
}
