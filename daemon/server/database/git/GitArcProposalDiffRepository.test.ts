/* No production exports. Protect ordered diff storage, identity and bounded eviction. */
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import GitArcProposalDiffRepository from "./GitArcProposalDiffRepository.ts";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema.ts";
import type { GitArcProposalDiffCacheValue } from "../../lib/workbench/git/GitArcProposalDiffController.ts";

function value(key: string): GitArcProposalDiffCacheValue {
  return {
    key, repositoryRoot: "/repo", baseTree: "base", targetTree: "target", version: 1,
    paths: ["z.ts", "a.ts"],
    changes: [
      { path: "z.ts", additions: 2, deletions: 1, diff: "+new\n-old", kind: { type: "update", move_path: "old.ts" } },
      { path: "a.ts", additions: 1, deletions: 0, diff: "+added", kind: { type: "add" } },
    ],
  };
}

test("ordered changes and moves survive storage while identity mismatches invalidate the cache", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database);
    const repository = new GitArcProposalDiffRepository(database);
    const entry = value("one");
    repository.write(entry, 10_000);
    assert.deepEqual(repository.read(entry), entry.changes);
    assert.throws(() => repository.read({ ...entry, paths: [...entry.paths].reverse() }), /identity/);
    assert.equal(repository.read(entry), null);
    repository.write({ ...entry, paths: [], changes: [] }, 10_000);
    assert.deepEqual(repository.read({ ...entry, paths: [] }), []);
  } finally { database.close(); }
});

test("byte eviction retains recently read entries and oversized replacement removes its old entry", () => {
  const database = new Database(":memory:");
  try {
    installWorkbenchDatabaseSchema(database);
    let now = 1;
    const repository = new GitArcProposalDiffRepository(database, () => now++);
    const first = value("one");
    const second = value("two");
    repository.write(first, 10_000);
    const size = (database.prepare("SELECT byte_size FROM workbench_git_arc_proposal_diffs").get() as { byte_size: number }).byte_size;
    repository.write(second, size * 2);
    repository.read(first);
    repository.write(value("tri"), size * 2);
    assert.equal(repository.read(second), null);
    assert.deepEqual(repository.read(first), first.changes);
    repository.write(first, 1);
    assert.equal(repository.read(first), null);
  } finally { database.close(); }
});

test("age eviction uses last access and preserves the exact cutoff", () => {
  const database = new Database(":memory:");
  try {
    installWorkbenchDatabaseSchema(database);
    let now = 100;
    const repository = new GitArcProposalDiffRepository(database, () => now);
    repository.write(value("old"), 100_000);
    now = 200;
    repository.write(value("boundary"), 100_000);
    repository.write(value("refreshed"), 100_000);
    now = 300;
    assert.deepEqual(repository.read(value("refreshed")), value("refreshed").changes);

    assert.equal(repository.evictOlderThan(200), 1);
    assert.equal(repository.read(value("old")), null);
    assert.deepEqual(repository.read(value("boundary")), value("boundary").changes);
    assert.deepEqual(repository.read(value("refreshed")), value("refreshed").changes);
  } finally { database.close(); }
});

test("legacy binary patch payloads read as a miss and leave storage", () => {
  const database = new Database(":memory:");
  try {
    installWorkbenchDatabaseSchema(database);
    const repository = new GitArcProposalDiffRepository(database);
    const entry = value("one");
    repository.write({ ...entry, changes: [
      entry.changes[0]!,
      { ...entry.changes[1]!, additions: 0, diff: "diff --git a/a.ts b/a.ts\nGIT binary patch\nliteral 3\nabc\n" },
    ] }, 10_000);
    assert.equal(repository.read(entry), null);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM workbench_git_arc_proposal_diffs").get() as { count: number }).count, 0);
  } finally { database.close(); }
});

test("storage upgrade discards reproducible old cache entries without replaying JSON", () => {
  const database = new Database(":memory:");
  try {
    installWorkbenchDatabaseSchema(database, { targetVersion: 33 });
    database.prepare(`INSERT INTO workbench_git_arc_proposal_diffs
      (cache_key, repository_root, base_tree, target_tree, paths_json, changes_json, byte_size, last_accessed_at, format_version)
      VALUES ('one', '/repo', 'base', 'target', 'invalid old payload', 'invalid old payload', 1, 1, 1)`).run();
    installWorkbenchDatabaseSchema(database);
    assert.equal(new GitArcProposalDiffRepository(database).read(value("one")), null);
  } finally { database.close(); }
});
