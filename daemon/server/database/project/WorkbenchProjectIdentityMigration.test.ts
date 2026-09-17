/* No exports. Protect backed-up identity conversion, split-owner recovery and conflict preservation. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureTestOutput } from "../../../../test/capture-test-output.mts";
import Database from "better-sqlite3";
import { ProjectIdentityKeySchema } from "workbench-shared/workbench/identity";
import databaseReleases from "workbench-shared/workbench/database/schema/releases";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema";
import WorkbenchSearchRepository from "../search/WorkbenchSearchRepository";
import WorkbenchProjectIdentityMigration from "./WorkbenchProjectIdentityMigration";
import WorkbenchProjectRepository from "./WorkbenchProjectRepository";
import type { WorkbenchProjectDiscovery } from "./workbench-project-persistence";

const oldKey = "remote://example.test/old/repo";
const newKey = "remote://example.test/new/repo";

function fixture(databasePath = ":memory:") {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database, { targetVersion: databaseReleases.stableProjectPreparation.version });
  database.prepare("INSERT INTO workbench_harnesses(id) VALUES ('codex')").run();
  for (const key of [oldKey, newKey]) {
    database.prepare(`INSERT INTO workbench_projects(id, identity_key, kind, name, relative_path, icon_source_key)
      VALUES (?, ?, 'git', 'repo', 'repo', 'generation')`).run(key, key);
    database.prepare(`INSERT INTO workbench_project_roots(project_id, root_id, root_index, name, relative_path, root_path)
      VALUES (?, 'root', 0, 'repo', 'repo', 'C:/repo')`).run(key);
  }
  database.prepare(`INSERT INTO workbench_threads(id, project_id, project_root, title, transcript_content_version, created_at, updated_at, activity_at)
    VALUES ('thread', ?, 'C:/repo', 'retained title', 3, 1, 2, 3)`).run(oldKey);
  database.exec(`INSERT INTO workbench_sidebar_layouts(id, owner_kind, revision) VALUES ('shadow-layout', 'project', 0)`);
  database.prepare(`INSERT INTO workbench_sidebar_project_layouts(layout_id, owner_kind, project_id)
    VALUES ('shadow-layout', 'project', ?)`).run(newKey);
  const identityKey = ProjectIdentityKeySchema.parse(newKey);
  const discovery: WorkbenchProjectDiscovery = {
    complete: true, aliases: [], excludedRootPaths: [], rootPath: "C:/", observedKeys: [identityKey],
    data: [{
      identityKey, kind: "git", name: "repo", relativePath: "repo", rootPath: "C:/repo", lastCommitTimeMs: null,
      roots: [{ id: "root", identityKey, isPrimary: true, name: "repo", relativePath: "repo", rootPath: "C:/repo" }],
    }],
  };
  const receipt = (project: string, ref: string, state: "completed" | "failed" | "processing", commit = "a") => {
    database.prepare(`INSERT INTO git_claim_imports(project_id, root_id, repository_root, workspace_root,
      checkpoint_ref, checkpoint_commit, harness_id, thread_id, observed_at, state, run_id, updated_at)
      VALUES (?, 'root', 'C:/repo', 'C:/repo', ?, ?, 'codex', 'thread', 1, ?, ?, 2)`)
      .run(project, ref, commit, state, state === "processing" ? "stale-run" : null);
  };
  return { database, discovery, receipt };
}

test("empty split recovery retains thread ownership, unions facts and keeps completed receipts across repetition", async () => {
  const { database, discovery, receipt } = fixture();
  try {
    const search = new WorkbenchSearchRepository(database);
    search.replaceProjectFiles(oldKey, ["src/retained.ts"]);
    receipt(oldKey, "shared", "failed");
    receipt(newKey, "shared", "completed");
    receipt(newKey, "unique", "processing");
    for (const [owner, file] of [[oldKey, "shared"], [newKey, "shared"], [newKey, "new"]]) {
      database.prepare(`INSERT INTO git_claim_thread_file_days
        (project_id, root_id, harness_id, thread_id, claimed_path, claimed_day)
        VALUES (?, 'root', 'codex', 'thread', ?, 1)`).run(owner, file);
    }
    const migration = new WorkbenchProjectIdentityMigration(database);
    await migration.run(discovery);
    installWorkbenchDatabaseSchema(database);
    const repository = new WorkbenchProjectRepository(database);
    const owner = repository.requireStoredReference(oldKey);
    assert.notEqual(owner, oldKey);
    assert.equal(repository.requireStoredReference(newKey), owner);
    assert.deepEqual(database.prepare("SELECT id, project_id, title FROM workbench_threads").all(), [
      { id: "thread", project_id: owner, title: "retained title" },
    ]);
    assert.deepEqual(database.prepare("SELECT project_id, claimed_path FROM git_claim_thread_file_days ORDER BY claimed_path").all(), [
      { project_id: owner, claimed_path: "new" }, { project_id: owner, claimed_path: "shared" },
    ]);
    assert.deepEqual(database.prepare("SELECT checkpoint_ref, state, run_id FROM git_claim_imports ORDER BY checkpoint_ref").all(), [
      { checkpoint_ref: "shared", state: "completed", run_id: null },
      { checkpoint_ref: "unique", state: "pending", run_id: null },
    ]);
    assert.equal(database.prepare("SELECT count(*) FROM workbench_projects").pluck().get(), 1);
    assert.ok(database.prepare("SELECT 1 FROM workbench_search_documents WHERE project_id = ?").get(owner));
    const before = database.serialize();
    await migration.run(discovery);
    assert.deepEqual(database.serialize(), before);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally { database.close(); }
});

test("independent state, conflicting receipts and incomplete discovery preserve separate owners", async context => {
  context.mock.method(console, "warn", () => undefined);
  for (const conflict of ["state", "layout", "receipt", "incomplete", "observed"] as const) {
    const { database, discovery, receipt } = fixture();
    try {
      if (conflict === "state") database.prepare(`INSERT INTO workbench_threads(id, project_id, project_root, title, transcript_content_version, created_at, updated_at, activity_at)
        VALUES ('independent', ?, 'C:/repo', 'keep me', 3, 1, 1, 1)`).run(newKey);
      if (conflict === "receipt") {
        receipt(oldKey, "shared", "completed", "a");
        receipt(newKey, "shared", "completed", "b");
      }
      if (conflict === "layout") database.exec(`INSERT INTO workbench_sidebar_folders
        (id, folder_id, layout_id, owner_kind, section, title, folder_index)
        VALUES ('folder', 'folder', 'shadow-layout', 'project', 'settled', 'keep me', 0)`);
      if (conflict === "incomplete") discovery.complete = false;
      if (conflict === "observed") discovery.observedKeys.push(ProjectIdentityKeySchema.parse(oldKey));
      await new WorkbenchProjectIdentityMigration(database).run(discovery);
      installWorkbenchDatabaseSchema(database);
      const repository = new WorkbenchProjectRepository(database);
      assert.notEqual(repository.requireStoredReference(oldKey), repository.requireStoredReference(newKey));
      assert.equal(database.prepare("SELECT count(*) FROM workbench_projects").pluck().get(), 2);
      assert.equal(database.prepare("SELECT count(*) FROM workbench_threads").pluck().get(), conflict === "state" ? 2 : 1);
      if (conflict === "layout") assert.equal(database.prepare("SELECT title FROM workbench_sidebar_folders").pluck().get(), "keep me");
      assert.deepEqual(database.pragma("foreign_key_check"), []);
    } finally { database.close(); }
  }
});

test("conflicting shadow receipts and independently owned current keys preserve every owner", async context => {
  context.mock.method(console, "warn", () => undefined);
  for (const conflict of ["shadows", "external-key"] as const) {
    const { database, discovery, receipt } = fixture();
    try {
      const thirdKey = "remote://example.test/third/repo";
      database.prepare(`INSERT INTO workbench_projects(id, identity_key, kind, name, relative_path, icon_source_key)
        VALUES (?, ?, 'git', 'repo', 'repo', 'generation')`).run(thirdKey, thirdKey);
      database.prepare(`INSERT INTO workbench_project_roots(project_id, root_id, root_index, name, relative_path, root_path)
        VALUES (?, 'root', 0, 'repo', 'repo', ?)`).run(thirdKey, conflict === "shadows" ? "C:/repo" : "C:/elsewhere");
      if (conflict === "shadows") {
        receipt(newKey, "shared", "completed", "a");
        receipt(thirdKey, "shared", "completed", "b");
      } else {
        discovery.data[0]!.identityKey = ProjectIdentityKeySchema.parse(thirdKey);
        discovery.observedKeys = [ProjectIdentityKeySchema.parse(thirdKey)];
      }
      await new WorkbenchProjectIdentityMigration(database).run(discovery);
      installWorkbenchDatabaseSchema(database);
      assert.equal(database.prepare("SELECT count(*) FROM workbench_projects").pluck().get(), 3);
      assert.equal(database.prepare("SELECT count(*) FROM git_claim_imports").pluck().get(), conflict === "shadows" ? 2 : 0);
      assert.deepEqual(database.pragma("foreign_key_check"), []);
    } finally { database.close(); }
  }
});

test("state added while the backup is retained prevents destructive split consolidation", async context => {
  context.mock.method(console, "warn", () => undefined);
  const directory = await mkdtemp(path.join(tmpdir(), "project-conversion-drift-"));
  captureTestOutput(context, process.stdout, text => text.startsWith("[database] preserved schema ") && text.includes(directory));
  const { database, discovery } = fixture(path.join(directory, "workbench.sqlite3"));
  try {
    await new WorkbenchProjectIdentityMigration(database).run(discovery, () => {
      database.exec(`INSERT INTO workbench_sidebar_folders
        (id, folder_id, layout_id, owner_kind, section, title, folder_index)
        VALUES ('folder', 'folder', 'shadow-layout', 'project', 'settled', 'late state', 0)`);
    });
    assert.equal(database.prepare("SELECT title FROM workbench_sidebar_folders").pluck().get(), "late state");
    assert.equal(database.prepare("SELECT count(*) FROM workbench_projects").pluck().get(), 2);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("conversion failure rolls back split consolidation and all owning references", async () => {
  const { database, discovery, receipt } = fixture();
  try {
    receipt(newKey, "unique", "completed");
    database.exec(`CREATE TRIGGER reject_rekey BEFORE UPDATE OF id ON workbench_projects
      BEGIN SELECT RAISE(ABORT, 'injected conversion failure'); END`);
    const before = database.serialize();
    await assert.rejects(new WorkbenchProjectIdentityMigration(database).run(discovery), /injected conversion failure/);
    assert.deepEqual(database.serialize(), before);
    database.exec("DROP TRIGGER reject_rekey");
    await new WorkbenchProjectIdentityMigration(database).run(discovery);
    installWorkbenchDatabaseSchema(database);
    assert.equal(database.prepare("SELECT count(*) FROM workbench_projects").pluck().get(), 1);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally { database.close(); }
});
