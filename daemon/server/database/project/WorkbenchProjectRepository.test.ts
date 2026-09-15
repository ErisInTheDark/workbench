/* No production exports. Tests protect durable positive/negative icon cache and source-fenced settlement. */
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { WorkbenchProjectOption } from "workbench-shared/types";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema";
import WorkbenchProjectRepository from "./WorkbenchProjectRepository";

function project(rootPath = "/repo"): WorkbenchProjectOption {
  return {
    id: ProjectIdSchema.parse("remote://example.test/owner/repo"), kind: "git", name: "repo",
    rootPath, relativePath: "repo", lastCommitTimeMs: 1_750_000_000_000.625,
    roots: [{ id: "repo", isPrimary: true, name: "repo", relativePath: "repo", rootPath }],
  };
}

function setup() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  return { database, repository: new WorkbenchProjectRepository(database) };
}

test("positive and negative icon results survive repeated catalogue reads and repository replacement", () => {
  const { database, repository } = setup();
  try {
    const item = project();
    const initial = repository.reconcile([item])[0]!;
    assert.equal(initial.checkedAt, null);
    const icon = { rootId: "repo", path: "public/favicon.png" };
    assert.equal(repository.settleIcon({ projectId: item.id, sourceKey: initial.sourceKey, checkedAt: 100, icon }), true);
    const replacement = new WorkbenchProjectRepository(database);
    const cached = replacement.reconcile([{ ...item, name: "renamed label" }])[0]!;
    assert.equal(cached.checkedAt, 100);
    assert.deepEqual(cached.project.icon, icon);
    assert.equal(replacement.settleIcon({ projectId: item.id, sourceKey: cached.sourceKey, checkedAt: 200, icon: null }), true);
    const absent = new WorkbenchProjectRepository(database).reconcile([item])[0]!;
    assert.equal(absent.checkedAt, 200);
    assert.equal(absent.project.icon, undefined);
  } finally { database.close(); }
});

test("root changes fence old icon work and older settlements cannot replace newer results", () => {
  const { database, repository } = setup();
  try {
    const item = project();
    const before = repository.reconcile([item])[0]!;
    const moved = repository.reconcile([project("/new-location")])[0]!;
    const icon = { rootId: "repo", path: "favicon.png" };
    assert.notEqual(moved.sourceKey, before.sourceKey);
    assert.equal(repository.settleIcon({ projectId: item.id, sourceKey: before.sourceKey, checkedAt: 300, icon }), false);
    assert.equal(repository.settleIcon({ projectId: item.id, sourceKey: moved.sourceKey, checkedAt: 200, icon }), true);
    assert.equal(repository.settleIcon({ projectId: item.id, sourceKey: moved.sourceKey, checkedAt: 100, icon: null }), false);
    assert.equal(repository.reconcile([project("/new-location")])[0]?.checkedAt, 200);
    assert.throws(() => repository.settleIcon({
      projectId: item.id, sourceKey: moved.sourceKey, checkedAt: 400, icon: { rootId: "foreign", path: "favicon.png" },
    }), /root|FOREIGN KEY/i);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally { database.close(); }
});

test("missing projects retain their cache without remaining in the current catalogue", () => {
  const { database, repository } = setup();
  try {
    const item = project();
    const initial = repository.reconcile([item])[0]!;
    repository.settleIcon({ projectId: item.id, sourceKey: initial.sourceKey, checkedAt: 100, icon: null });
    assert.deepEqual(repository.reconcile([]), []);
    assert.equal(new WorkbenchProjectRepository(database).reconcile([item])[0]?.checkedAt, 100);
  } finally { database.close(); }
});

test("returning to earlier roots does not admit an earlier generation's late icon result", () => {
  const { database, repository } = setup();
  try {
    const original = repository.reconcile([project("/a")])[0]!;
    repository.reconcile([project("/b")]);
    const returned = repository.reconcile([project("/a")])[0]!;
    assert.notEqual(returned.sourceKey, original.sourceKey);
    assert.equal(repository.settleIcon({
      projectId: original.project.id, sourceKey: original.sourceKey, checkedAt: 500,
      icon: { rootId: "repo", path: "old/favicon.png" },
    }), false);
    assert.equal(repository.reconcile([project("/a")])[0]?.checkedAt, null);
  } finally { database.close(); }
});

test("equivalent workspace descriptions preserve the current binding or choose a stable replacement", () => {
  const { database, repository } = setup();
  try {
    const workspace = (workspacePath: string): WorkbenchProjectOption => ({
      ...project(), id: ProjectIdSchema.parse("workspace://members"), kind: "workspace",
      workspacePath, relativePath: workspacePath,
    });
    const a = workspace("/a.code-workspace");
    const b = workspace("/b.code-workspace");
    const initial = repository.reconcile([b])[0]!;
    repository.settleIcon({ projectId: b.id, sourceKey: initial.sourceKey, checkedAt: 100, icon: null });
    const retained = repository.reconcile([a, b]);
    assert.equal(retained.length, 1);
    assert.equal(retained[0]!.project.workspacePath, b.workspacePath);
    assert.equal(retained[0]!.checkedAt, 100);
    assert.equal(repository.reconcile([b, a])[0]!.project.workspacePath, b.workspacePath);
    assert.equal(repository.reconcile([a])[0]!.project.workspacePath, a.workspacePath);
    const fresh = setup();
    try {
      assert.equal(fresh.repository.reconcile([b, a])[0]!.project.workspacePath, a.workspacePath);
    } finally { fresh.database.close(); }
    assert.throws(() => repository.reconcile([project("/a"), project("/b")]), /duplicate/i);
  } finally { database.close(); }
});
