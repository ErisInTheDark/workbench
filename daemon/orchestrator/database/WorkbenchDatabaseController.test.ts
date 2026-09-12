/*
 * No production exports. Node tests protect the native worker lifecycle, exact schema inventory, transcript materialization, search, and relational discriminator constraints.
 */
import assert from "node:assert/strict";
import databaseReleases from "workbench-shared/workbench/database/schema/releases";
import { mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captureTestOutput } from "../../../test/capture-test-output.mts";

import Database from "better-sqlite3";

import WorkbenchTranscriptRepository from "./transcript/WorkbenchTranscriptRepository";
import WorkbenchDatabaseController, { WorkbenchDatabaseRequestFailure } from "./WorkbenchDatabaseController";
import {
  coreTables,
  installWorkbenchDatabaseSchema,
  WORKBENCH_DATABASE_SCHEMA_VERSION,
  WORKBENCH_DATABASE_TABLE_NAMES,
} from "./workbench-database-schema";
import { insertRow, selectRows, upsertRow } from "workbench-shared/database/workbench-database-statements";
import { WorkbenchStatsDetailedResponseSchema, legacyStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-detail-contract";
import { preserveWorkbenchDatabaseBackup } from "workbench-shared/database/workbench-database-migration";
import { TranscriptQuerySchema } from "./transcript/transcript-query-contract";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  NativeThreadId: {
    "thread": fixtureIdentitySchemas.NativeThreadIdSchema.parse("thread"),
  },
  NativeTurnId: {
    "turn": fixtureIdentitySchemas.NativeTurnIdSchema.parse("turn"),
  },
  ProjectId: {
    "project": fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  },
  WorkbenchThreadId: {
    "active-thread": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("active-thread"),
    "settled-thread": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("settled-thread"),
    "thread": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"),
    "unadmitted": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("unadmitted"),
  },
  WorkbenchTurnId: {
    "active-turn": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("active-turn"),
    "settled-turn": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("settled-turn"),
    "turn": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn"),
  },
};

function seedProviderCursor(databasePath: string) {
  const database = new Database(databasePath);
  new WorkbenchTranscriptRepository(database).settle([{
    kind: "thread", threadId: fixtureIdentityValues.WorkbenchThreadId.thread,
    projectId: fixtureIdentityValues.ProjectId.project, projectRoot: "/repo",
    title: "", createdAt: 1, updatedAt: 1, activityAt: 1,
  }, {
    kind: "turn", threadId: fixtureIdentityValues.WorkbenchThreadId.thread, turnId: fixtureIdentityValues.WorkbenchTurnId.turn,
    harnessId: "codex", nativeLocation: "/repo", nativeThreadId: fixtureIdentityValues.NativeThreadId.thread,
    nativeTurnId: fixtureIdentityValues.NativeTurnId.turn, state: "completed", createdAt: 1,
    startedAt: 1, endedAt: 2, durationMs: 1,
  }, {
    kind: "providerCursor", threadId: fixtureIdentityValues.WorkbenchThreadId.thread,
    turnId: fixtureIdentityValues.WorkbenchTurnId.turn, previousCursor: "opaque",
  }]);
  database.close();
}

async function checkProviderCursor(controller: WorkbenchDatabaseController) {
  assert.equal(await controller.readTranscriptProviderCursor("thread", "turn"), "opaque");
  assert.equal(await controller.readTranscriptProviderCursor("thread", "missing"), undefined);
  assert.equal((await controller.readTranscriptContext("thread"))?.rows.threadItems.length, 0);
}

async function checkStoredQueries(controller: WorkbenchDatabaseController) {
  const page = await controller.queryTranscript(TranscriptQuerySchema.parse({ action: "stats" }));
  assert.equal(page.coverage.threads, 0);
  await assert.rejects(controller.queryTranscript(TranscriptQuerySchema.parse({ action: "read", threads: ["missing-wb-id"] })), /Unknown Workbench thread/u);
}

