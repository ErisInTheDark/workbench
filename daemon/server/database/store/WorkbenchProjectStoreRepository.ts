/*
 * Exports:
 * - ProjectStoreSealedEntry: one encrypted entry as stored; never plaintext.
 * - ProjectStoreCommand: list, get, or transactionally apply encrypted entry changes for one project.
 * - ProjectStoreResult: entries, one optional entry, or the applied change count.
 * - default WorkbenchProjectStoreRepository: worker-side SQL owner for encrypted project store rows.
 */
import type Database from "better-sqlite3";

export interface ProjectStoreSealedEntry {
  key: string;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

export type ProjectStoreCommand =
  | { kind: "list"; projectId: string }
  | { kind: "get"; projectId: string; key: string }
  | { kind: "apply"; projectId: string; upserts: readonly ProjectStoreSealedEntry[]; removals: readonly string[]; now: number };

export type ProjectStoreResult =
  | { kind: "entries"; entries: ProjectStoreSealedEntry[] }
  | { kind: "entry"; entry: ProjectStoreSealedEntry | null }
  | { kind: "applied"; changes: number };

type Row = { key: string; nonce: Buffer; ciphertext: Buffer };

function sealed(row: Row): ProjectStoreSealedEntry {
  return { key: row.key, nonce: row.nonce, ciphertext: row.ciphertext };
}

export default class WorkbenchProjectStoreRepository {
  constructor(private readonly database: Database.Database) {}

  execute(command: ProjectStoreCommand): ProjectStoreResult {
    if (command.kind === "list") {
      const rows = this.database.prepare(`SELECT key, nonce, ciphertext FROM workbench_project_store_entries
        WHERE project_id = ? ORDER BY key`).all(command.projectId) as Row[];
      return { kind: "entries", entries: rows.map(sealed) };
    }
    if (command.kind === "get") {
      const row = this.database.prepare(`SELECT key, nonce, ciphertext FROM workbench_project_store_entries
        WHERE project_id = ? AND key = ?`).get(command.projectId, command.key) as Row | undefined;
      return { kind: "entry", entry: row ? sealed(row) : null };
    }
    return this.database.transaction((): ProjectStoreResult => {
      let changes = 0;
      const remove = this.database.prepare("DELETE FROM workbench_project_store_entries WHERE project_id = ? AND key = ?");
      for (const key of command.removals) changes += remove.run(command.projectId, key).changes;
      const upsert = this.database.prepare(`INSERT INTO workbench_project_store_entries(project_id, key, nonce, ciphertext, updated_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, key) DO UPDATE SET
        nonce = excluded.nonce, ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`);
      for (const entry of command.upserts) {
        changes += upsert.run(command.projectId, entry.key, Buffer.from(entry.nonce), Buffer.from(entry.ciphertext), command.now).changes;
      }
      return { kind: "applied", changes };
    })();
  }
}
