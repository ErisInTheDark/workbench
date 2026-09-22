/*
 * Exports:
 * - default WorkbenchTranscriptTimestampRepair: back up and correct proven Codex turn timestamp unit errors before reads.
 */
import path from "node:path";
import type Database from "better-sqlite3";
import { preserveWorkbenchDatabaseBackup } from "workbench-shared/database/workbench-database-migration";

const earliestMs = BigInt(Date.UTC(2000, 0, 1));
const latestMs = BigInt(Date.UTC(2100, 0, 1));

interface TurnTiming {
  id: string;
  started_at: bigint | null;
  ended_at: bigint | null;
}

function correctTimestamp(value: bigint | null) {
  if (value === null || (value >= earliestMs && value < latestMs)) return { value, changed: false, valid: true };
  for (const divisor of [BigInt(1_000), BigInt(1_000_000)]) {
    const corrected = value / divisor;
    if (value % divisor === BigInt(0) && corrected >= earliestMs && corrected < latestMs) {
      return { value: corrected, changed: true, valid: true };
    }
  }
  return { value, changed: false, valid: false };
}

export default class WorkbenchTranscriptTimestampRepair {
  constructor(private readonly database: Database.Database) {}

  async run(beforeConversion?: (backupPath: string) => Promise<void> | void) {
    const turns = this.database.prepare(`
      SELECT id, started_at, ended_at FROM thread_turns
      WHERE harness_id = 'codex' AND (started_at >= ? OR ended_at >= ?)
    `).safeIntegers().all(latestMs, latestMs) as TurnTiming[];
    const repairs: Array<{ id: string; startedAt: bigint | null; endedAt: bigint | null }> = [];
    let skipped = 0;
    for (const turn of turns) {
      const startedAt = correctTimestamp(turn.started_at);
      const endedAt = correctTimestamp(turn.ended_at);
      if (!startedAt.valid || !endedAt.valid || (!startedAt.changed && !endedAt.changed)
        || (startedAt.value !== null && endedAt.value !== null && endedAt.value < startedAt.value)) {
        skipped++;
        continue;
      }
      repairs.push({ id: turn.id, startedAt: startedAt.value, endedAt: endedAt.value });
    }
    if (!repairs.length) {
      if (skipped && !this.database.memory) console.warn(`[database] transcript timestamp repair skipped ${skipped} ambiguous Codex turns.`);
      return { repaired: 0, skipped };
    }
    if (!this.database.memory) {
      const backupPath = await preserveWorkbenchDatabaseBackup(this.database,
        path.join(path.dirname(this.database.name), "backups", path.basename(this.database.name)));
      await beforeConversion?.(backupPath);
    }
    const update = this.database.prepare("UPDATE thread_turns SET started_at = ?, ended_at = ? WHERE id = ?");
    this.database.transaction(() => {
      for (const repair of repairs) update.run(repair.startedAt, repair.endedAt, repair.id);
    })();
    if (!this.database.memory) {
      console.info(`[database] transcript timestamp repair corrected ${repairs.length} Codex turns.`);
      if (skipped) console.warn(`[database] transcript timestamp repair skipped ${skipped} ambiguous Codex turns.`);
    }
    return { repaired: repairs.length, skipped };
  }
}
