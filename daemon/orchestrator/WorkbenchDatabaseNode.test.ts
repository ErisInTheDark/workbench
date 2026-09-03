/*
 * No production exports. Tests protect mandatory node readiness, transcript reset and registration, and worker closure. Keywords: database, transcript, reset, graph, lifecycle, test.
 */
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import Database from "better-sqlite3";

import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import { recoverCodexSqliteTranscriptBeforeAvailability } from "./CodexBridgeNode";
import WorkbenchDatabaseNode from "./WorkbenchDatabaseNode";

async function exists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test("the database node proves readiness before exposing transcript work and closes its worker on disposal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-database-node-"));
  const instance = WorkbenchDatabaseNode.create(
    { legacyMigrationProjectRoot: directory } as OrchestratorProcessContext,
    {
      get: () => {
        throw new Error("The database root has no registration requirements");
      },
      handoffState: undefined,
      isReplacing: () => false,
      lease: { isCurrent: () => true },
      mode: "initial",
    },
  );
  const database = instance.registrations.database!;
  const transcript = instance.registrations.transcript!;
  const transcriptShadowLog = instance.registrations.transcriptShadowLog!;
  try {
    await instance.start();
    database.assertReady();
    assert.equal(transcript.failure, null);
    transcriptShadowLog.write({ event: "ready", level: "info", source: "test" });

    await instance.dispose();
    assert.equal(database.state, "closed");
    await assert.rejects(database.start(), /closed/);
  } finally {
    await instance.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex recovery settles every provider gap before harness availability", async () => {
  const pendingThreadIds = ["thread-a", "thread-b"];
  const calls: string[] = [];
  await recoverCodexSqliteTranscriptBeforeAvailability({
    recoverSqliteTranscriptThread: async (threadId) => {
      calls.push(`recover:${threadId}`);
      assert.equal(pendingThreadIds.shift(), threadId);
    },
  }, {
    get cutoverFailure() { return null; },
    get pendingRecoveryThreadIds() { return [...pendingThreadIds]; },
  }, (threadId) => {
    calls.push(`failure:${threadId ?? "cutover"}`);
  }, async () => {
    calls.push("available");
  });
  assert.deepEqual(calls, [
    "recover:thread-a",
    "recover:thread-b",
    "available",
  ]);
});

test("Codex recovery reports a partial failure and still makes the harness available", async () => {
  const pendingThreadIds = ["thread-a", "thread-b"];
  const calls: string[] = [];
  await recoverCodexSqliteTranscriptBeforeAvailability({
    recoverSqliteTranscriptThread: async (threadId) => {
      calls.push(`recover:${threadId}`);
      if (threadId === "thread-a") throw new Error("provider read failed");
      pendingThreadIds.splice(pendingThreadIds.indexOf(threadId), 1);
    },
  }, {
    get cutoverFailure() { return new Error("transcript recovery is required"); },
    get pendingRecoveryThreadIds() { return [...pendingThreadIds]; },
  }, (threadId, error) => {
    calls.push(`failure:${threadId}:${error instanceof Error ? error.message : String(error)}`);
  }, async () => {
    calls.push("available");
  });
  assert.deepEqual(pendingThreadIds, ["thread-a"]);
  assert.deepEqual(calls, [
    "recover:thread-a",
    "failure:thread-a:provider read failed",
    "recover:thread-b",
    "available",
  ]);
});

test("an unrecoverable gap reports cutover health without blocking harness availability", async () => {
  const calls: string[] = [];
  await recoverCodexSqliteTranscriptBeforeAvailability({
    recoverSqliteTranscriptThread: async (threadId) => {
      calls.push(`unexpected-recovery:${threadId}`);
    },
  }, {
    get cutoverFailure() { return new Error("one unrecoverable gap"); },
    get pendingRecoveryThreadIds() { return []; },
  }, (threadId, error) => {
    calls.push(`failure:${threadId ?? "cutover"}:${error instanceof Error ? error.message : String(error)}`);
  }, async () => {
    calls.push("available");
  });
  assert.deepEqual(calls, [
    "failure:cutover:one unrecoverable gap",
    "available",
  ]);
});

test("database replacement baselines each exact active Codex thread after marked recovery", async () => {
  const pendingThreadIds = ["recovery-thread"];
  const calls: string[] = [];
  await recoverCodexSqliteTranscriptBeforeAvailability({
    recoverSqliteTranscriptThread: async (threadId) => {
      calls.push(`recover:${threadId}`);
      pendingThreadIds.splice(pendingThreadIds.indexOf(threadId), 1);
    },
  }, {
    get cutoverFailure() { return null; },
    get pendingRecoveryThreadIds() { return [...pendingThreadIds]; },
  }, (threadId, error) => {
    calls.push(`failure:${threadId}:${error instanceof Error ? error.message : String(error)}`);
  }, async () => {
    calls.push("available");
  }, {
    captureGap: async (threadId, error) => {
      calls.push(`gap:${threadId}:${error instanceof Error ? error.message : String(error)}`);
      return error instanceof Error ? error : new Error(String(error));
    },
    readThread: async (threadId) => {
      calls.push(`baseline:${threadId}`);
      if (threadId === "failed-thread") throw new Error("provider baseline failed");
    },
    threadIds: ["recovery-thread", "active-thread", "active-thread", "failed-thread"],
  });
  assert.deepEqual(calls, [
    "recover:recovery-thread",
    "baseline:active-thread",
    "baseline:failed-thread",
    "gap:failed-thread:provider baseline failed",
    "failure:failed-thread:provider baseline failed",
    "available",
  ]);
});

