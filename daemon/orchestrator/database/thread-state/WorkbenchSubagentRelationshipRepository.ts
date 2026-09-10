/*
 * Exports:
 * - default WorkbenchSubagentRelationshipRepository: transactionally own parent allocation and child membership.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { WorkbenchSubagentRelationship } from "workbench-shared/types";
import type { WorkbenchStoredSubagent, WorkbenchSubagentReservation } from "../../workbench-subagent-record";
import type { WorkbenchSubagentRelationshipRead } from "./workbench-thread-state-persistence";

type RelationshipRow = {
  id: string;
  parent_thread_id: string;
  relationship_kind: "reserved" | "active";
  project_id: string;
  direct_subagent_index: number;
  created_at: number;
  updated_at: number;
  harness_id: WorkbenchSubagentRelationship["harness"] | null;
  cwd: string | null;
  name: string | null;
  title: string | null;
  profile_id: string | null;
  profile_name: string | null;
  thread_id: string | null;
};

const SELECT_RELATIONSHIPS = `
  SELECT relationship.*, metadata.harness_id, metadata.cwd, metadata.name, metadata.title,
    metadata.profile_id, metadata.profile_name, active.thread_id
  FROM workbench_subagent_relationships relationship
  LEFT JOIN workbench_subagent_relationship_metadata metadata ON metadata.relationship_id = relationship.id
  LEFT JOIN workbench_active_subagent_relationships active ON active.relationship_id = relationship.id
`;

export default class WorkbenchSubagentRelationshipRepository {
  constructor(private readonly database: Database.Database) {}

  read(query: WorkbenchSubagentRelationshipRead): WorkbenchSubagentRelationship[] {
    if (query.after && !query.parentThreadId) throw new Error("Subagent pagination requires a parent.");
    if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1)) throw new Error("Subagent read limit is invalid.");
    const conditions = ["relationship.project_id = ?", "relationship.relationship_kind = 'active'"];
    const values: Array<string | number> = [query.projectId];
    if (query.parentThreadId) {
      conditions.push("relationship.parent_thread_id = ?");
      values.push(query.parentThreadId);
    }
    if (query.after) {
      conditions.push("(relationship.created_at < ? OR (relationship.created_at = ? AND active.thread_id > ?))");
      values.push(query.after.createdAt, query.after.createdAt, query.after.threadId);
    }
    if (query.limit !== undefined) values.push(query.limit);
    const rows = this.database.prepare(`${SELECT_RELATIONSHIPS}
      WHERE ${conditions.join(" AND ")}
      ORDER BY relationship.created_at ${query.parentThreadId ? "DESC" : "ASC"}, active.thread_id
      ${query.limit === undefined ? "" : "LIMIT ?"}
    `).all(...values) as RelationshipRow[];
    return rows.map(row => {
      const record = this.readRow(row);
      if (record.kind !== "active") throw new Error("Subagent read included a reservation.");
      const { kind: _kind, ...relationship } = record;
      return relationship;
    });
  }

  getOwnedMany(parentThreadId: string, projectId: string, threadIds: readonly string[]) {
    return this.database.transaction(() => {
      const records = threadIds.map(threadId => this.getOwned(parentThreadId, projectId, threadId));
      return records.every((record): record is WorkbenchSubagentRelationship => record !== null) ? records : null;
    })();
  }

  reserve(record: Omit<WorkbenchSubagentReservation, "directSubagentIndex">): WorkbenchSubagentReservation {
    z.uuid().parse(record.reservationId);
    return this.database.transaction(() => {
      if (this.database.prepare("SELECT 1 FROM workbench_subagent_relationships WHERE parent_thread_id = ? AND name_key = ?")
        .get(record.parentThreadId, record.name.toLocaleLowerCase())) {
        throw new Error(`Subagent name is already in use by this parent: ${record.name}`);
      }
      this.database.prepare(`
        INSERT INTO workbench_subagent_parents(parent_thread_id, next_direct_subagent_index)
        VALUES (?, 0) ON CONFLICT(parent_thread_id) DO NOTHING
      `).run(record.parentThreadId);
      const { next_direct_subagent_index: directSubagentIndex } = this.database.prepare(`
        SELECT next_direct_subagent_index FROM workbench_subagent_parents WHERE parent_thread_id = ?
      `).get(record.parentThreadId) as { next_direct_subagent_index: number };
      if (!Number.isSafeInteger(directSubagentIndex + 1)) throw new Error("Subagent allocation index is exhausted.");
      const reserved = { ...record, directSubagentIndex };
      this.insert({ ...reserved, kind: "reserved" }, record.reservationId);
      this.database.prepare(`
        UPDATE workbench_subagent_parents SET next_direct_subagent_index = ? WHERE parent_thread_id = ?
      `).run(directSubagentIndex + 1, record.parentThreadId);
      return reserved;
    })();
  }

  activate(parentThreadId: string, reservationId: string, record: WorkbenchSubagentRelationship) {
    this.database.transaction(() => {
      const reserved = this.database.prepare(`
        SELECT parent_thread_id, project_id, relationship_kind, direct_subagent_index
        FROM workbench_subagent_relationships WHERE id = ?
      `).get(reservationId) as Pick<RelationshipRow, "parent_thread_id" | "project_id" | "relationship_kind" | "direct_subagent_index"> | undefined;
      if (!reserved || reserved.relationship_kind !== "reserved"
        || reserved.parent_thread_id !== parentThreadId || record.parentThreadId !== parentThreadId
        || reserved.project_id !== record.projectId || reserved.direct_subagent_index !== record.directSubagentIndex) {
        throw new Error("Subagent activation does not match its reservation.");
      }
      this.database.prepare(`
        UPDATE workbench_subagent_relationships SET relationship_kind = 'active', name_key = ?, created_at = ?, updated_at = ?
        WHERE id = ?
      `).run(record.name.toLocaleLowerCase(), record.createdAt, record.updatedAt, reservationId);
      this.writeMetadata(reservationId, record);
      this.database.prepare(`
        INSERT INTO workbench_active_subagent_relationships(relationship_id, relationship_kind, thread_id)
        VALUES (?, 'active', ?)
      `).run(reservationId, record.threadId);
    })();
  }

  remove(parentThreadId: string, identifier: string) {
    return this.database.prepare(`
      DELETE FROM workbench_subagent_relationships WHERE parent_thread_id = ? AND (
        (relationship_kind = 'reserved' AND id = ?) OR id IN (
          SELECT relationship_id FROM workbench_active_subagent_relationships WHERE thread_id = ?
        )
      )
    `).run(parentThreadId, identifier, identifier).changes > 0;
  }

  getOwned(parentThreadId: string, projectId: string, threadId: string): WorkbenchSubagentRelationship | null {
    const row = this.database.prepare(`${SELECT_RELATIONSHIPS}
      WHERE relationship.parent_thread_id = ? AND relationship.project_id = ? AND active.thread_id = ?
    `).get(parentThreadId, projectId, threadId) as RelationshipRow | undefined;
    if (!row) return null;
    const record = this.readRow(row);
    if (record.kind !== "active") throw new Error("Subagent membership is incomplete.");
    const { kind: _kind, ...relationship } = record;
    return relationship;
  }

  readParent(parentThreadId: string) {
    const parent = this.database.prepare(`
      SELECT next_direct_subagent_index FROM workbench_subagent_parents WHERE parent_thread_id = ?
    `).get(parentThreadId) as { next_direct_subagent_index: number } | undefined;
    if (!parent) return null;
    const rows = this.database.prepare(`${SELECT_RELATIONSHIPS}
      WHERE relationship.parent_thread_id = ? ORDER BY relationship.direct_subagent_index
    `).all(parentThreadId) as RelationshipRow[];
    return {
      parentThreadId, nextDirectSubagentIndex: parent.next_direct_subagent_index,
      relationships: rows.map((row) => this.readRow(row)),
    };
  }

  importParent(input: {
    parentThreadId: string;
    nextDirectSubagentIndex: number;
    relationships: readonly WorkbenchStoredSubagent[];
  }) {
    const { parentThreadId, nextDirectSubagentIndex, relationships } = input;
    if (!Number.isSafeInteger(nextDirectSubagentIndex) || nextDirectSubagentIndex < 0
      || relationships.some((record) => record.parentThreadId !== parentThreadId
        || !Number.isSafeInteger(record.directSubagentIndex) || record.directSubagentIndex < 0
        || record.directSubagentIndex >= nextDirectSubagentIndex)) {
      throw new Error("Subagent import has inconsistent parent allocation.");
    }
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO workbench_subagent_parents(parent_thread_id, next_direct_subagent_index) VALUES (?, ?)
      `).run(parentThreadId, nextDirectSubagentIndex);
      for (const record of relationships) {
        this.insert(record, record.kind === "reserved" ? z.uuid().parse(record.reservationId) : randomUUID());
      }
    })();
  }

  private insert(record: WorkbenchStoredSubagent, id: string) {
    this.database.prepare(`
      INSERT INTO workbench_subagent_relationships(
        id, parent_thread_id, relationship_kind, project_id, name_key, direct_subagent_index, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, record.parentThreadId, record.kind, record.projectId, record.name.toLocaleLowerCase(),
      record.directSubagentIndex, record.createdAt, record.updatedAt,
    );
    this.writeMetadata(id, record);
    if (record.kind === "active") {
      this.database.prepare(`
        INSERT INTO workbench_active_subagent_relationships(relationship_id, relationship_kind, thread_id)
        VALUES (?, 'active', ?)
      `).run(id, record.threadId);
    }
  }

  private writeMetadata(id: string, record: Omit<WorkbenchSubagentRelationship, "threadId">) {
    this.database.prepare("INSERT OR IGNORE INTO workbench_harnesses(id) VALUES (?)").run(record.harness);
    this.database.prepare(`
      INSERT INTO workbench_subagent_relationship_metadata(relationship_id, harness_id, cwd, name, title, profile_id, profile_name)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(relationship_id) DO UPDATE SET
        harness_id = excluded.harness_id, cwd = excluded.cwd, name = excluded.name,
        title = excluded.title, profile_id = excluded.profile_id, profile_name = excluded.profile_name
    `).run(id, record.harness, record.cwd, record.name, record.title, record.profileId, record.profileName);
  }

  private readRow(row: RelationshipRow): WorkbenchStoredSubagent {
    if (row.harness_id === null || row.cwd === null || row.name === null || row.title === null
      || row.profile_id === null || row.profile_name === null
      || (row.relationship_kind === "active") !== (row.thread_id !== null)) {
      throw new Error("Subagent relationship has incomplete metadata or membership.");
    }
    const metadata = {
      parentThreadId: row.parent_thread_id, projectId: row.project_id, directSubagentIndex: row.direct_subagent_index,
      createdAt: row.created_at, updatedAt: row.updated_at, harness: row.harness_id,
      cwd: row.cwd, name: row.name, title: row.title, profileId: row.profile_id, profileName: row.profile_name,
    };
    return row.relationship_kind === "reserved"
      ? { ...metadata, kind: "reserved", reservationId: row.id }
      : { ...metadata, kind: "active", threadId: row.thread_id! };
  }
}
