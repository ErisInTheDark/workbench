/*
 * No production exports. Tests protect mandatory node readiness, transcript registration, recovery, and worker closure.
 */
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { DaemonProcessContext } from "./daemon-process-context";
import { recoverCodexSqliteTranscripts } from "./CodexBridgeNode";
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
    { legacyMigrationProjectRoot: directory } as DaemonProcessContext,
    {
      get: () => {
        throw new Error("The database root has no registration requirements");
      },
      run: () => { throw new Error("Unexpected graph operation in node fixture"); },
      getSourceState: () => { throw new Error("Unexpected source access in node fixture"); },
      handoffState: undefined,
      isReplacing: () => false,
      lease: { isCurrent: () => true },
      mode: "initial",
    },
  );
  const database = instance.registrations.database!;
  const transcript = instance.registrations.transcript!;
  try {
    await instance.start();
    database.assertReady();
    assert.equal(transcript.failure, null);

    await instance.dispose();
    assert.equal(database.state, "closed");
    await assert.rejects(database.start(), /closed/);
  } finally {
    await instance.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("database retirement still closes its worker when transcript disposal fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-database-node-close-"));
  const instance = WorkbenchDatabaseNode.create(
    { legacyMigrationProjectRoot: directory } as DaemonProcessContext,
    {
      get: () => { throw new Error("No dependencies"); },
      run: () => { throw new Error("Unexpected graph operation in node fixture"); },
      getSourceState: () => { throw new Error("Unexpected source access in node fixture"); },
      handoffState: undefined,
      isReplacing: () => false,
      lease: { isCurrent: () => true },
      mode: "initial",
    },
  );
  const database = instance.registrations.database!;
  try {
    await instance.start();
    const disposeTranscript = instance.registrations.transcript!.dispose.bind(instance.registrations.transcript);
    instance.registrations.transcript!.dispose = () => {
      disposeTranscript();
      throw new Error("transcript disposal failed");
    };
    await assert.rejects(async () => await instance.dispose(), /transcript disposal failed/u);
    assert.equal(database.state, "closed");
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex recovery settles every provider gap independently of harness availability", async () => {
  const pendingThreadIds = ["thread-a", "thread-b"];
  const calls: string[] = [];
  await recoverCodexSqliteTranscripts({
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
    "available",
    "recover:thread-a",
    "recover:thread-b",
  ]);
});

test("Codex recovery reports a partial failure and still makes the harness available", async () => {
  const pendingThreadIds = ["thread-a", "thread-b"];
  const calls: string[] = [];
  await recoverCodexSqliteTranscripts({
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
    "available",
    "recover:thread-a",
    "failure:thread-a:provider read failed",
    "recover:thread-b",
  ]);
});

test("an unrecoverable gap reports cutover health without blocking harness availability", async () => {
  const calls: string[] = [];
  await recoverCodexSqliteTranscripts({
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
    "available",
    "failure:cutover:one unrecoverable gap",
  ]);
});

test("database replacement baselines each exact active Codex thread after marked recovery", async () => {
  const pendingThreadIds = ["recovery-thread"];
  const calls: string[] = [];
  await recoverCodexSqliteTranscripts({
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
    "available",
    "recover:recovery-thread",
    "baseline:active-thread",
    "baseline:failed-thread",
    "gap:failed-thread:provider baseline failed",
    "failure:failed-thread:provider baseline failed",
  ]);
});