test("the replacement database node resets transcript data and preserves shared SQLite domains", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-database-node-reset-"));
  const storage = join(directory, ".workbench");
  const databasePath = join(storage, "workbench.sqlite3");
  const captureGapMarkerPath = join(storage, "workbench-transcript-capture-gap.json");
  const resetRequestPath = join(storage, "reset-workbench-sqlite");
  const shadowLogPath = join(storage, "logs", "workbench-transcript-shadow.jsonl");
  const preserved = join(storage, "transcripts.json");
  const active = WorkbenchDatabaseNode.create(
    { legacyMigrationProjectRoot: directory } as OrchestratorProcessContext,
    {
      get: () => {
        throw new Error("The database root has no registration requirements");
      },
      handoffState: undefined,
      isReplacing: () => false,
      lease: { isCurrent: () => true },
      mode: "initial",
    },
  );
  let replacement: ReturnType<typeof WorkbenchDatabaseNode.create> | null = null;
  try {
    assert.equal(WorkbenchDatabaseNode.lifecycle, "handoff");
    await active.start();
    await active.registrations.codexSandboxNetwork!.setGlobal(true);
    await active.registrations.codexSandboxNetwork!.setProjectOverride("project", false);
    await active.registrations.transcript!.record([
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
        startedAt: 1,
        endedAt: 2,
        durationMs: 1,
      },
    ], { source: "provider" });
    active.registrations.transcriptShadowLog!.write({ event: "before-reset", level: "info", source: "test" });
    await writeFile(preserved, "keep", "utf8");
    await writeFile(captureGapMarkerPath, "discarded shadow marker", "utf8");
    await writeFile(resetRequestPath, "workbench-transcript-shadow-reset-v2\n", "utf8");

    assert.ok(active.detachForReload);
    await active.detachForReload({ isReplacing: () => true });
    assert.equal(active.registrations.database!.state, "closed");

    replacement = WorkbenchDatabaseNode.create(
      { legacyMigrationProjectRoot: directory } as OrchestratorProcessContext,
      {
        get: () => {
          throw new Error("The database root has no registration requirements");
        },
        handoffState: undefined,
        isReplacing: () => true,
        lease: { isCurrent: () => true },
        mode: "replacement",
      },
    );
    await replacement.start();
    replacement.registrations.database!.assertReady();
    assert.equal(await exists(databasePath), true);
    assert.equal(await replacement.registrations.transcript!.read({ threadId: "thread", turnLimit: 1 }), null);
    assert.deepEqual(
      await replacement.registrations.codexSandboxNetwork!.read("project"),
      {
        effectiveEnabled: false,
        globalEnabled: true,
        projectId: "project",
        projectOverride: false,
      },
    );
    assert.equal(await exists(captureGapMarkerPath), false);
    assert.equal(await exists(resetRequestPath), false);
    assert.equal(await exists(shadowLogPath), false);
    assert.equal(await readFile(preserved, "utf8"), "keep");
  } finally {
    await replacement?.dispose();
    await active.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed transcript reset leaves its request and rolls back deleted transcript rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-database-node-reset-failure-"));
  const storage = join(directory, ".workbench");
  const databasePath = join(storage, "workbench.sqlite3");
  const resetRequestPath = join(storage, "reset-workbench-sqlite");
  const active = WorkbenchDatabaseNode.create(
    { legacyMigrationProjectRoot: directory } as OrchestratorProcessContext,
    {
      get: () => {
        throw new Error("The database root has no registration requirements");
      },
      handoffState: undefined,
      isReplacing: () => false,
      lease: { isCurrent: () => true },
      mode: "initial",
    },
  );
  await active.start();
  await active.registrations.transcript!.record([
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
      startedAt: 1,
      endedAt: 2,
      durationMs: 1,
    },
  ], { source: "provider" });
  await active.detachForReload!({ isReplacing: () => true });
  const inspection = new Database(databasePath);
  try {
    inspection.prepare(`
      INSERT INTO transcript_assets(digest,mime_type,byte_length,storage_key,created_at)
      VALUES ('digest','text/plain',1,'asset',3)
    `).run();
    inspection.exec(`
      CREATE TRIGGER reject_transcript_asset_delete
      BEFORE DELETE ON transcript_assets
      BEGIN
        SELECT RAISE(ABORT, 'asset delete failed');
      END
    `);
  } finally {
    inspection.close();
  }
  await writeFile(resetRequestPath, "workbench-transcript-shadow-reset-v2\n", "utf8");
  const instance = WorkbenchDatabaseNode.create(
    { legacyMigrationProjectRoot: directory } as OrchestratorProcessContext,
    {
      get: () => {
        throw new Error("The database root has no registration requirements");
      },
      handoffState: undefined,
      isReplacing: () => true,
      lease: { isCurrent: () => true },
      mode: "replacement",
    },
  );
  try {
    await assert.rejects(async () => await instance.start(), /asset delete failed/u);
    assert.equal(await readFile(resetRequestPath, "utf8"), "workbench-transcript-shadow-reset-v2\n");
  } finally {
    await instance.dispose();
    await active.dispose();
    const afterFailure = new Database(databasePath);
    try {
      assert.equal(
        (afterFailure.prepare("SELECT COUNT(*) AS count FROM workbench_threads").get() as { count: number }).count,
        1,
      );
      assert.equal(
        (afterFailure.prepare("SELECT COUNT(*) AS count FROM transcript_assets").get() as { count: number }).count,
        1,
      );
    } finally {
      afterFailure.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
});
