/*
 * Exports:
 * Keywords: thread state, sqlite, history, transaction, persistence.
 * - WorkbenchThreadStateGlobalDocumentId/WorkbenchThreadStatePersistence/WorkbenchThreadStateStoreDatabase/WorkbenchThreadStateShadowNotifier: document, database, and shadow ports.
 * - WorkbenchStoredThreadTitleHistory: full distinct title history for one provider identity.
 * - default WorkbenchThreadStateStore: atomically persist project documents and relational title history through the shared worker.
 */
import { deleteRows, selectRows, upsertRow, type WorkbenchDatabaseMutation, type WorkbenchDatabaseQuery, type WorkbenchDatabaseRow } from "workbench-shared/database/workbench-database-statements";

import type { WorkbenchDatabaseMutationResult } from "./database/workbench-database-protocol";
import { threadStateTables } from "../lib/workbench/database/schema/thread-state-schema";
import { threadTitleHistoryTables } from "../lib/workbench/database/schema/thread-title-history-schema";
import type { WorkbenchHarnessId } from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchThreadTitleHistoryEntry } from "workbench-shared/workbench/thread/thread-title-history";

export type WorkbenchThreadStateGlobalDocumentId = "homeDisplayOrder" | "pinnedLayout";

export interface WorkbenchStoredThreadTitleHistory {
  identity: { harness: WorkbenchHarnessId; threadId: string };
  titles: WorkbenchThreadTitleHistoryEntry[];
}

export interface WorkbenchThreadStatePersistence {
  readGlobal(id: WorkbenchThreadStateGlobalDocumentId): Promise<unknown | null>;
  readProject(projectId: string): Promise<unknown | null>;
  readTitleHistories(projectId: string): Promise<WorkbenchStoredThreadTitleHistory[]>;
  writeGlobal(id: WorkbenchThreadStateGlobalDocumentId, document: object): Promise<void>;
  writeProject(projectId: string, document: object, titleHistories?: readonly WorkbenchStoredThreadTitleHistory[]): Promise<void>;
}

export interface WorkbenchThreadStateStoreDatabase {
  executeTransaction(statements: readonly WorkbenchDatabaseMutation[]): Promise<WorkbenchDatabaseMutationResult>;
  query<Row extends WorkbenchDatabaseRow>(statement: WorkbenchDatabaseQuery<Row>): Promise<Row[]>;
}

export interface WorkbenchThreadStateShadowNotifier {
  markGlobal(id: WorkbenchThreadStateGlobalDocumentId): void;
  markProject(projectId: string): void;
}

function sanitizeIdentity(identity: string) {
  return identity.replace(/[^a-zA-Z0-9_./:-]/gu, "?").slice(0, 160);
}

function encodeDocument(document: object, identity: string) {
  const encoded = JSON.stringify(document);
  if (!encoded) throw new Error(`Thread-state document could not be serialized: ${sanitizeIdentity(identity)}`);
  return encoded;
}

function decodeDocument(encoded: string, identity: string): unknown {
  try {
    return JSON.parse(encoded) as unknown;
  } catch {
    throw new Error(`Stored SQLite thread-state document is invalid: ${sanitizeIdentity(identity)}`);
  }
}

export default class WorkbenchThreadStateStore implements WorkbenchThreadStatePersistence {
  constructor(
    private readonly database: WorkbenchThreadStateStoreDatabase,
    private readonly now: () => number = Date.now,
    private readonly shadow?: WorkbenchThreadStateShadowNotifier,
  ) {}

  async readProject(projectId: string): Promise<unknown | null> {
    const row = (await this.database.query(selectRows(threadStateTables.workbenchThreadStateProjects, {
      where: { project_id: projectId },
    })))[0];
    return row ? decodeDocument(row.document_json, `project:${projectId}`) : null;
  }

  async readTitleHistories(projectId: string): Promise<WorkbenchStoredThreadTitleHistory[]> {
    const rows = await this.database.query(selectRows(threadTitleHistoryTables.titles, {
      where: { project_id: projectId },
      orderBy: [{ column: "used_at", direction: "DESC" }, { column: "title" }],
    }));
    const histories = new Map<string, WorkbenchStoredThreadTitleHistory>();
    for (const row of rows) {
      const key = `${row.harness_id}:${row.thread_id}`;
      let history = histories.get(key);
      if (!history) {
        history = { identity: { harness: row.harness_id, threadId: row.thread_id }, titles: [] };
        histories.set(key, history);
      }
      history.titles.push({ title: row.title, usedAt: row.used_at });
    }
    return [...histories.values()];
  }

  async writeProject(projectId: string, document: object, titleHistories?: readonly WorkbenchStoredThreadTitleHistory[]) {
    const statements: WorkbenchDatabaseMutation[] = [
      upsertRow(threadStateTables.workbenchThreadStateProjects, {
        project_id: projectId,
        document_json: encodeDocument(document, `project:${projectId}`),
        updated_at: this.now(),
      }, {
        conflictColumns: ["project_id"],
        updateColumns: ["document_json", "updated_at"],
      }),
    ];
    if (titleHistories) {
      const existing = await this.readTitleHistories(projectId);
      const remaining = new Map(existing.map((history) => [
        `${history.identity.harness}:${history.identity.threadId}`,
        { identity: history.identity, titles: new Map(history.titles.map((entry) => [entry.title, entry.usedAt])) },
      ]));
      for (const history of titleHistories) {
        const previous = remaining.get(`${history.identity.harness}:${history.identity.threadId}`);
        for (const entry of history.titles) {
          if (previous?.titles.get(entry.title) !== entry.usedAt) {
            statements.push(upsertRow(threadTitleHistoryTables.titles, {
              project_id: projectId,
              harness_id: history.identity.harness,
              thread_id: history.identity.threadId,
              title: entry.title,
              used_at: entry.usedAt,
            }, {
              conflictColumns: ["project_id", "harness_id", "thread_id", "title"],
              updateColumns: ["used_at"],
            }));
          }
          previous?.titles.delete(entry.title);
        }
      }
      for (const history of remaining.values()) {
        for (const title of history.titles.keys()) {
          statements.push(deleteRows(threadTitleHistoryTables.titles, {
            project_id: projectId, harness_id: history.identity.harness, thread_id: history.identity.threadId, title,
          }));
        }
      }
    }
    await this.database.executeTransaction(statements);
    this.shadow?.markProject(projectId);
  }

  async readGlobal(id: WorkbenchThreadStateGlobalDocumentId): Promise<unknown | null> {
    const row = (await this.database.query(selectRows(threadStateTables.workbenchThreadStateGlobals, {
      where: { id },
    })))[0];
    return row ? decodeDocument(row.document_json, `global:${id}`) : null;
  }

  async writeGlobal(id: WorkbenchThreadStateGlobalDocumentId, document: object) {
    await this.database.executeTransaction([
      upsertRow(threadStateTables.workbenchThreadStateGlobals, {
        id,
        document_json: encodeDocument(document, `global:${id}`),
        updated_at: this.now(),
      }, {
        conflictColumns: ["id"],
        updateColumns: ["document_json", "updated_at"],
      }),
    ]);
    this.shadow?.markGlobal(id);
  }
}
