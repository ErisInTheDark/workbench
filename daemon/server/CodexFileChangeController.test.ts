/*
 * Keywords: partial patch, bounded observation, unsafe target, recovery excerpts.
 * Exports: none. Tests protect filesystem evidence and recovery admission content.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { WorkbenchFileChangeItem } from "workbench-shared/workbench/thread/workbench-file-change";
import CodexFileChangeController from "./CodexFileChangeController";

async function withFiles(run: (root: string, controller: CodexFileChangeController) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-patch-observation-"));
  try {
    await run(root, new CodexFileChangeController());
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function patch(changes: WorkbenchFileChangeItem["changes"]): WorkbenchFileChangeItem {
  return { id: "patch", type: "fileChange", status: "failed", changes, workbenchPolicy: "automaticEscalation" };
}

test("partial write evidence and current-line uncertainty excerpts belong to the originating patch", async () => withFiles(async (root, controller) => {
  const mixed = "top\nnew\nmiddle\nbottom\nold\nend\n";
  await fs.writeFile(path.join(root, "mixed.txt"), mixed);
  await fs.writeFile(path.join(root, "uncertain.txt"), "unrelated current content\n");
  const input = patch([
    { path: "mixed.txt", kind: { type: "update", move_path: null }, diff: "@@ -1,3 +1,3 @@\n top\n-old\n+new\n middle\n@@ -4,3 +4,3 @@\n bottom\n-old\n+other\n end\n" },
    { path: "uncertain.txt", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-before\n+after\n" },
  ]);
  const result = await controller.analyse({ cwd: root, roots: [root], item: input, threadId: "thread-origin", turnId: "turn-origin" });
  assert.equal(result.item.changes[0]!.workbenchAnalysis?.outcome, "partial");
  assert.equal(result.item.changes[1]!.workbenchAnalysis?.outcome, "uncertain");
  assert.deepEqual(result.item.changes[0]!.workbenchAnalysis?.hunks.map(({ outcome }) => outcome), ["present", "unapplied"]);
  for (const identity of ["thread-origin", "turn-origin", input.id]) assert.ok(result.recoveryText.includes(identity));
  assert.ok(result.recoveryText.includes("1 | unrelated current content"));
  assert.equal(await fs.readFile(path.join(root, "mixed.txt"), "utf8"), mixed);
}));

test("unsafe targets never become evidence and large recovery content is bounded on complete lines", async () => withFiles(async (root, controller) => {
  const current = Array.from({ length: 50 }, (_, index) => `line-${index}-${"X".repeat(240)}`).join("\n");
  await fs.writeFile(path.join(root, "large.txt"), current);
  await fs.writeFile(path.join(root, "oversized.txt"), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  const result = await controller.analyse({
    cwd: root, roots: [root], threadId: "thread", turnId: "turn",
    item: patch([
      { path: "../outside.txt", kind: { type: "delete" }, diff: "outside" },
      { path: "oversized.txt", kind: { type: "add" }, diff: "small" },
      { path: "large.txt", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-before\n+after\n" },
    ]),
  });
  assert.deepEqual(result.item.changes.map(({ workbenchAnalysis }) => workbenchAnalysis?.outcome), ["uncertain", "uncertain", "uncertain"]);
  assert.ok(result.recoveryText.length > 0);
  assert.ok(Buffer.byteLength(result.recoveryText, "utf8") <= 8 * 1024);
  assert.ok(result.recoveryText.endsWith("\n"));
  assert.match(result.recoveryText, /omitted/u);
  for (const line of result.recoveryText.split("\n")) {
    if (/^\d+ \| /u.test(line)) assert.ok(current.split("\n").includes(line.replace(/^\d+ \| /u, "")));
  }
}));

test("unclaimed prevention cannot acquire success findings from matching current content", async () => withFiles(async (root, controller) => {
  await fs.writeFile(path.join(root, "existing.txt"), "already here\n");
  const item: WorkbenchFileChangeItem = {
    id: "blocked", type: "fileChange", status: "failed", workbenchFailureKind: "unclaimed",
    changes: [{ path: "existing.txt", kind: { type: "add" }, diff: "already here\n", workbenchAdditions: 1, workbenchDeletions: 0 }],
  };
  const result = await controller.analyse({ cwd: root, roots: [root], item, threadId: "thread", turnId: "turn" });
  assert.deepEqual(result.item, item);
  assert.equal(result.recoveryText, "");
  const marker = { threadId: "thread", turnId: "turn", item, insertAfterItemId: null };
  assert.equal(controller.recordFailure(marker), true);
  assert.equal(controller.recordFailure(marker), false);
  assert.equal(controller.get("thread", "turn", item.id), undefined);
  assert.equal(controller.state.items.size, 0);
}));

test("aggregate and path limits leave unobserved targets uncertain rather than claiming absent files", async () => withFiles(async (root, controller) => {
  const content = Buffer.alloc(2 * 1024 * 1024, 65);
  const changes: WorkbenchFileChangeItem["changes"] = [];
  for (let index = 0; index < 9; index += 1) {
    const name = `file-${index}.txt`;
    await fs.writeFile(path.join(root, name), content);
    changes.push({ path: name, kind: { type: "delete" }, diff: "previous content" });
  }
  const aggregate = await controller.analyse({ cwd: root, roots: [root], item: patch(changes), threadId: "thread", turnId: "turn" });
  assert.equal(aggregate.item.changes[0]!.workbenchAnalysis?.outcome, "unapplied");
  assert.equal(aggregate.item.changes.at(-1)!.workbenchAnalysis?.outcome, "uncertain");
  const many = await controller.analyse({
    cwd: root, roots: [root], threadId: "thread", turnId: "turn",
    item: patch(Array.from({ length: 129 }, (_, index) => ({ path: `missing-${index}`, kind: { type: "delete" }, diff: "old" }))),
  });
  assert.equal(many.item.changes[0]!.workbenchAnalysis?.outcome, "present");
  assert.equal(many.item.changes.at(-1)!.workbenchAnalysis?.outcome, "uncertain");
}));

test("linked directories and non-text files cannot establish patch success", async () => withFiles(async (root, controller) => {
  const linkedRoot = path.join(root, "elsewhere");
  await fs.mkdir(linkedRoot);
  await fs.writeFile(path.join(linkedRoot, "target"), "matching\n");
  await fs.symlink(linkedRoot, path.join(root, "linked"), "junction");
  await fs.writeFile(path.join(root, "binary"), Buffer.from([65, 0, 66]));
  const result = await controller.analyse({
    cwd: root, roots: [root], threadId: "thread", turnId: "turn",
    item: patch([
      { path: "linked/target", kind: { type: "add" }, diff: "matching\n" },
      { path: "binary", kind: { type: "add" }, diff: "A\0B" },
    ]),
  });
  assert.deepEqual(result.item.changes.map(({ workbenchAnalysis }) => workbenchAnalysis?.outcome), ["uncertain", "uncertain"]);
}));