test("worker migration waits for its owner to retain the rollback checkpoint", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-migration-ack-"));
  captureTestOutput(context, process.stdout, text => text.startsWith("[database] preserved schema ") && text.includes(directory));
  const databasePath = join(directory, "workbench.sqlite3");
  const version = databaseReleases.nativeIdentityLookupIndexes.version;
  const old = new Database(databasePath);
  installWorkbenchDatabaseSchema(old, { targetVersion: version });
  old.close();
  const options = {
    databasePath,
    beforeMigration: (_backupPath: string) => { throw new Error("rollback checkpoint was not retained"); },
  };
  const controller = new WorkbenchDatabaseController(options);
  try {
    await assert.rejects(controller.start(), /rollback checkpoint was not retained/u);
  } finally {
    await controller.close();
    const inspection = new Database(databasePath, { readonly: true });
    try { assert.equal(inspection.pragma("user_version", { simple: true }), version); }
    finally { inspection.close(); }
    await rm(directory, { recursive: true, force: true });
  }
});

test("worker startup retains its old-schema backup even when closed during opening", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-migration-worker-"));
  captureTestOutput(context, process.stdout, text => text.startsWith("[database] preserved schema ") && text.includes(directory));
  const databasePath = join(directory, "workbench.sqlite3");
  const version = databaseReleases.nativeIdentityLookupIndexes.version;
  const old = new Database(databasePath);
  installWorkbenchDatabaseSchema(old, { targetVersion: version });
  old.exec("CREATE TABLE preserved_extension(value TEXT); INSERT INTO preserved_extension VALUES ('retained')");
  old.close();
  const controller = new WorkbenchDatabaseController({ databasePath });
  try {
    const started = controller.start();
    const closed = controller.close();
    await started;
    await closed;
    const backups = join(directory, "backups", "workbench.sqlite3");
    const files = await readdir(backups).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    assert.equal(files.length, 1, "worker readiness requires a pre-upgrade backup");
    const backup = new Database(join(backups, files[0]!), { readonly: true, fileMustExist: true });
    try {
      assert.equal(backup.pragma("user_version", { simple: true }), version);
      assert.deepEqual(backup.prepare("SELECT value FROM preserved_extension").get(), { value: "retained" });
    } finally {
      backup.close();
    }
  } finally {
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("database lifecycle reuses retained state across cold workers", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-database-"));
  captureTestOutput(context, process.stdout, text => text.startsWith("[database] preserved schema ") && text.includes(directory));
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
    const catalog = ["first", "second"].map((nativeThreadId) => ({
      native: { harness: "codex", nativeLocation: "C:/project", nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse(nativeThreadId) },
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), projectRoot: "C:/project", title: nativeThreadId,
      createdAt: 1, updatedAt: 2, activityAt: 2,
    }));
    const identities = await controller.observeThreadIdentities(catalog);
    assert.equal(identities.length, 2);
    assert.notEqual(identities[0]!.threadId, identities[1]!.threadId);
    assert.deepEqual(await controller.query(selectRows(coreTables.threadTurns)), []);
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

    seedProviderCursor(databasePath);
    reopened = new WorkbenchDatabaseController({ databasePath });
    assert.deepEqual(await reopened.getInventory(), inventory);
    assert.deepEqual(await reopened.observeThreadIdentities(catalog), identities);
    assert.deepEqual(await reopened.resolveNativeThreadIdentity(catalog[0]!.native), identities[0]);
    const retained = reopened;
    await context.test("provider cursor survives first cold reopen", () => checkProviderCursor(retained));
    await context.test("suspension resumes the same worker and queued reads", () => checkSuspension(retained, databasePath));
    await context.test("failed rollback checkpoint can be retried", () => checkRollbackRetry(retained, directory));
    await context.test("rollback restores schema and data before queued reads", () => checkSchemaRollback(retained, directory, databasePath));
    await context.test("retirement releases callers before worker disposal", () => checkRetirement(retained));
    await reopened.close();
    reopened = new WorkbenchDatabaseController({ databasePath });
    const final = reopened;
    await context.test("provider cursor survives second cold reopen", () => checkProviderCursor(final));
    await context.test("close releases suspended queued work", () => checkSuspendedClose(final));
  } finally {
    await reopened?.close();
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function checkSuspension(controller: WorkbenchDatabaseController, databasePath: string) {
  const initial = await controller.start();
  await controller.suspend();
  const queued = controller.getInventory();
  const external = new Database(databasePath);
  external.close();
  await controller.resume();
  assert.deepEqual(await queued, initial);
  assert.deepEqual(await controller.getInventory(), initial);
}

async function checkRetirement(controller: WorkbenchDatabaseController) {
  let queued: Promise<unknown> | undefined;
  try {
    await controller.suspend();
    queued = controller.getInventory();
    void queued.catch(() => {});
    controller.retireSuspendedAdmission();
    await assert.rejects(queued, /retired/u);
    await assert.rejects(controller.getInventory(), /retired/u);
    assert.equal(controller.state, "suspended", "Retirement admission must not prematurely dispose the worker");
  } finally {
    await controller.close();
    await queued?.catch(() => {});
  }
}

async function checkSchemaRollback(controller: WorkbenchDatabaseController, directory: string, databasePath: string) {
  const inventory = await controller.start();
  await controller.suspend();
  const candidate = new Database(databasePath);
  let checkpoint: string;
  try {
    candidate.exec("CREATE TABLE rollback_evidence(legacy TEXT); INSERT INTO rollback_evidence VALUES ('retained')");
    checkpoint = await preserveWorkbenchDatabaseBackup(candidate, join(directory, "rollback"));
    candidate.exec("DROP TABLE rollback_evidence; CREATE TABLE candidate_only(value TEXT)");
    candidate.pragma(`user_version = ${inventory.schemaVersion + 1}`);
  } finally { candidate.close(); }
  const queued = controller.getInventory();
  await controller.resume(checkpoint);
  const restoredInventory = await queued;
  assert.equal(restoredInventory.schemaVersion, inventory.schemaVersion);
  assert.equal(restoredInventory.tableNames.includes("candidate_only"), false);
  const inspection = new Database(databasePath, { readonly: true });
  try {
    assert.deepEqual(inspection.prepare("SELECT legacy FROM rollback_evidence").all(), [{ legacy: "retained" }]);
  } finally { inspection.close(); }
  await controller.suspend();
  await controller.resume();
  assert.deepEqual(await controller.getInventory(), restoredInventory);
}

async function checkSuspendedClose(controller: WorkbenchDatabaseController) {
  await controller.suspend();
  const rejected = assert.rejects(controller.getInventory(), /closed|retired/u);
  await controller.close();
  await rejected;
}

async function checkClaimStats(controller: WorkbenchDatabaseController) {
    const now = Date.UTC(2026, 8, 4, 12);
    await controller.recordStatsClaimSnapshot({
      harness: "codex",
      observedAt: now - 60_000,
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
      roots: [{ paths: ["src"], rootId: "root" }],
      threadId: "thread",
    });
    const result = await controller.readStats({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), range: "7d" }, now);
    assert.equal(result.claimHotspots[0]?.path, "src");
    assert.equal(result.claimHotspots[0]?.threadCount, 1);
    const detailed = WorkbenchStatsDetailedResponseSchema.parse(await controller.readStatsDetailed({
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), range: "7d", tokenTypes: [],
    }, now));
    assert.deepEqual(legacyStatsResponse(detailed), result);
    const claims = await controller.readClaimStats({
      projectId: fixtureIdentityValues.ProjectId["project"], range: "7d", file: { rootId: "root", path: "src" }, page: 1,
    }, now);
    assert.equal(claims.kind, "threads");
    if (claims.kind === "threads") assert.deepEqual(claims.rows.map(({ threadId }) => threadId), ["thread"]);
    const renames = [{ projectId: "project", rootId: "root", from: "src", to: "renamed" }];
    assert.equal((await controller.readStats({ projectId: fixtureIdentityValues.ProjectId["project"], range: "7d" }, now, renames)).claimHotspots[0]?.path, "renamed");
    assert.equal((await controller.readStatsDetailed({ projectId: fixtureIdentityValues.ProjectId["project"], range: "7d" }, now, renames)).claimHotspots[0]?.path, "renamed");
    const renamed = await controller.readClaimStats({
      projectId: fixtureIdentityValues.ProjectId["project"], range: "7d", file: { rootId: "root", path: "renamed" }, page: 1,
    }, now, renames);
    assert.equal(renamed.rows.length, 1);
}

