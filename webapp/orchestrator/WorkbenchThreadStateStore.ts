/*
 * Exports:
 * - WorkbenchThreadStateGlobalDocumentId/WorkbenchThreadStateStoreDatabase: typed SQLite document identities and database port. Keywords: thread state, sqlite, storage, boundary.
 * - WorkbenchThreadStateParityResult: bounded semantic comparison result without document values. Keywords: thread state, parity, diagnostics.
 * - describeWorkbenchThreadStateParityIssue/describeWorkbenchThreadStateStoreFailure: format bounded SQLite shadow diagnostics without document values. Keywords: thread state, sqlite, diagnostics, sanitization.
 * - default WorkbenchThreadStateStore: persist, compare, and read project and Workbench-wide thread-state documents through the shared database worker. Keywords: thread state, sqlite, store, aggregate, parity.
 */
import { selectRows, upsertRow, type WorkbenchDatabaseMutation, type WorkbenchDatabaseQuery, type WorkbenchDatabaseRow } from "workbench-shared/database/workbench-database-statements";

import { areDeeplyEqual } from "../lib/workbench/deep-equality";
import type { WorkbenchDatabaseMutationResult } from "./database/workbench-database-protocol";
import { threadStateTables } from "./database/workbench-database-schema";

export type WorkbenchThreadStateGlobalDocumentId = "homeDisplayOrder" | "pinnedLayout";

export interface WorkbenchThreadStateStoreDatabase {
  executeTransaction(statements: readonly WorkbenchDatabaseMutation[]): Promise<WorkbenchDatabaseMutationResult>;
  query<Row extends WorkbenchDatabaseRow>(statement: WorkbenchDatabaseQuery<Row>): Promise<Row[]>;
}

export type WorkbenchThreadStateParityResult =
  | { kind: "invalid"; paths: ["root"] }
  | { kind: "matched"; paths: [] }
  | { kind: "mismatched"; paths: string[] }
  | { kind: "seeded"; paths: [] };

export function describeWorkbenchThreadStateParityIssue(
  label: string,
  result: WorkbenchThreadStateParityResult,
) {
  return result.kind === "matched" || result.kind === "seeded"
    ? null
    : `SQLite ${label} ${result.kind}: paths=${result.paths.join(",")}`.slice(0, 500);
}

export function describeWorkbenchThreadStateStoreFailure(label: string, error: unknown) {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?")
    .slice(0, 500);
  return `SQLite ${label} failed: ${message}`.slice(0, 500);
}

type ConformDocument = (candidate: unknown) => object;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function collectDifferentPaths(left: object, right: object): string[] {
  if (isRecord(left) && isRecord(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys]
      .sort()
      .filter((key) => !areDeeplyEqual(left[key], right[key]))
      .slice(0, 20)
      .map((key) => `root.${key}`);
  }
  return ["root"];
}

function compareDocument(candidate: unknown, current: object, conform: ConformDocument): WorkbenchThreadStateParityResult {
  let conformedCandidate: object;
  let conformedCurrent: object;
  try {
    conformedCandidate = conform(candidate);
    conformedCurrent = conform(current);
  } catch {
    return { kind: "invalid", paths: ["root"] };
  }
  if (areDeeplyEqual(conformedCandidate, conformedCurrent)) return { kind: "matched", paths: [] };
  return { kind: "mismatched", paths: collectDifferentPaths(conformedCandidate, conformedCurrent) };
}

export default class WorkbenchThreadStateStore {
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

  async baselineProject(projectId: string, document: object, conform: ConformDocument): Promise<WorkbenchThreadStateParityResult> {
    const stored = await this.readProject(projectId);
    if (stored === null) {
      await this.writeProject(projectId, document);
      return { kind: "seeded", paths: [] };
    }
    const parity = compareDocument(stored, document, conform);
    if (parity.kind !== "matched") await this.writeProject(projectId, document);
    return parity;
  }

  async writeAndVerifyProject(projectId: string, document: object, conform: ConformDocument): Promise<WorkbenchThreadStateParityResult> {
    await this.writeProject(projectId, document);
    const stored = await this.readProject(projectId);
    return stored === null ? { kind: "invalid", paths: ["root"] } : compareDocument(stored, document, conform);
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

  async baselineGlobal(id: WorkbenchThreadStateGlobalDocumentId, document: object, conform: ConformDocument): Promise<WorkbenchThreadStateParityResult> {
    const stored = await this.readGlobal(id);
    if (stored === null) {
      await this.writeGlobal(id, document);
      return { kind: "seeded", paths: [] };
    }
    const parity = compareDocument(stored, document, conform);
    if (parity.kind !== "matched") await this.writeGlobal(id, document);
    return parity;
  }

  async writeAndVerifyGlobal(id: WorkbenchThreadStateGlobalDocumentId, document: object, conform: ConformDocument): Promise<WorkbenchThreadStateParityResult> {
    await this.writeGlobal(id, document);
    const stored = await this.readGlobal(id);
    return stored === null ? { kind: "invalid", paths: ["root"] } : compareDocument(stored, document, conform);
  }
}
