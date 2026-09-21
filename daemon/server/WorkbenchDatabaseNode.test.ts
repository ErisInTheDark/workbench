/*
 * No production exports. Tests protect mandatory node readiness, transcript registration, recovery, and worker closure.
 */
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import type { DaemonProcessContext } from "./daemon-process-context";
let baselineActiveCodexTranscripts: typeof import("./CodexBridgeNode").baselineActiveCodexTranscripts;
let WorkbenchDatabaseNode: typeof import("./WorkbenchDatabaseNode").default;
let discoveryRoot: string;
const previousProjectsRoot = process.env.WORKBENCH_PROJECTS_ROOT;
const previousLibraryRoot = process.env.WORKBENCH_LIBRARY_ROOT;

before(async () => {
  discoveryRoot = await mkdtemp(join(tmpdir(), "workbench-database-node-discovery-"));
  process.env.WORKBENCH_PROJECTS_ROOT = discoveryRoot;
  process.env.WORKBENCH_LIBRARY_ROOT = join(discoveryRoot, "library");
  ({ default: WorkbenchDatabaseNode } = await import("./WorkbenchDatabaseNode"));
  ({ baselineActiveCodexTranscripts } = await import("./CodexBridgeNode"));
});

after(async () => {
  if (previousProjectsRoot === undefined) delete process.env.WORKBENCH_PROJECTS_ROOT;
  else process.env.WORKBENCH_PROJECTS_ROOT = previousProjectsRoot;
  if (previousLibraryRoot === undefined) delete process.env.WORKBENCH_LIBRARY_ROOT;
  else process.env.WORKBENCH_LIBRARY_ROOT = previousLibraryRoot;
  if (discoveryRoot) await rm(discoveryRoot, { recursive: true, force: true });
});

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
  const dataRootPath = join(directory, "data");
  const instance = WorkbenchDatabaseNode.create(
    { dataRootPath, legacyMigrationProjectRoot: directory } as DaemonProcessContext,
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
    assert.equal(await exists(join(dataRootPath, "daemon", "workbench.sqlite3")), true);
    assert.equal(await exists(join(directory, ".workbench", "workbench.sqlite3")), false);

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
    { dataRootPath: join(directory, "data"), legacyMigrationProjectRoot: directory } as DaemonProcessContext,
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

test("active Codex baselining visits each demanded thread once", async () => {
  const calls: string[] = [];
  await baselineActiveCodexTranscripts((threadId) => {
    calls.push(`failure:${threadId ?? "cutover"}`);
  }, {
    threadIds: ["thread-a", "thread-b", "thread-a"],
    readThread: async threadId => { calls.push(`baseline:${threadId}`); },
    captureGap: async () => { throw new Error("Unexpected baseline failure"); },
  });
  assert.deepEqual(calls, [
    "baseline:thread-a",
    "baseline:thread-b",
  ]);
});

test("active Codex baselining records a partial failure and continues other threads", async () => {
  const calls: string[] = [];
  await baselineActiveCodexTranscripts((threadId, error) => {
    calls.push(`failure:${threadId}:${error instanceof Error ? error.message : String(error)}`);
  }, {
    threadIds: ["thread-a", "thread-b"],
    readThread: async (threadId) => {
      calls.push(`baseline:${threadId}`);
      if (threadId === "thread-a") throw new Error("provider read failed");
    },
    captureGap: async (threadId, error) => {
      calls.push(`gap:${threadId}`);
      return error instanceof Error ? error : new Error(String(error));
    },
  });
  assert.deepEqual(calls, [
    "baseline:thread-a",
    "gap:thread-a",
    "failure:thread-a:provider read failed",
    "baseline:thread-b",
  ]);
});

test("database replacement baselines only its active Codex threads and preserves failures", async () => {
  const calls: string[] = [];
  await baselineActiveCodexTranscripts((threadId, error) => {
    calls.push(`failure:${threadId}:${error instanceof Error ? error.message : String(error)}`);
  }, {
    captureGap: async (threadId, error) => {
      calls.push(`gap:${threadId}:${error instanceof Error ? error.message : String(error)}`);
      return error instanceof Error ? error : new Error(String(error));
    },
    readThread: async (threadId) => {
      calls.push(`baseline:${threadId}`);
      if (threadId === "failed-thread") throw new Error("provider baseline failed");
    },
    threadIds: ["active-thread", "active-thread", "failed-thread"],
  });
  assert.deepEqual(calls, [
    "baseline:active-thread",
    "baseline:failed-thread",
    "gap:failed-thread:provider baseline failed",
    "failure:failed-thread:provider baseline failed",
  ]);
});
