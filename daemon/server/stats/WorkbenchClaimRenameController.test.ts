/*
 * No exports. Protect claimed-root scoping, claim boundaries, HEAD freshness, root isolation, recovery, and cancellation.
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import WorkbenchGitRepository from "../lib/workbench/git/WorkbenchGitRepository.ts";
import WorkbenchClaimRenameController from "./WorkbenchClaimRenameController.ts";

function fixture(name = "rename-fixture") {
  const root = path.resolve(name);
  const repository = new WorkbenchGitRepository(root);
  let head = "a".repeat(40);
  repository.headOrNull = async () => head;
  return { repository, root, setHead: (value: string) => { head = value.repeat(40); } };
}

const scope = (rootId = "root", since = 0) => ({ projectId: "project", rootId, since });

test("rename cache coalesces reads and invalidates on any HEAD change while isolating workspace roots", async () => {
  const { repository, root, setHead } = fixture();
  let scans = 0;
  const controller = new WorkbenchClaimRenameController({
    listRoots: async () => [
      { projectId: "project", rootId: "root", workspaceRoot: root },
      { projectId: "project", rootId: "nested", workspaceRoot: path.join(root, "nested") },
    ],
    openRepository: async () => repository,
    reader: { read: async () => {
      scans += 1;
      return [
        { from: "old", to: "current" },
        { from: "nested/old", to: "nested/current" },
        { from: "nested/leave", to: "outside" },
      ];
    } },
  });
  const both = [scope("root"), scope("nested")];
  try {
    const results = await Promise.all([controller.read(both), controller.read(both)]);
    assert.equal(scans, 1);
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[0]?.renames, [
      { projectId: "project", rootId: "root", from: "old", to: "current" },
      { projectId: "project", rootId: "nested", from: "old", to: "current" },
    ]);
    setHead("b");
    await controller.read(both);
    setHead("a");
    await controller.read(both);
    assert.equal(scans, 3);
  } finally { await controller.dispose(); }
});

test("only claimed roots are scanned, each from its own claim boundary", async () => {
  const claimed = fixture("claimed-root");
  const idle = fixture("idle-root");
  const opened: string[] = [];
  const boundaries: Array<number | null | undefined> = [];
  const controller = new WorkbenchClaimRenameController({
    listRoots: async () => [
      { projectId: "project", rootId: "claimed", workspaceRoot: claimed.root },
      { projectId: "project", rootId: "idle", workspaceRoot: idle.root },
    ],
    openRepository: async (cwd) => {
      opened.push(cwd);
      return cwd === claimed.root ? claimed.repository : idle.repository;
    },
    reader: { read: async (_repository, _head, _signal, since) => {
      boundaries.push(since);
      return [];
    } },
  });
  try {
    assert.deepEqual(await controller.read([]), { renames: [], failures: [] });
    await controller.read([scope("claimed", 1_234)]);
    assert.deepEqual(opened, [claimed.root]);
    assert.deepEqual(boundaries, [1_234]);
    await controller.read([scope("claimed", 99)]);
    assert.deepEqual(boundaries, [1_234, 99], "a different boundary cannot reuse a narrower history");
  } finally { await controller.dispose(); }
});

test("a failed scan does not poison the cache and keeps diagnostics sanitized", async () => {
  const { repository, root } = fixture();
  let fail = true;
  const controller = new WorkbenchClaimRenameController({
    listRoots: async () => [{ projectId: "project", rootId: "root", workspaceRoot: root }],
    openRepository: async () => repository,
    reader: { read: async () => {
      if (fail) throw new Error("history failed\nsecret payload");
      return [{ from: "old", to: "current" }];
    } },
  });
  try {
    const failed = await controller.read([scope()]);
    assert.equal(failed.failures.length, 1);
    assert.deepEqual(failed.renames, []);
    assert.equal(failed.failures[0]?.message.includes("secret payload"), false);
    fail = false;
    const recovered = await controller.read([scope()]);
    assert.equal(recovered.failures.length, 0);
    assert.equal(recovered.renames.length, 1);
  } finally { await controller.dispose(); }
});

test("disposal cancels an in-flight scan, rejects queued reads, and prevents further scans", async () => {
  const { repository, root } = fixture();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let scans = 0;
  const controller = new WorkbenchClaimRenameController({
    listRoots: async () => [{ projectId: "project", rootId: "root", workspaceRoot: root }],
    openRepository: async () => repository,
    reader: { read: async (_repository, _head, signal) => {
      scans += 1;
      started();
      return await new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    } },
  });
  const first = controller.read([scope()]);
  await ready;
  const firstRejected = assert.rejects(first);
  const queuedRejected = assert.rejects(controller.read([scope()]));
  await controller.dispose();
  await Promise.all([firstRejected, queuedRejected]);
  await assert.rejects(controller.read([scope()]));
  assert.equal(scans, 1);
});
