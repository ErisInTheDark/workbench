/*
 * Exports:
 * - default WorkbenchNetworkGrantStore: own the inbound grants other daemons' threads hold on this daemon, in SQLite.
 */
import type Database from "better-sqlite3";
import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";
import {
  NetworkGrant as NetworkGrants, NetworkGrantSchema,
  type NetworkGrant, type NetworkGrantCreate, type NetworkGrantRevoke,
} from "workbench-shared/workbench/network/network-grants";

interface GrantRow {
  id: string;
  kind: string;
  caller_daemon_id: string;
  caller_thread_id: string;
  caller_hostname: string;
  caller_title: string;
  target_thread_id: string | null;
  target_project_id: string | null;
  target_label: string;
  created_at: number;
}

const COLUMNS = `id, kind, caller_daemon_id, caller_thread_id, caller_hostname, caller_title, target_thread_id,
  target_project_id, target_label, created_at`;

export default class WorkbenchNetworkGrantStore {
  constructor(private readonly database: Database.Database) {}

  forCaller(callerDaemonId: string, callerThreadId: string) {
    return this.read(`SELECT ${COLUMNS} FROM workbench_network_inbound_grants
      WHERE caller_daemon_id = ? AND caller_thread_id = ? ORDER BY created_at`, callerDaemonId, callerThreadId);
  }

  /** Creating a grant the caller already holds returns the existing one. */
  create(input: { id: string; createdAt: number; grant: NetworkGrantCreate }): NetworkGrant {
    return this.database.transaction(() => {
      const { grant } = input;
      const existing = this.forCaller(grant.callerDaemonId, grant.callerThreadId).find(row => row.kind === grant.kind
        && row.targetThreadId === grant.targetThreadId && row.targetProjectId === grant.targetProjectId);
      if (existing) return existing;
      this.database.prepare(`INSERT INTO workbench_network_inbound_grants (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        input.id, grant.kind, grant.callerDaemonId, grant.callerThreadId, grant.callerHostname, grant.callerTitle,
        grant.targetThreadId, grant.targetProjectId, grant.targetLabel, input.createdAt,
      );
      return NetworkGrantSchema.parse({ ...grant, id: input.id, createdAt: input.createdAt });
    })();
  }

  revoke(revoke: NetworkGrantRevoke): number {
    return this.database.transaction(() => {
      const doomed = this.forCaller(revoke.callerDaemonId, revoke.callerThreadId)
        .filter(grant => !revoke.need || NetworkGrants.matchesNeed(grant, revoke.need)).map(grant => grant.id);
      const remove = this.database.prepare("DELETE FROM workbench_network_inbound_grants WHERE id = ?");
      return doomed.reduce((count, grantId) => count + remove.run(grantId).changes, 0);
    })();
  }

  /** Every grant naming this daemon's `threadId` as its target, whichever thread holds it. */
  revokeTargeting(threadId: string): number {
    return this.database.prepare("DELETE FROM workbench_network_inbound_grants WHERE target_thread_id = ?").run(threadId).changes;
  }

  private read(statement: string, ...parameters: string[]) {
    return (this.database.prepare(statement).all(...parameters) as GrantRow[]).flatMap(row => {
      const grant = conformToZodSchema(NetworkGrantSchema.nullable(), {
        id: row.id, kind: row.kind, callerDaemonId: row.caller_daemon_id, callerThreadId: row.caller_thread_id,
        callerHostname: row.caller_hostname, callerTitle: row.caller_title, targetThreadId: row.target_thread_id,
        targetProjectId: row.target_project_id, targetLabel: row.target_label, createdAt: row.created_at,
      }, null).data;
      return grant ? [grant] : [];
    });
  }
}
