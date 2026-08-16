/* No production exports. Tests protect observation, reconciliation, persistence mutations, and stale publication fences. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WorkbenchThreadStateController from "./WorkbenchThreadStateController";
import type { WorkbenchThreadSidebarEntry } from "../lib/workbench/thread/thread-state";

test("observations are reference counted and warm snapshots do not duplicate reconciliation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-state-"));
  const published: string[] = [];
  let reconciliations = 0;
  const controller = new WorkbenchThreadStateController({
    publish: (connectionId) => published.push(connectionId),
    reconcileProject: async () => { reconciliations += 1; return []; },
    resolveProjectRoot: async () => root,
  });
  const first = await controller.open("a", "project");
  assert.equal(first.freshness, "loading");
  await controller.open("b", "project");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reconciliations, 1);
  assert.deepEqual(new Set(published), new Set(["a", "b"]));
  await controller.close("a");
  await controller.refresh("project");
  await controller.dispose();
});

test("provider completion auto-completes subagents while top-level turns still need an explicit status", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-lifecycle-"));
  const working = (threadId: string): Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> => ({
    activityAt: 1, entryKind: "thread", identity: { harness: "codex", threadId },
    lifecycle: { agent: { agentStatus: "working", turnId: `${threadId}-turn` }, kind: "working", reason: "acceptedIntent", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false }, title: threadId,
  });
  const child: WorkbenchThreadSidebarEntry = {
    activityAt: 1, createdAt: 1, cwd: root, directSubagentIndex: 0, entryKind: "subagent", identity: { harness: "codex", threadId: "child" },
    lifecycle: { agent: { agentStatus: "working", turnId: "child-turn" }, kind: "working", reason: "acceptedIntent", settled: false },
    name: "Child", parentThreadId: "parent", pinned: false, profileId: "default", profileName: "Default", projectId: "project", title: "Child", updatedAt: 1,
  };
  const parent: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = { ...working("parent"), lifecycle: { kind: "completed", reason: "providerInactive", settled: true } };
  const controller = new WorkbenchThreadStateController({
    publish: () => undefined,
    reconcileProject: async () => [parent, working("top"), child],
    resolveProjectRoot: async () => root,
  });
  await controller.open("observer", "project");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const lifecycleOf = (snapshot: Awaited<ReturnType<typeof controller.getSnapshot>>, threadId: string) => {
    const entry = snapshot.entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === threadId);
    return entry?.entryKind === "draft" ? null : entry?.lifecycle.kind;
  };
  assert.equal(lifecycleOf(await controller.getSnapshot("project"), "parent"), "working");
  await controller.observeLifecycle("codex", "child", { kind: "turnCompleted", status: "completed", turnId: "child-turn" });
  await controller.observeLifecycle("codex", "top", { kind: "turnCompleted", status: "completed", turnId: "top-turn" });
  const snapshot = await controller.getSnapshot("project");
  assert.equal(lifecycleOf(snapshot, "child"), "completed");
  assert.equal(lifecycleOf(snapshot, "top"), "needsAttention");
  assert.equal(lifecycleOf(snapshot, "parent"), "completed");
  await controller.dispose();
});

test("restoring a terminal thread persists across provider reconciliation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-restore-"));
  const terminal: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: "terminal" },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: true },
    metadata: { archived: false, pinned: true, snoozed: false },
    title: "Terminal",
  };
  const controller = new WorkbenchThreadStateController({
    publish: () => undefined,
    reconcileProject: async () => [terminal],
    resolveProjectRoot: async () => root,
  });
  await controller.open("observer", "project");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await controller.handleRequest("observer", {
    identity: terminal.identity,
    method: "workbench/thread-state/restore",
    projectId: "project",
  });
  const restored = (await controller.getSnapshot("project")).entries[0];
  assert.equal(restored?.entryKind === "thread" ? restored.lifecycle.settled : null, false);
  assert.equal(restored?.entryKind === "thread" ? restored.metadata.pinned : null, true);
  await controller.refresh("project");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const reconciled = (await controller.getSnapshot("project")).entries[0];
  assert.equal(reconciled?.entryKind === "thread" ? reconciled.lifecycle.settled : null, false);
  await controller.dispose();
});
