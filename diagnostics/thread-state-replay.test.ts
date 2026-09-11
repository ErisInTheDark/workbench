/*
 * No exports. Explicit non-paid replay upgrades only a private backup of the selected database.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { installWorkbenchDatabaseSchema } from "../daemon/orchestrator/database/workbench-database-schema";
import WorkbenchThreadIdentityRepository from "../daemon/orchestrator/database/thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchTranscriptRepository from "../daemon/orchestrator/database/transcript/WorkbenchTranscriptRepository";
import { projectWorkbenchTranscript } from "../shared/workbench/transcript/workbench-transcript-projection";
import { ProjectIdSchema, ThreadReferenceSchema } from "../shared/workbench/identity";

const input = process.env.WORKBENCH_REPLAY_DATABASE;

test("retained database upgrades and resolves existing identities without modifying its source", {
  skip: !input,
}, async () => {
  assert.ok(input);
  const sourcePath = await fs.realpath(input);
  const workspace = path.resolve(process.cwd(), "..");
  const recoveryRoot = path.join(workspace, ".workbench", "recovery");
  const relative = path.relative(recoveryRoot, sourcePath);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    "Replay accepts a preserved recovery snapshot, never the live database");
  const digest = async () => {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(sourcePath)) hash.update(chunk);
    return hash.digest("hex");
  };
  const before = await digest();
  const output = path.join(workspace, ".workbench", "diagnostics", `state-replay-${randomUUID()}`);
  await fs.mkdir(output, { recursive: true });
  const target = path.join(output, "candidate.sqlite3");
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(target);
  } finally {
    source.close();
  }
  let database: Database.Database | null = new Database(target, { fileMustExist: true });
  const report: { stage: string; source: string; output: string; resolved: number; projected: number; metadataOnly: number; error?: string } = {
    stage: "copied", source: sourcePath, output, resolved: 0, projected: 0, metadataOnly: 0,
  };
  try {
    database.pragma("foreign_keys = ON");
    report.stage = "schema upgrade";
    installWorkbenchDatabaseSchema(database);
    assert.deepEqual(database.pragma("integrity_check"), [{ integrity_check: "ok" }]);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    const repository = new WorkbenchThreadIdentityRepository(database);
    report.stage = "cold identity admission";
    repository.list();
    const references = database.prepare("SELECT id, project_id FROM workbench_threads ORDER BY id")
      .all() as Array<{ id: string; project_id: string }>;
    const admitted = [];
    for (const row of references) {
      const identity = repository.resolve({ threadId: ThreadReferenceSchema.parse(row.id), projectId: ProjectIdSchema.parse(row.project_id) });
      assert.ok(identity, "Every retained thread must retain its canonical identity");
      assert.equal(identity.projectId, row.project_id);
      admitted.push({ reference: row.id, projectId: row.project_id, threadId: identity.threadId });
      report.resolved++;
    }
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    database.close();
    database = new Database(target, { fileMustExist: true });
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database);
    const reopened = new WorkbenchThreadIdentityRepository(database);
    reopened.list();
    report.stage = "cold reopen";
    for (const row of admitted) {
      assert.equal(reopened.resolve({ threadId: row.reference, projectId: row.projectId })?.threadId, row.threadId);
    }
    report.stage = "retained transcript projection";
    const transcripts = new WorkbenchTranscriptRepository(database);
    for (const row of admitted) {
      const materialized = database.prepare(`
        SELECT t.id FROM thread_turns t JOIN thread_turn_materializations m ON m.turn_id = t.id
        WHERE t.thread_id = ? ORDER BY t.turn_index DESC LIMIT 1
      `).get(row.threadId) as { id: string } | undefined;
      if (!materialized) {
        report.metadataOnly++;
        continue;
      }
      const snapshot = transcripts.read({ threadId: row.threadId, turnLimit: 1, turnIds: [materialized.id] });
      assert.ok(snapshot, `Retained transcript root missing for ${row.threadId}`);
      const projection = projectWorkbenchTranscript(snapshot);
      assert.ok(projection.success, `Retained transcript cannot project for ${row.threadId}`);
      report.projected++;
    }
    assert.deepEqual(database.pragma("integrity_check"), [{ integrity_check: "ok" }]);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    report.stage = "passed";
  } catch (error) {
    report.error = error instanceof Error ? error.stack ?? error.message : String(error);
    throw error;
  } finally {
    database?.close();
    await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    assert.equal(await digest(), before, "The preserved source must remain byte-identical");
    console.log(`Retained-data replay evidence: ${output}`);
  }
});
