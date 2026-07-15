/*
 * Exports:
 * - No production exports; Node tests cover per-parent migration, activity durability, bounded cursor pages, and parent isolation. Keywords: subagent, store, migration, activity, pagination, test.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { WorkbenchSubagentSummary } from "../lib/types";
import WorkbenchSubagentStore from "./WorkbenchSubagentStore";
import { encodeTranscriptPathSegment } from "./codex-transcript-normalizers";

function summary(
  parentThreadId: string,
  threadId: string,
  overrides: Partial<WorkbenchSubagentSummary> = {},
): WorkbenchSubagentSummary {
  return {
    activityStatus: "inactive",
    createdAt: 1,
    cwd: "C:/workspace",
    harness: "codex",
    lastActivityAt: 1,
    name: `Agent ${threadId}`,
    parentThreadId,
    profileId: "profile",
    profileName: "Lily INFINITE",
    projectId: "project",
    threadId,
    title: `Task ${threadId}`,
    updatedAt: 1,
    ...overrides,
  };
}

test("migrates the global store into parent files and invalidates previous-process activity", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-subagent-store-migration-"));
  context.after(async () => await fs.rm(root, { force: true, recursive: true }));
  const runtimePath = path.join(root, ".workbench", "runtime");
  await fs.mkdir(runtimePath, { recursive: true });
  const legacyActive = summary("parent-a", "child-a", { activityStatus: "active", lastActivityAt: 10, updatedAt: 10 });
  const { activityStatus: _activityStatus, lastActivityAt: _lastActivityAt, ...legacyUnknown } = summary("parent-b", "child-b", { updatedAt: 20 });
  await fs.writeFile(path.join(runtimePath, "subagents.json"), JSON.stringify({
    subagents: {
      [legacyActive.threadId]: legacyActive,
      [legacyUnknown.threadId]: legacyUnknown,
    },
    version: 1,
  }), "utf8");

  const store = new WorkbenchSubagentStore(root);
  await store.initialize();
  await assert.rejects(fs.access(path.join(runtimePath, "subagents.json")));
  const parentFiles = await fs.readdir(path.join(runtimePath, "subagents"));
  assert.equal(parentFiles.length, 2);
  assert.equal((await store.list({ parentThreadId: "parent-a", projectId: "project" })).subagents[0]?.activityStatus, "unknown");
  assert.equal((await store.list({ parentThreadId: "parent-b", projectId: "project" })).subagents[0]?.lastActivityAt, 20);

  await store.observeNotification("codex", {
    method: "turn/started",
    params: { threadId: "child-a", turn: { id: "turn-a" } },
  }, 100);
  assert.equal((await store.list({ parentThreadId: "parent-a", projectId: "project" })).subagents[0]?.activityStatus, "active");
  const restarted = new WorkbenchSubagentStore(root);
  await restarted.initialize();
  assert.equal((await restarted.list({ parentThreadId: "parent-a", projectId: "project" })).subagents[0]?.activityStatus, "unknown");
});

test("repeats a partial migration without replacing a newer parent record", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-subagent-store-partial-migration-"));
  context.after(async () => await fs.rm(root, { force: true, recursive: true }));
  const runtimePath = path.join(root, ".workbench", "runtime");
  const parentPath = path.join(runtimePath, "subagents");
  await fs.mkdir(parentPath, { recursive: true });
  const older = summary("parent", "child", { title: "Older legacy record", updatedAt: 10 });
  const newer = summary("parent", "child", { title: "Newer parent record", updatedAt: 20 });
  await fs.writeFile(path.join(parentPath, `${encodeTranscriptPathSegment("parent")}.json`), JSON.stringify({
    parentThreadId: "parent",
    schemaVersion: 2,
    subagents: { child: newer },
  }), "utf8");
  await fs.writeFile(path.join(runtimePath, "subagents.json"), JSON.stringify({
    subagents: { child: older },
    version: 1,
  }), "utf8");

  const store = new WorkbenchSubagentStore(root);
  await store.initialize();
  const [record] = (await store.list({ parentThreadId: "parent", projectId: "project" })).subagents;
  assert.equal(record?.title, "Newer parent record");
  await assert.rejects(fs.access(path.join(runtimePath, "subagents.json")));
  const restarted = new WorkbenchSubagentStore(root);
  assert.equal((await restarted.list({ parentThreadId: "parent", projectId: "project" })).subagents[0]?.title, "Newer parent record");
});

test("keeps parent writes isolated, resolves direct parents, and pages activity-sorted records twenty at a time", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-subagent-store-pages-"));
  context.after(async () => await fs.rm(root, { force: true, recursive: true }));
  const store = new WorkbenchSubagentStore(root);
  await store.initialize();
  for (let index = 0; index < 25; index += 1) {
    await store.reserve(summary("parent-a", `child-${index.toString().padStart(2, "0")}`, {
      activityStatus: index < 2 ? "active" : index < 4 ? "unknown" : "inactive",
      createdAt: index,
      lastActivityAt: index,
      updatedAt: index,
    }));
  }
  await store.reserve(summary("parent-b", "other-child"));

  assert.equal((await store.getParentRelationship("other-child", "project"))?.parentThreadId, "parent-b");
  assert.equal(await store.getParentRelationship("other-child", "different-project"), null);
  assert.equal(await store.getParentRelationship("missing-child", "project"), null);

  const first = await store.list({ limit: 20, parentThreadId: "parent-a", projectId: "project" });
  assert.equal(first.subagents.length, 20);
  assert.equal(first.subagents[0]?.activityStatus, "active");
  assert.ok(first.nextCursor);
  const second = await store.list({ cursor: first.nextCursor, limit: 20, parentThreadId: "parent-a", projectId: "project" });
  assert.equal(second.subagents.length, 5);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.subagents, ...second.subagents].map(({ threadId }) => threadId)).size, 25);
  await assert.rejects(
    store.list({ cursor: first.nextCursor, parentThreadId: "parent-b", projectId: "project" }),
    /Invalid subagent list cursor/u,
  );
  await assert.rejects(store.list({ limit: 21, parentThreadId: "parent-a", projectId: "project" }), /between 1 and 20/u);

  const files = await fs.readdir(path.join(root, ".workbench", "runtime", "subagents"));
  assert.equal(files.length, 2);
  assert.deepEqual((await store.list({ parentThreadId: "parent-b", projectId: "project" })).subagents.map(({ threadId }) => threadId), ["other-child"]);
});

test("coalesces duplicate activity writes and ignores mismatched harness notifications", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-subagent-store-activity-"));
  context.after(async () => await fs.rm(root, { force: true, recursive: true }));
  const store = new WorkbenchSubagentStore(root);
  await store.reserve(summary("parent", "child", { activityStatus: "unknown", lastActivityAt: 10 }));
  assert.equal(await store.markActivity("child", "active", 100, "opencode"), false);
  assert.equal(await store.markActivity("child", "active", 100, "codex"), true);
  assert.equal(await store.markActivity("child", "active", 101, "codex"), false);
  assert.equal(await store.observeNotification("codex", {
    method: "thread/status/changed",
    params: { status: { type: "idle" }, threadId: "child" },
  }, 200), true);
  const [record] = (await store.list({ parentThreadId: "parent", projectId: "project" })).subagents;
  assert.equal(record?.activityStatus, "inactive");
  assert.equal(record?.lastActivityAt, 200);
});
