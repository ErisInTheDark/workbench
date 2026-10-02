/*
 * Exports: none.
 * Tests: folder picker keeps placement inside git roots, refuses repositories as parents, and returns from adding a root into that root.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { DaemonIdSchema } from "workbench-shared/workbench/identity";
import { FolderPickerState, type FolderPickerAction } from "./folder-picker-state";

const daemonId = DaemonIdSchema.parse("502902c0-9512-40be-bb06-c65d86ef2029");
const run = (...actions: FolderPickerAction[]) => actions.reduce(FolderPickerState.reduce, FolderPickerState.initial);

test("leaving a git root upward returns to the virtual root list instead of its disk parent", () => {
  const state = run(
    { type: "open", folder: { daemonId, path: "C:\\git" } },
    { type: "open", folder: { daemonId, path: "C:\\git\\web" } },
    { type: "up", parentPath: "C:\\git" },
  );
  assert.deepEqual(FolderPickerState.target(state), { daemonId, path: "C:\\git" });
  assert.deepEqual(FolderPickerState.reduce(state, { type: "up", parentPath: "C:\\" }), FolderPickerState.initial);
});

test("placement breadcrumbs start at the git root while root browsing starts at the drive", () => {
  const placing = run(
    { type: "open", folder: { daemonId, path: "C:\\git" } },
    { type: "open", folder: { daemonId, path: "C:\\git\\web" } },
  );
  assert.deepEqual(FolderPickerState.crumbs(placing), [
    { label: "Project roots", path: null }, { label: "/c/git", path: "C:\\git" }, { label: "web", path: "C:\\git\\web" },
  ]);
  const adding = run({ type: "begin-add-root", daemonId }, { type: "open", folder: { daemonId, path: "D:\\code" } });
  assert.deepEqual(FolderPickerState.crumbs(adding).map(crumb => crumb.label), ["Drives", "/d", "code"]);
});

test("repositories cannot become a project parent but can become a projects root", () => {
  const repository = { daemonId, path: "C:\\git\\app", isGitRepository: true };
  const inRoot = run({ type: "open", folder: { daemonId, path: "C:\\git" } });
  assert.equal(FolderPickerState.reduce(inRoot, { type: "open", folder: repository }), inRoot);
  assert.equal(FolderPickerState.reduce(inRoot, { type: "select", folder: repository }), inRoot);
  assert.deepEqual(FolderPickerState.target(inRoot), { daemonId, path: "C:\\git" });
  const adding = run({ type: "begin-add-root", daemonId }, { type: "select", folder: repository });
  assert.deepEqual(FolderPickerState.target(adding), repository);
});

test("adding a root starts at filesystem roots and returns to placement inside the new root", () => {
  const adding = run({ type: "begin-add-root", daemonId }, { type: "open", folder: { daemonId, path: "D:\\" } });
  assert.equal(FolderPickerState.reduce(adding, { type: "up", parentPath: null }).path, null);
  const drives = FolderPickerState.reduce(adding, { type: "home" });
  assert.equal(drives.mode, "add-root");
  assert.equal(drives.path, null);
  const added = FolderPickerState.reduce(adding, { type: "root-added", folder: { daemonId, path: "D:\\code" } });
  assert.equal(added.mode, "place");
  assert.deepEqual(FolderPickerState.target(added), { daemonId, path: "D:\\code" });
  assert.deepEqual(FolderPickerState.reduce(added, { type: "up", parentPath: "D:\\" }), FolderPickerState.initial);
  assert.deepEqual(FolderPickerState.reduce(adding, { type: "cancel-add-root" }), FolderPickerState.initial);
});
