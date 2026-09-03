/*
 * Exports:
 * - WorkbenchThreadStateGlobalDocumentId/WorkbenchThreadStatePersistence/WorkbenchThreadStateStoreDatabase: typed thread-state document and database ports. Keywords: thread state, sqlite, storage, boundary.
 * - default WorkbenchThreadStateStore: persist project and Workbench-wide thread-state documents through the shared database worker. Keywords: thread state, sqlite, store, aggregate.
 */
import { selectRows, upsertRow, type WorkbenchDatabaseMutation, type WorkbenchDatabaseQuery, type WorkbenchDatabaseRow } from "workbench-shared/database/workbench-database-statements";

import type { WorkbenchDatabaseMutationResult } from "./database/workbench-database-protocol";
import { threadStateTables } from "../lib/workbench/database/schema/thread-state-schema";

export type WorkbenchThreadStateGlobalDocumentId = "homeDisplayOrder" | "pinnedLayout";

export interface WorkbenchThreadStatePersistence {
  readGlobal(id: WorkbenchThreadStateGlobalDocumentId): Promise<unknown | null>;
  readProject(projectId: string): Promise<unknown | null>;
  writeGlobal(id: WorkbenchThreadStateGlobalDocumentId, document: object): Promise<void>;
  writeProject(projectId: string, document: object): Promise<void>;
}

export interface WorkbenchThreadStateStoreDatabase {
  executeTransaction(statements: readonly WorkbenchDatabaseMutation[]): Promise<WorkbenchDatabaseMutationResult>;
  query<Row extends WorkbenchDatabaseRow>(statement: WorkbenchDatabaseQuery<Row>): Promise<Row[]>;
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
  ) {}

  async readProject(projectId: string): Promise<unknown | null> {
    const row = (await this.database.query(selectRows(threadStateTables.workbenchThreadStateProjects, {
      where: { project_id: projectId },
    })))[0];
    return row ? decodeDocument(row.document_json, `project:${projectId}`) : null;
  }

  async writeProject(projectId: string, document: object) {
    await this.database.executeTransaction([
      upsertRow(threadStateTables.workbenchThreadStateProjects, {
        project_id: projectId,
        document_json: encodeDocument(document, `project:${projectId}`),
        updated_at: this.now(),
      }, {
        conflictColumns: ["project_id"],
        updateColumns: ["document_json", "updated_at"],
      }),
    ]);
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
  }
}