test("schema constraints reject invalid thread state and mismatched item augmentations", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database);
    database.exec(`
      INSERT INTO workbench_thread_state_threads VALUES
        ('parent', 'project', 'topLevel', 'visible', 'Parent', 0, 0, 0, 1, 1, 2, 2, NULL),
        ('historical-child', 'project', 'subagent', 'visible', 'Child', 0, 0, 0, 1, 1, 2, 2, NULL);
      INSERT INTO workbench_thread_state_subagents
        VALUES ('historical-child', 'subagent', 'parent', 'C:/project', 'child', 'child', 'profile', 'Profile', 0);
    `);
    assert.doesNotThrow(() => database.exec(`
      INSERT INTO workbench_thread_state_threads VALUES
        ('replacement-child', 'project', 'subagent', 'visible', 'Replacement', 0, 0, 0, 1, 3, 4, 4, NULL);
      INSERT INTO workbench_thread_state_subagents
        VALUES ('replacement-child', 'subagent', 'parent', 'C:/project', 'child', 'child', 'profile', 'Profile', 0);
    `));
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

test("database requests share one evolving relational fixture", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-database-statements-"));
  const controller = new WorkbenchDatabaseController({ databasePath: join(directory, "workbench.sqlite3") });
  try {
    // Empty-state checks must precede admission; later stages retain earlier rows.
    await context.test("stored queries preserve empty results and invalid-id failures", () => checkStoredQueries(controller));
    await context.test("invalid thread-state commits do not poison readiness", () => checkInvalidThreadState(controller));
    await context.test("claim snapshots return bounded stats and renamed paths", () => checkClaimStats(controller));
    await context.test("typed transactions preserve rows and roll back failed writes", () => checkTransactions(controller));
    await context.test("terminal turns preserve missing timestamps and materialisation", () => checkTerminalTurn(controller));
    await context.test("search ranks relational sources without settled bodies", () => checkWorkspaceSearch(controller));
  } finally {
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function checkTransactions(controller: WorkbenchDatabaseController) {
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
        identity_origin: "legacy",
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
}

async function checkWorkspaceSearch(controller: WorkbenchDatabaseController) {
    const observations = [
      {
        kind: "thread" as const,
        threadId: fixtureIdentityValues.WorkbenchThreadId["active-thread"],
        projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
        projectRoot: "C:/project",
        title: "Active search thread",
        createdAt: 1,
        updatedAt: 10,
        activityAt: 10,
      },
      {
        kind: "turn" as const,
        threadId: fixtureIdentityValues.WorkbenchThreadId["active-thread"],
        turnId: fixtureIdentityValues.WorkbenchTurnId["active-turn"],
        turnIndex: 0,
        harnessId: "codex",
        nativeLocation: "C:/project",
        nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse("active-native"),
        nativeTurnId: fixtureIdentitySchemas.NativeTurnIdSchema.parse("active-turn"),
        state: "completed" as const,
        createdAt: 1,
        startedAt: 1,
        endedAt: 2,
        durationMs: 1,
      },
      {
        kind: "item" as const,
        threadId: fixtureIdentityValues.WorkbenchThreadId["active-thread"],
        turnId: fixtureIdentityValues.WorkbenchTurnId["active-turn"],
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
        threadId: fixtureIdentityValues.WorkbenchThreadId["active-thread"],
        turnId: fixtureIdentityValues.WorkbenchTurnId["active-turn"],
        lifecycle: "completed" as const,
        observedAt: 3,
        item: {
          id: "active-commentary",
          delivery: null,
          questions: null,
          memoryCitation: null,
          phase: "commentary" as const,
          text: "lowvalue comet",
          type: "agentMessage" as const,
        },
      },
      {
        kind: "item" as const,
        threadId: fixtureIdentityValues.WorkbenchThreadId["active-thread"],
        turnId: fixtureIdentityValues.WorkbenchTurnId["active-turn"],
        lifecycle: "completed" as const,
        observedAt: 4,
        item: {
          id: "active-final",
          delivery: null,
          questions: null,
          memoryCitation: null,
          phase: "final_answer" as const,
          text: "finalsecret",
          type: "agentMessage" as const,
        },
      },
      {
        kind: "thread" as const,
        threadId: fixtureIdentityValues.WorkbenchThreadId["settled-thread"],
        projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
        projectRoot: "C:/project",
        title: "Settled archive",
        createdAt: 1,
        updatedAt: 9,
        activityAt: 9,
      },
      {
        kind: "turn" as const,
        threadId: fixtureIdentityValues.WorkbenchThreadId["settled-thread"],
        turnId: fixtureIdentityValues.WorkbenchTurnId["settled-turn"],
        turnIndex: 0,
        harnessId: "codex",
        nativeLocation: "C:/project",
        nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse("settled-native"),
        nativeTurnId: fixtureIdentitySchemas.NativeTurnIdSchema.parse("settled-turn"),
        state: "completed" as const,
        createdAt: 1,
        startedAt: 1,
        endedAt: 2,
        durationMs: 1,
      },
      {
        kind: "item" as const,
        threadId: fixtureIdentityValues.WorkbenchThreadId["settled-thread"],
        turnId: fixtureIdentityValues.WorkbenchTurnId["settled-turn"],
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
        threadId: fixtureIdentityValues.WorkbenchThreadId["settled-thread"],
        turnId: fixtureIdentityValues.WorkbenchTurnId["settled-turn"],
        lifecycle: "completed" as const,
        observedAt: 3,
        item: {
          id: "settled-commentary",
          delivery: null,
          questions: null,
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
        materializedTurnIds: [fixtureIdentityValues.WorkbenchTurnId["active-turn"]],
        observations: observations.filter((observation) => observation.threadId === "active-thread"),
        threadId: fixtureIdentityValues.WorkbenchThreadId["active-thread"],
      },
      {
        kind: "canonicalWindow",
        contentVersion: 3,
        materializedTurnIds: [fixtureIdentityValues.WorkbenchTurnId["settled-turn"]],
        observations: observations.filter((observation) => observation.threadId === "settled-thread"),
        threadId: fixtureIdentityValues.WorkbenchThreadId["settled-thread"],
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

    assert.equal((await controller.search({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), query: "search" })).results[0]?.title, "Active search thread");
    assert.equal((await controller.search({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), query: "narwhal" })).results[0]?.title, "Active search thread");
    assert.equal((await controller.search({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), query: "comet" })).results[0]?.title, "Active search thread");
    assert.equal((await controller.search({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), query: "settled archive" })).results[0]?.title, "Settled archive");
    assert.deepEqual((await controller.search({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), query: "sleepyhidden" })).results, []);
    assert.deepEqual((await controller.search({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), query: "finalsecret" })).results, []);
    assert.equal((await controller.search({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), query: "\"lowestvalue\"" })).results[0]?.kind, "file");
    assert.deepEqual((await controller.search({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), query: "other-only" })).results, []);
}

