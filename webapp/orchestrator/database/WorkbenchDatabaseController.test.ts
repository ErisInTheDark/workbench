/*
 * No production exports. Node tests protect the native worker lifecycle, exact schema inventory, and relational discriminator constraints. Keywords: database, worker, schema, test.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import Database from "better-sqlite3";

import WorkbenchDatabaseController from "./WorkbenchDatabaseController";
import {
  installWorkbenchDatabaseSchema,
  WORKBENCH_DATABASE_SCHEMA_VERSION,
  WORKBENCH_DATABASE_TABLE_NAMES,
} from "./workbench-database-schema";

test("the database worker opens, proves readiness, reports all tables, and closes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-database-"));
  const databasePath = join(directory, "workbench.sqlite3");
  const controller = new WorkbenchDatabaseController({ databasePath });
  let reopened: WorkbenchDatabaseController | null = null;
  try {
    const [inventory, coalescedInventory, implicitInventory] = await Promise.all([
      controller.start(),
      controller.start(),
      controller.getInventory(),
    ]);
    assert.equal(controller.state, "ready");
    assert.deepEqual(inventory.tableNames, [...WORKBENCH_DATABASE_TABLE_NAMES].sort());
    assert.equal(inventory.schemaVersion, WORKBENCH_DATABASE_SCHEMA_VERSION);
    assert.deepEqual(coalescedInventory, inventory);
    assert.deepEqual(implicitInventory, inventory);
    await controller.close();
    assert.equal(controller.state, "closed");
    await assert.rejects(controller.start(), /closed/);
    await assert.rejects(controller.getInventory(), /closed/);

    const inspection = new Database(databasePath);
    try {
      assert.equal(inspection.pragma("journal_mode", { simple: true }), "wal");
      assert.equal(inspection.pragma("user_version", { simple: true }), WORKBENCH_DATABASE_SCHEMA_VERSION);
      const readinessRows = inspection.prepare(
        "SELECT COUNT(*) AS count FROM workbench_harnesses WHERE id LIKE 'workbench-readiness-%'",
      ).get() as { count: number };
      assert.equal(readinessRows.count, 0);
    } finally {
      inspection.close();
    }

    reopened = new WorkbenchDatabaseController({ databasePath });
    assert.deepEqual(await reopened.getInventory(), inventory);
    await reopened.close();
  } finally {
    await reopened?.close();
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("schema constraints reject invalid thread state and mismatched item augmentations", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database);
    assert.throws(() => database.prepare(`
      INSERT INTO workbench_threads(
        id,project_id,project_root,title,archived,pinned,snoozed,transcript_content_version,
        next_turn_index,next_item_index,created_at,updated_at,activity_at
      ) VALUES ('thread','project','C:/project','title',1,1,0,1,0,0,1,1,1)
    `).run(), /CHECK constraint failed/);

    database.prepare("INSERT INTO workbench_harnesses(id) VALUES ('codex')").run();
    database.prepare(`
      INSERT INTO workbench_threads(
        id,project_id,project_root,title,transcript_content_version,created_at,updated_at,activity_at
      ) VALUES ('thread','project','C:/project','title',1,1,1,1)
    `).run();
    database.prepare(`
      INSERT INTO thread_turns(
        id,thread_id,turn_index,harness_id,native_location,native_thread_id,state,created_at,started_at
      ) VALUES ('turn','thread',0,'codex','C:/project','native','inProgress',1,1)
    `).run();
    database.prepare(`
      INSERT INTO thread_items(id,thread_id,turn_id,item_index,type,created_at,updated_at)
      VALUES ('item','thread','turn',0,'plan',1,1)
    `).run();
    assert.throws(
      () => database.prepare("INSERT INTO thread_item_assistant_messages(item_id,state,phase,text) VALUES ('item','completed','commentary','nope')").run(),
      /FOREIGN KEY constraint failed/,
    );

    database.prepare(`
      INSERT INTO thread_items(id,thread_id,turn_id,item_index,type,created_at,updated_at)
      VALUES ('operation','thread','turn',1,'operation',1,1)
    `).run();
    database.prepare("INSERT INTO thread_item_operations(item_id,source_kind,source_revision) VALUES ('operation','tool',2)").run();
    assert.throws(() => database.prepare(`
      INSERT INTO thread_operation_presentations(
        item_id,source_revision,presentation_type,presentation_revision,projector_id,projection_digest,projected_at
      ) VALUES ('operation',1,'hidden',1,'test','digest',1)
    `).run(), /FOREIGN KEY constraint failed/);

    database.prepare(`
      INSERT INTO thread_operation_tool_sources(item_id,source_revision,tool_kind,state,tool_name)
      VALUES ('operation',2,'callable','completed','test')
    `).run();
    assert.throws(() => database.prepare(`
      INSERT INTO thread_operation_callable_tool_sources(
        item_id,source_revision,state,tool_name,callable_kind,server_name,arguments_json
      ) VALUES ('operation',2,'completed','test','dynamic','mcp-only','{}')
    `).run(), /CHECK constraint failed/);
  } finally {
    database.close();
  }
});

test("startup failure is permanent until the controller is replaced", async () => {
  const missingParent = `missing-workbench-parent-${process.pid}-${Date.now()}`;
  const controller = new WorkbenchDatabaseController({ databasePath: join(tmpdir(), missingParent, "workbench.sqlite3") });
  await assert.rejects(controller.start(), /directory does not exist|unable to open database/i);
  assert.equal(controller.state, "failed");
  await assert.rejects(controller.start(), /directory does not exist|unable to open database/i);
  await controller.close();
  assert.equal(controller.state, "closed");
});
