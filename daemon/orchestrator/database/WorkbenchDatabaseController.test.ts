/*
 * No production exports. Node tests protect the native worker lifecycle, exact schema inventory, transcript materialization, search, and relational discriminator constraints. Keywords: database, worker, schema, transcript, search, test.
 */
import assert from "node:assert/strict";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import Database from "better-sqlite3";

import WorkbenchDatabaseController, { WorkbenchDatabaseRequestFailure } from "./WorkbenchDatabaseController";
import {
  coreTables,
  installWorkbenchDatabaseSchema,
  threadStateTables,
  WORKBENCH_DATABASE_SCHEMA_VERSION,
  WORKBENCH_DATABASE_TABLE_NAMES,
} from "./workbench-database-schema";
import { insertRow, selectRows, upsertRow } from "workbench-shared/database/workbench-database-statements";

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
    const releasedDatabasePath = `${databasePath}.released`;
    await rename(databasePath, releasedDatabasePath);
    await rename(releasedDatabasePath, databasePath);

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

test("schema version 4 thread-state rows migrate into the scoped relationship model", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    database.exec(`
      CREATE TABLE workbench_thread_state_projection_status (
        id INTEGER PRIMARY KEY,
        generation INTEGER NOT NULL,
        state TEXT NOT NULL,
        source_project_count INTEGER NOT NULL,
        source_project_updated_at INTEGER NOT NULL,
        source_subagent_parent_count INTEGER NOT NULL,
        source_subagent_count INTEGER NOT NULL,
        source_digest TEXT NOT NULL,
        projected_thread_count INTEGER NOT NULL,
        projected_subagent_count INTEGER NOT NULL,
        mismatch_count INTEGER NOT NULL,
        completed_at INTEGER,
        error_text TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE workbench_thread_state_threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        thread_kind TEXT NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'placeholder',
        title TEXT NOT NULL,
        archived INTEGER NOT NULL,
        pinned INTEGER NOT NULL,
        snoozed INTEGER NOT NULL,
        provider_observed INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        activity_at INTEGER NOT NULL,
        order_at INTEGER,
        UNIQUE (id, thread_kind)
      );
      CREATE TABLE workbench_thread_state_provider_identities (
        thread_id TEXT PRIMARY KEY REFERENCES workbench_thread_state_threads(id) ON DELETE CASCADE,
        harness_id TEXT NOT NULL,
        provider_thread_id TEXT NOT NULL,
        UNIQUE (harness_id, provider_thread_id)
      );
      CREATE TABLE workbench_thread_state_subagents (
        thread_id TEXT PRIMARY KEY,
        thread_kind TEXT NOT NULL DEFAULT 'subagent',
        parent_thread_id TEXT NOT NULL REFERENCES workbench_thread_state_threads(id),
        cwd TEXT NOT NULL,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        profile_name TEXT NOT NULL,
        direct_subagent_index INTEGER NOT NULL,
        FOREIGN KEY (thread_id, thread_kind)
          REFERENCES workbench_thread_state_threads(id, thread_kind) ON DELETE CASCADE,
        UNIQUE (parent_thread_id, direct_subagent_index),
        UNIQUE (parent_thread_id, name_key)
      );
    `);
    database.prepare(`
      INSERT INTO workbench_thread_state_projection_status(
        id, generation, state, source_project_count, source_project_updated_at,
        source_subagent_parent_count, source_subagent_count, source_digest,
        projected_thread_count, projected_subagent_count, mismatch_count,
        completed_at, error_text, updated_at
      ) VALUES (1, 4, 'failed', 1, 10, 1, 1, ?, 2, 1, 0, NULL, 'Legacy failure', 10)
    `).run("a".repeat(64));
    database.exec(`
      INSERT INTO workbench_thread_state_threads VALUES
        ('parent', 'project', 'topLevel', 'visible', 'Parent', 0, 0, 0, 1, 1, 2, 2, NULL),
        ('historical-child', 'project', 'subagent', 'visible', 'Child', 0, 0, 0, 1, 1, 2, 2, NULL);
      INSERT INTO workbench_thread_state_provider_identities
        VALUES ('historical-child', 'codex', 'historical-child');
      INSERT INTO workbench_thread_state_subagents
        VALUES ('historical-child', 'subagent', 'parent', 'C:/project', 'child', 'child', 'profile', 'Profile', 0);
      PRAGMA user_version = 4;
    `);

    installWorkbenchDatabaseSchema(database);

    assert.equal(database.pragma("user_version", { simple: true }), WORKBENCH_DATABASE_SCHEMA_VERSION);
    assert.deepEqual(database.prepare(`
      SELECT project_id, provider_thread_id
      FROM workbench_thread_state_provider_identities
    `).get(), { project_id: "project", provider_thread_id: "historical-child" });
    assert.deepEqual(database.prepare(`
      SELECT error_code, error_text
      FROM workbench_thread_state_projection_status
    `).get(), { error_code: "projection-failure", error_text: "Legacy failure" });
    assert.doesNotThrow(() => database.exec(`
      INSERT INTO workbench_thread_state_threads VALUES
        ('replacement-child', 'project', 'subagent', 'visible', 'Replacement', 0, 0, 0, 1, 3, 4, 4, NULL);
      INSERT INTO workbench_thread_state_subagents
        VALUES ('replacement-child', 'subagent', 'parent', 'C:/project', 'child', 'child', 'profile', 'Profile', 0);
    `));
    assert.equal((database.prepare(`
      SELECT COUNT(*) count
      FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'workbench_thread_state_%_subagent_relationships'
    `).get() as { count: number }).count, 2);
  } finally {
    database.close();
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
        next_turn_index,created_at,updated_at,activity_at
      ) VALUES ('thread','project','C:/project','title',1,1,0,1,0,1,1,1)
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
      INSERT INTO thread_turns(
        id,thread_id,turn_index,harness_id,native_location,native_thread_id,state,created_at
      ) VALUES ('terminal-without-provider-times','thread',1,'codex','C:/project','native','completed',1)
    `).run();
    const itemId = Number(database.prepare(`
      INSERT INTO thread_items(source_id,thread_id,turn_id,item_position,type,created_at,updated_at)
      VALUES ('item','thread','turn',0,'plan',1,1)
    `).run().lastInsertRowid);
    assert.throws(
      () => database.prepare("INSERT INTO thread_item_assistant_messages(item_id,state,phase,text) VALUES (?,'completed','commentary','nope')").run(itemId),
      /FOREIGN KEY constraint failed/,
    );

    const operationId = Number(database.prepare(`
      INSERT INTO thread_items(source_id,thread_id,turn_id,item_position,type,created_at,updated_at)
      VALUES ('operation','thread','turn',1,'operation',1,1)
    `).run().lastInsertRowid);
    database.prepare("INSERT INTO thread_item_operations(item_id,source_kind,source_revision) VALUES (?,'tool',2)").run(operationId);
    assert.throws(() => database.prepare(`
      INSERT INTO thread_operation_tool_sources(item_id,source_revision,tool_kind,state,tool_name)
      VALUES (?,1,'callable','completed','test')
    `).run(operationId), /FOREIGN KEY constraint failed/);

    database.prepare(`
      INSERT INTO thread_operation_tool_sources(item_id,source_revision,tool_kind,state,tool_name)
      VALUES (?,2,'callable','completed','test')
    `).run(operationId);
    assert.throws(() => database.prepare(`
      INSERT INTO thread_operation_callable_tool_sources(
        item_id,source_revision,state,tool_name,callable_kind,server_name,arguments_json
      ) VALUES (?,2,'completed','test','dynamic','mcp-only','{}')
    `).run(operationId), /CHECK constraint failed/);

    const processId = Number(database.prepare(`
      INSERT INTO thread_items(source_id,thread_id,turn_id,item_position,type,created_at,updated_at)
      VALUES ('process','thread','turn',2,'operation',1,1)
    `).run().lastInsertRowid);
    database.prepare("INSERT INTO thread_item_operations(item_id,source_kind,source_revision) VALUES (?,'process',0)").run(processId);
    database.prepare(`
      INSERT INTO thread_operation_process_sources(item_id,source_revision,state,command,cwd)
      VALUES (?,0,'completed','cat file','C:/project')
    `).run(processId);
    assert.throws(() => database.prepare(`
      INSERT INTO thread_process_command_actions(item_id,action_index,action_kind,command,name,path,query)
      VALUES (?,0,'read','cat file',NULL,NULL,'illegal')
    `).run(processId), /CHECK constraint failed/);
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

test("an unstarted database controller closes without initializing its worker", async () => {
  const controller = new WorkbenchDatabaseController({
    databasePath: join(tmpdir(), `workbench-database-never-opened-${process.pid}-${Date.now()}.sqlite3`),
  });
  await controller.close();
  assert.equal(controller.state, "closed");
  await assert.rejects(controller.start(), /closed/u);
});

test("typed statement transactions preserve stable rows and roll back incomplete domain writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-database-statements-"));
  const controller = new WorkbenchDatabaseController({ databasePath: join(directory, "workbench.sqlite3") });
  try {
    await controller.executeTransaction([
      insertRow(coreTables.workbenchHarnesses, { id: "codex" }),
      insertRow(coreTables.workbenchHarnesses, { id: "opencode2" }),
    ]);
    assert.deepEqual(
      await controller.query(selectRows(coreTables.workbenchHarnesses, {
        orderBy: [{ column: "id" }],
      })),
      [{ id: "codex" }, { id: "opencode2" }],
    );

    const thread = {
      id: "thread",
      project_id: "project",
      project_root: "C:/project",
      title: "first",
      transcript_content_version: 1,
      created_at: 1,
      updated_at: 1,
      activity_at: 1,
    } as const;
    await controller.executeTransaction([insertRow(coreTables.workbenchThreads, thread)]);
    await controller.executeTransaction([
      upsertRow(coreTables.workbenchThreads, {
        ...thread,
        title: "renamed",
        updated_at: 2,
      }, {
        conflictColumns: ["id"],
        updateColumns: ["title", "updated_at"],
      }),
    ]);
    assert.deepEqual(
      await controller.query(selectRows(coreTables.workbenchThreads, { where: { id: "thread" } })),
      [{
        id: "thread",
        project_id: "project",
        project_root: "C:/project",
        title: "renamed",
        archived: 0,
        pinned: 0,
        snoozed: 0,
        transcript_content_version: 1,
        next_turn_index: 0,
        created_at: 1,
        updated_at: 2,
        activity_at: 1,
      }],
    );

    await assert.rejects(controller.executeTransaction([
      insertRow(coreTables.workbenchPendingImportThreads, {
        thread_id: "thread",
        harness_id: "codex",
        native_location: "C:/project",
        native_thread_id: "native",
        discovered_at: 2,
        last_seen_at: 2,
      }),
      insertRow(coreTables.workbenchPendingImportThreads, {
        thread_id: "missing-thread",
        harness_id: "codex",
        native_location: "C:/project",
        native_thread_id: "other-native",
        discovered_at: 2,
        last_seen_at: 2,
      }),
    ]), (error) => error instanceof WorkbenchDatabaseRequestFailure && /FOREIGN KEY constraint failed/.test(error.message));
    assert.equal(controller.state, "ready");
    assert.doesNotThrow(() => controller.assertReady());
    assert.deepEqual(
      await controller.query(selectRows(coreTables.workbenchPendingImportThreads)),
      [],
    );
    assert.deepEqual((await controller.getInventory()).tableNames, [...WORKBENCH_DATABASE_TABLE_NAMES].sort());
  } finally {
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("workspace search ranks relational sources and keeps settled transcript bodies asleep", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-database-search-"));
  const controller = new WorkbenchDatabaseController({ databasePath: join(directory, "workbench.sqlite3") });
  try {
    const observations = [
      {
        kind: "thread" as const,
        threadId: "active-thread",
        projectId: "project",
        projectRoot: "C:/project",
        title: "Active search thread",
        createdAt: 1,
        updatedAt: 10,
        activityAt: 10,
      },
      {
        kind: "turn" as const,
        threadId: "active-thread",
        turnId: "active-turn",
        turnIndex: 0,
        harnessId: "codex",
        nativeLocation: "C:/project",
        nativeThreadId: "active-native",
        nativeTurnId: "active-turn",
        state: "completed" as const,
        createdAt: 1,
        startedAt: 1,
        endedAt: 2,
        durationMs: 1,
      },
      {
        kind: "item" as const,
        threadId: "active-thread",
        turnId: "active-turn",
        lifecycle: "completed" as const,
        observedAt: 2,
        item: {
          clientId: "active-user",
          content: [{ text: "midvalue narwhal", text_elements: [], type: "text" as const }],
          id: "active-user",
          type: "userMessage" as const,
        },
      },
      {
        kind: "item" as const,
        threadId: "active-thread",
        turnId: "active-turn",
        lifecycle: "completed" as const,
        observedAt: 3,
        item: {
          id: "active-commentary",
          memoryCitation: null,
          phase: "commentary" as const,
          text: "lowvalue comet",
          type: "agentMessage" as const,
        },
      },
      {
        kind: "item" as const,
        threadId: "active-thread",
        turnId: "active-turn",
        lifecycle: "completed" as const,
        observedAt: 4,
        item: {
          id: "active-final",
          memoryCitation: null,
          phase: "final_answer" as const,
          text: "finalsecret",
          type: "agentMessage" as const,
        },
      },
      {
        kind: "thread" as const,
        threadId: "settled-thread",
        projectId: "project",
        projectRoot: "C:/project",
        title: "Settled archive",
        createdAt: 1,
        updatedAt: 9,
        activityAt: 9,
      },
      {
        kind: "turn" as const,
        threadId: "settled-thread",
        turnId: "settled-turn",
        turnIndex: 0,
        harnessId: "codex",
        nativeLocation: "C:/project",
        nativeThreadId: "settled-native",
        nativeTurnId: "settled-turn",
        state: "completed" as const,
        createdAt: 1,
        startedAt: 1,
        endedAt: 2,
        durationMs: 1,
      },
      {
        kind: "item" as const,
        threadId: "settled-thread",
        turnId: "settled-turn",
        lifecycle: "completed" as const,
        observedAt: 2,
        item: {
          clientId: "settled-user",
          content: [{ text: "sleepyhidden badger", text_elements: [], type: "text" as const }],
          id: "settled-user",
          type: "userMessage" as const,
        },
      },
      {
        kind: "item" as const,
        threadId: "settled-thread",
        turnId: "settled-turn",
        lifecycle: "completed" as const,
        observedAt: 3,
        item: {
          id: "settled-commentary",
          memoryCitation: null,
          phase: "commentary" as const,
          text: "sleepyhidden otter",
          type: "agentMessage" as const,
        },
      },
    ];
    await controller.settleTranscript([
      {
        kind: "canonicalWindow",
        contentVersion: 3,
        materializedTurnIds: ["active-turn"],
        observations: observations.filter((observation) => observation.threadId === "active-thread"),
        threadId: "active-thread",
      },
      {
        kind: "canonicalWindow",
        contentVersion: 3,
        materializedTurnIds: ["settled-turn"],
        observations: observations.filter((observation) => observation.threadId === "settled-thread"),
        threadId: "settled-thread",
      },
    ]);
    await controller.executeTransaction([
      insertRow(coreTables.workbenchThreadLifecycle, {
        agent_status: "completed",
        lifecycle_kind: "completed",
        reason: "agentCompleted",
        request_key: null,
        settled: 0,
        thread_id: "active-thread",
        turn_id: "active-turn",
        updated_at: 10,
      }),
      insertRow(coreTables.workbenchThreadLifecycle, {
        agent_status: "completed",
        lifecycle_kind: "completed",
        reason: "agentCompleted",
        request_key: null,
        settled: 1,
        thread_id: "settled-thread",
        turn_id: "settled-turn",
        updated_at: 9,
      }),
    ]);
    await controller.replaceSearchProjects([
      { id: "project", name: "Project", rootPath: "C:/project" },
      { id: "other", name: "Other project", rootPath: "C:/other" },
    ]);
    await controller.replaceSearchProjectFiles("project", ["src/lowestvalue-needle.ts"]);
    await controller.replaceSearchProjectFiles("other", ["src/other-only.ts"]);

    assert.equal((await controller.search({ projectId: "project", query: "search" })).results[0]?.title, "Active search thread");
    assert.equal((await controller.search({ projectId: "project", query: "narwhal" })).results[0]?.title, "Active search thread");
    assert.equal((await controller.search({ projectId: "project", query: "comet" })).results[0]?.title, "Active search thread");
    assert.equal((await controller.search({ projectId: "project", query: "settled archive" })).results[0]?.title, "Settled archive");
    assert.deepEqual((await controller.search({ projectId: "project", query: "sleepyhidden" })).results, []);
    assert.deepEqual((await controller.search({ projectId: "project", query: "finalsecret" })).results, []);
    assert.equal((await controller.search({ projectId: "project", query: "\"lowestvalue\"" })).results[0]?.kind, "file");
    assert.deepEqual((await controller.search({ projectId: "project", query: "other-only" })).results, []);
  } finally {
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("shadow projection failures stay request-scoped and leave durable health", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-database-shadow-"));
  const controller = new WorkbenchDatabaseController({ databasePath: join(directory, "workbench.sqlite3") });
  try {
    const complete = await controller.rebuildThreadStateShadow({ now: 10, parents: [] });
    assert.equal(complete.state, "complete");
    assert.match(complete.sourceDigest, /^[0-9a-f]{64}$/u);

    await controller.executeTransaction([
      insertRow(threadStateTables.workbenchThreadStateProjects, {
        project_id: "project",
        document_json: JSON.stringify({ drafts: [], newThreadProfile: null, records: [{}], version: 4 }),
        updated_at: 11,
      }),
    ]);
    const failed = await controller.rebuildThreadStateShadow({ now: 12, parents: [] });
    assert.equal(controller.state, "ready");
    assert.doesNotThrow(() => controller.assertReady());

    assert.equal(failed.state, "failed");
    assert.equal(failed.sourceProjectCount, 1);
    assert.equal(failed.errorCode, "projection-failure");
    assert.equal(failed.errorText, "Thread-state projection failed: unexpected projector failure.");
    assert.deepEqual(await controller.readThreadStateShadowStatus(), failed);
  } finally {
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("terminal transcript turns may preserve missing native timestamps without poisoning readiness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-database-native-turns-"));
  const controller = new WorkbenchDatabaseController({ databasePath: join(directory, "workbench.sqlite3") });
  try {
    assert.deepEqual(
      await controller.readTranscriptMaterializedTurnIds("thread", ["turn", "missing"]),
      [],
    );
    await controller.settleTranscript([{
      kind: "canonicalWindow",
      contentVersion: 3,
      materializedTurnIds: ["turn"],
      threadId: "thread",
      observations: [
      {
        kind: "thread",
        threadId: "thread",
        projectId: "project",
        projectRoot: "C:/project",
        title: "Thread",
        createdAt: 1,
        updatedAt: 1,
        activityAt: 1,
      },
      {
        kind: "turn",
        threadId: "thread",
        turnId: "turn",
        turnIndex: 0,
        harnessId: "codex",
        nativeLocation: "C:/project",
        nativeThreadId: "thread",
        nativeTurnId: "turn",
        state: "completed",
        createdAt: 1,
        startedAt: null,
        endedAt: null,
        durationMs: null,
      },
      ],
    }]);
    assert.equal(controller.state, "ready");
    assert.deepEqual(
      await controller.readTranscriptMaterializedTurnIds("thread", ["missing", "turn", "turn"]),
      ["turn"],
    );
    assert.deepEqual(
      (await controller.readTranscript({ threadId: "thread", turnLimit: 1 }))?.turns.map((turn) => ({
        state: turn.state,
        started_at: turn.started_at,
        ended_at: turn.ended_at,
      })),
      [{ state: "completed", started_at: null, ended_at: null }],
    );
  } finally {
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  }
});