async function checkInvalidThreadState(controller: WorkbenchDatabaseController) {
    await assert.rejects(controller.commitThreadState({ records: [{
      entryKind: "thread", identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["unadmitted"] },
      title: "not committed", activityAt: 1, providerObserved: true,
      metadata: { archived: false, pinned: false, snoozed: false },
      lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
      profile: null, settledAt: null, gitHistoryCleanedAt: null, mcpGeneration: null, snoozedUntil: null,
    }] }));
    assert.equal(controller.state, "ready");
    assert.doesNotThrow(() => controller.assertReady());

    assert.deepEqual(await controller.readThreadStateRecords({ selection: "project", projectId: fixtureIdentityValues.ProjectId["project"] }), []);
    assert.equal(await controller.readThreadStateActivity(fixtureIdentityValues.ProjectId["project"]), null);
}

async function checkRollbackRetry(controller: WorkbenchDatabaseController, directory: string) {
    const inventory = await controller.start();
    await controller.suspend();
    await assert.rejects(controller.resume(join(directory, "missing-checkpoint.sqlite3")));
    await assert.rejects(controller.getInventory());
    await controller.resume();
    assert.deepEqual(await controller.getInventory(), inventory);
}

async function checkTerminalTurn(controller: WorkbenchDatabaseController) {
    assert.deepEqual(
      await controller.readTranscriptMaterializedTurnIds("thread", ["turn", "missing"]),
      [],
    );
    await controller.settleTranscript([{
      kind: "canonicalWindow",
      contentVersion: 3,
      materializedTurnIds: [fixtureIdentityValues.WorkbenchTurnId["turn"]],
      threadId: fixtureIdentityValues.WorkbenchThreadId["thread"],
      observations: [
      {
        kind: "thread",
        threadId: fixtureIdentityValues.WorkbenchThreadId["thread"],
        projectId: fixtureIdentityValues.ProjectId["project"],
        projectRoot: "C:/project",
        title: "Thread",
        createdAt: 1,
        updatedAt: 1,
        activityAt: 1,
      },
      {
        kind: "turn",
        threadId: fixtureIdentityValues.WorkbenchThreadId["thread"],
        turnId: fixtureIdentityValues.WorkbenchTurnId["turn"],
        turnIndex: 0,
        harnessId: "codex",
        nativeLocation: "C:/project",
        nativeThreadId: fixtureIdentityValues.NativeThreadId["thread"],
        nativeTurnId: fixtureIdentityValues.NativeTurnId["turn"],
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
}
