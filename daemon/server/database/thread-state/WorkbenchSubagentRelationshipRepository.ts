/*
 * Exports:
 * - default WorkbenchSubagentRelationshipRepository: transactionally own parent allocation and child membership, including children
 *   on other daemons, and remote-parented children's sibling rosters.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { WorkbenchSubagentRelationship } from "workbench-shared/types";
import type { DaemonId, ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type { SiblingRosterEntry } from "workbench-shared/workbench/network/network-remote-calls";
import type { WorkbenchStoredSubagent, WorkbenchSubagentReservation } from "../../subagents/workbench-subagent-record";
import type { WorkbenchSubagentRelationshipRead } from "./workbench-thread-state-persistence";

type RelationshipRow = {
  id: string;
  parent_thread_id: WorkbenchThreadId;
  relationship_kind: "reserved" | "active";
  project_id: ProjectId;
  direct_subagent_index: number;
  created_at: number;
  updated_at: number;
  harness_id: WorkbenchSubagentRelationship["harness"] | null;
  cwd: string | null;
  name: string | null;
  title: string | null;
  profile_id: string | null;
  profile_name: string | null;
  thread_id: WorkbenchThreadId | null;
  child_daemon_id: DaemonId | null;
  child_hostname: string | null;
  child_project_id: ProjectId | null;
  child_settled_at: number | null;
};

const SELECT_RELATIONSHIPS = `
  SELECT relationship.*, metadata.harness_id, metadata.cwd, metadata.name, metadata.title,
    metadata.profile_id, metadata.profile_name, COALESCE(active.thread_id, remote.thread_id) AS thread_id,
    remote.child_daemon_id, remote.child_hostname, remote.child_project_id, remote.settled_at AS child_settled_at
  FROM workbench_subagent_relationships relationship
  LEFT JOIN workbench_subagent_relationship_metadata metadata ON metadata.relationship_id = relationship.id
  LEFT JOIN workbench_active_subagent_relationships active ON active.relationship_id = relationship.id
  LEFT JOIN workbench_remote_subagent_relationships remote ON remote.relationship_id = relationship.id
`;

type RosterRow = { sibling_daemon_id: DaemonId; sibling_thread_id: WorkbenchThreadId; name: string };

export default class WorkbenchSubagentRelationshipRepository {
  constructor(private readonly database: Database.Database) {}

  /** A project's relationships; without a parent filter, also its children whose parents live on other daemons. */
  read(query: WorkbenchSubagentRelationshipRead): WorkbenchSubagentRelationship[] {
    const conditions = ["relationship.project_id = ?", "relationship.relationship_kind = 'active'"];
    const values: string[] = [query.projectId];
    if (query.parentThreadId) {
      conditions.push("relationship.parent_thread_id = ?");
      values.push(query.parentThreadId);
    }
    const rows = this.database.prepare(`${SELECT_RELATIONSHIPS}
      WHERE ${conditions.join(" AND ")}
      ORDER BY relationship.created_at ${query.parentThreadId ? "DESC" : "ASC"}, active.thread_id
    `).all(...values) as RelationshipRow[];
    const local = rows.map(row => {
      const record = this.readRow(row);
      if (record.kind !== "active") throw new Error("Subagent read included a reservation.");
      const { kind: _kind, ...relationship } = record;
      return relationship;
    });
    return query.parentThreadId ? local : [...local, ...this.readRemoteParented(query.projectId)];
  }

  /** Local children of parents on other daemons, as relationships seen from the child's side. */
  private readRemoteParented(projectId: ProjectId): WorkbenchSubagentRelationship[] {
    const rows = this.database.prepare(`
      SELECT child.*, state.harness_id, state.title FROM workbench_remote_subagent_thread_states child
      JOIN workbench_thread_states state ON state.thread_id = child.thread_id
      JOIN workbench_threads thread ON thread.id = child.thread_id
      WHERE thread.project_id = ? ORDER BY child.created_at, child.thread_id
    `).all(projectId) as Array<{
      thread_id: WorkbenchThreadId; parent_thread_id: WorkbenchThreadId; parent_daemon_id: DaemonId; parent_hostname: string;
      cwd: string; name: string; profile_id: string; profile_name: string; direct_subagent_index: number;
      created_at: number; updated_at: number; harness_id: WorkbenchSubagentRelationship["harness"]; title: string;
    }>;
    return rows.map(row => ({
      threadId: row.thread_id, parentThreadId: row.parent_thread_id, projectId, harness: row.harness_id, cwd: row.cwd,
      name: row.name, title: row.title, profileId: row.profile_id, profileName: row.profile_name,
      directSubagentIndex: row.direct_subagent_index, createdAt: row.created_at, updatedAt: row.updated_at,
      parent: { daemonId: row.parent_daemon_id, hostname: row.parent_hostname },
    }));
  }

  getOwnedMany(parentThreadId: WorkbenchThreadId, projectId: ProjectId, threadIds: readonly WorkbenchThreadId[]) {
    return this.database.transaction(() => {
      const records = threadIds.map(threadId => this.getOwned(parentThreadId, projectId, threadId));
      return records.every((record): record is WorkbenchSubagentRelationship => record !== null) ? records : null;
    })();
  }

  reserve(record: Omit<WorkbenchSubagentReservation, "directSubagentIndex">): WorkbenchSubagentReservation {
    z.uuid().parse(record.reservationId);
    return this.database.transaction(() => {
      // A remote child's settlement is known only once its daemon reports it.
      if (this.database.prepare(`
        SELECT 1 FROM workbench_subagent_relationships relationship
        LEFT JOIN workbench_active_subagent_relationships active ON active.relationship_id = relationship.id
        LEFT JOIN workbench_thread_lifecycle lifecycle ON lifecycle.thread_id = active.thread_id
        LEFT JOIN workbench_remote_subagent_relationships remote ON remote.relationship_id = relationship.id
        WHERE relationship.parent_thread_id = ? AND relationship.name_key = ?
          AND (relationship.relationship_kind = 'reserved'
            OR COALESCE(lifecycle.settled, CASE WHEN remote.settled_at IS NULL THEN 0 ELSE 1 END, 0) = 0)
      `)
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

  activate(parentThreadId: WorkbenchThreadId, reservationId: string, record: WorkbenchSubagentRelationship) {
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
      this.writeMembership(reservationId, record);
    })();
  }

  /** Records what a remote child's daemon last reported about its settlement. */
  setRemoteSettled(parentThreadId: WorkbenchThreadId, threadId: WorkbenchThreadId, settledAt: number | null) {
    return this.database.prepare(`
      UPDATE workbench_remote_subagent_relationships SET settled_at = ?
      WHERE thread_id = ? AND relationship_id IN (SELECT id FROM workbench_subagent_relationships WHERE parent_thread_id = ?)
    `).run(settledAt, threadId, parentThreadId).changes > 0;
  }

  /** Local parents of one child living on another daemon (or in another folder of this one). */
  parentsOfRemoteChild(daemonId: DaemonId, threadId: WorkbenchThreadId): WorkbenchThreadId[] {
    return (this.database.prepare(`
      SELECT relationship.parent_thread_id FROM workbench_remote_subagent_relationships remote
      JOIN workbench_subagent_relationships relationship ON relationship.id = remote.relationship_id
      WHERE remote.child_daemon_id = ? AND remote.thread_id = ?
    `).all(daemonId, threadId) as Array<{ parent_thread_id: WorkbenchThreadId }>).map(row => row.parent_thread_id);
  }

  /** The parent daemon of every local child whose parent lives elsewhere. */
  remoteParentDaemonIds(): Record<string, DaemonId> {
    const rows = this.database.prepare("SELECT thread_id, parent_daemon_id FROM workbench_remote_subagent_thread_states")
      .all() as Array<{ thread_id: string; parent_daemon_id: DaemonId }>;
    return Object.fromEntries(rows.map(row => [row.thread_id, row.parent_daemon_id]));
  }

  /** Replaces a remote-parented child's sibling roster with the parent's latest snapshot. */
  writeRoster(threadId: WorkbenchThreadId, siblings: readonly SiblingRosterEntry[]) {
    this.database.transaction(() => {
      if (!this.database.prepare("SELECT 1 FROM workbench_remote_subagent_thread_states WHERE thread_id = ?").get(threadId)) {
        throw new Error("That thread is not a subagent of a remote parent.");
      }
      this.database.prepare("DELETE FROM workbench_remote_subagent_siblings WHERE thread_id = ?").run(threadId);
      const insert = this.database.prepare(`INSERT OR IGNORE INTO workbench_remote_subagent_siblings
        (thread_id, sibling_daemon_id, sibling_thread_id, name, name_key) VALUES (?, ?, ?, ?, ?)`);
      for (const sibling of siblings) {
        if (sibling.threadId !== threadId) insert.run(threadId, sibling.daemonId, sibling.threadId, sibling.name, sibling.name.toLocaleLowerCase());
      }
    })();
  }

  readRoster(threadId: WorkbenchThreadId): SiblingRosterEntry[] {
    return (this.database.prepare(`SELECT sibling_daemon_id, sibling_thread_id, name FROM workbench_remote_subagent_siblings
      WHERE thread_id = ? ORDER BY name_key`).all(threadId) as RosterRow[])
      .map(row => ({ daemonId: row.sibling_daemon_id, threadId: row.sibling_thread_id, name: row.name }));
  }

  remove(parentThreadId: WorkbenchThreadId, identifier: string) {
    return this.database.prepare(`
      DELETE FROM workbench_subagent_relationships WHERE parent_thread_id = ? AND (
        (relationship_kind = 'reserved' AND id = ?) OR id IN (
          SELECT relationship_id FROM workbench_active_subagent_relationships WHERE thread_id = ?
          UNION SELECT relationship_id FROM workbench_remote_subagent_relationships WHERE thread_id = ?
        )
      )
    `).run(parentThreadId, identifier, identifier, identifier).changes > 0;
  }

  getOwned(parentThreadId: WorkbenchThreadId, projectId: ProjectId, threadId: WorkbenchThreadId): WorkbenchSubagentRelationship | null {
    const row = this.database.prepare(`${SELECT_RELATIONSHIPS}
      WHERE relationship.parent_thread_id = ? AND relationship.project_id = ? AND COALESCE(active.thread_id, remote.thread_id) = ?
    `).get(parentThreadId, projectId, threadId) as RelationshipRow | undefined;
    if (!row) return null;
    const record = this.readRow(row);
    if (record.kind !== "active") throw new Error("Subagent membership is incomplete.");
    const { kind: _kind, ...relationship } = record;
    return relationship;
  }

  readParent(parentThreadId: WorkbenchThreadId) {
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
    parentThreadId: WorkbenchThreadId;
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
    if (record.kind === "active") this.writeMembership(id, record);
  }

  /** A local child references its thread; a remote child is named by its daemon. */
  private writeMembership(id: string, record: WorkbenchSubagentRelationship) {
    if (!record.location) {
      this.database.prepare(`
        INSERT INTO workbench_active_subagent_relationships(relationship_id, relationship_kind, thread_id)
        VALUES (?, 'active', ?)
      `).run(id, record.threadId);
      return;
    }
    this.database.prepare(`
      INSERT INTO workbench_remote_subagent_relationships(
        relationship_id, relationship_kind, child_daemon_id, child_hostname, child_project_id, thread_id, settled_at
      ) VALUES (?, 'active', ?, ?, ?, ?, ?)
    `).run(id, record.location.daemonId, record.location.hostname, record.location.projectId, record.threadId, record.location.settledAt);
  }

  private writeMetadata(id: string, record: Omit<WorkbenchSubagentRelationship, "threadId" | "location">) {
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
    const location = row.child_daemon_id && row.child_hostname !== null && row.child_project_id
      ? { daemonId: row.child_daemon_id, hostname: row.child_hostname, projectId: row.child_project_id, settledAt: row.child_settled_at }
      : null;
    return row.relationship_kind === "reserved"
      ? { ...metadata, kind: "reserved", reservationId: row.id }
      : { ...metadata, kind: "active", threadId: row.thread_id!, ...(location ? { location } : {}) };
  }
}
