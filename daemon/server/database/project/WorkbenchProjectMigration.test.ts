/* No production exports. Tests protect canonical project conversion, retained locations, and transactional failure. */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { ProjectIdSchema, NativeThreadIdSchema } from "workbench-shared/workbench/identity";
import { installWorkbenchDatabaseSchema, workbenchDatabaseSchema } from "../workbench-database-schema";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchSearchRepository from "../search/WorkbenchSearchRepository";
import WorkbenchProjectMigration from "./WorkbenchProjectMigration";
import type { WorkbenchProjectDiscovery } from "./workbench-project-persistence";
import { localProjectId } from "../../lib/workbench/project/project-identity";

test("known relocation into an excluded worktree preserves history without selecting or merging its checkout", () => {
  const { database, discovery, migration } = setup();
  const destination = discovery.data[0]!.rootPath;
  const historicalId = localProjectId(destination);
  const excluded: WorkbenchProjectDiscovery = {
    ...discovery, data: [], excludedRootPaths: [destination],
    aliases: [{ alias: "new-name", projectId: historicalId }],
  };
  try {
    const before = database.prepare("SELECT * FROM workbench_threads ORDER BY id").all() as Record<string, string | number | null>[];
    const result = migration.run(workbenchDatabaseSchema, excluded, { "old-name": destination });
    assert.deepEqual(result.catalog, []);
    assert.deepEqual(database.prepare("SELECT * FROM workbench_threads ORDER BY id").all(),
      before.map(row => ({ ...row, project_id: historicalId })));
    assert.deepEqual(database.prepare("SELECT id, kind FROM workbench_projects").all(), [{ id: historicalId, kind: "historical" }]);
    assert.equal(database.prepare("SELECT count(*) FROM workbench_project_roots").pluck().get(), 0);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally { database.close(); }
});

function setup() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database, { targetVersion: 31 });
  const rootPath = path.resolve("migration-relocated");
  const id = ProjectIdSchema.parse("remote://example.test/owner/repo");
  const discovery: WorkbenchProjectDiscovery = {
    rootPath: path.dirname(rootPath), excludedRootPaths: [],
    aliases: [{ alias: "new-name", projectId: id }],
    data: [{
      id, kind: "git", name: "repo", relativePath: "new-name", rootPath, lastCommitTimeMs: null,
      roots: [{ id: "repo", name: "repo", relativePath: "new-name", rootPath, isPrimary: true }],
    }],
  };
  const identities = new WorkbenchThreadIdentityRepository(database);
  const threads = ["/member-a", "/member-b"].map((member, index) => identities.observe({
    native: { harness: "codex", nativeThreadId: NativeThreadIdSchema.parse(`native-${index}`), nativeLocation: member },
    projectId: ProjectIdSchema.parse("old-name"), projectRoot: member, title: `thread ${index}`,
    createdAt: 1, updatedAt: 2, activityAt: 2,
  }));
  database.prepare("INSERT INTO codex_sandbox_network_project_overrides(project_id, enabled) VALUES (?, ?)")
    .run("old-name", 1);
  const search = new WorkbenchSearchRepository(database);
  search.replaceProjects([{ id: "new-name", name: "repo", rootPath }]);
  search.replaceProjectFiles("old-name", ["src/index.ts"]);
  return { database, discovery, threads, migration: new WorkbenchProjectMigration(database) };
}

test("known relocation unifies ownership without rewriting thread or native member locations", () => {
  const { database, discovery, migration } = setup();
  try {
    const before = database.prepare("SELECT * FROM workbench_threads ORDER BY id").all() as Record<string, string | number | null>[];
    migration.run(workbenchDatabaseSchema, discovery, { "old-name": discovery.data[0]!.rootPath });
    const id = discovery.data[0]!.id;
    assert.deepEqual(database.prepare("SELECT * FROM workbench_threads ORDER BY id").all(),
      before.map(row => ({ ...row, project_id: id })));
    assert.equal(database.prepare("SELECT project_id FROM codex_sandbox_network_project_overrides").pluck().get(), id);
    assert.deepEqual(database.prepare("SELECT alias, project_id FROM workbench_project_aliases ORDER BY alias").all(), [
      { alias: "new-name", project_id: id }, { alias: "old-name", project_id: id },
    ]);
    assert.deepEqual(database.prepare("SELECT document_key, project_id, target FROM workbench_search_documents WHERE kind IN ('file', 'project') ORDER BY kind").all(), [
      { document_key: `file:${id}:src/index.ts`, project_id: id, target: "src/index.ts" },
      { document_key: `project:${id}`, project_id: id, target: id },
    ]);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    const currentThreads = database.prepare("SELECT * FROM workbench_threads ORDER BY id").all();
    const changedDiscovery = {
      ...discovery, data: [], excludedRootPaths: [discovery.data[0]!.rootPath],
      aliases: [{ alias: "new-name", projectId: localProjectId(discovery.data[0]!.rootPath) }],
    };
    assert.deepEqual(migration.run(workbenchDatabaseSchema, changedDiscovery, { "old-name": path.resolve("no-longer-present") }).catalog, []);
    assert.deepEqual(database.prepare("SELECT * FROM workbench_threads ORDER BY id").all(), currentThreads);
    assert.deepEqual(database.prepare("SELECT project_id FROM workbench_project_aliases WHERE alias = ?").pluck().get("old-name"), id);
  } finally { database.close(); }
});

test("missing relocation evidence rolls back parent admission and leaves retained facts untouched", () => {
  const { database, discovery, migration } = setup();
  try {
    const before = database.prepare("SELECT * FROM workbench_threads ORDER BY id").all();
    assert.throws(() => migration.run(workbenchDatabaseSchema, discovery), /identity evidence/i);
    assert.equal(database.pragma("user_version", { simple: true }), 31);
    assert.deepEqual(database.prepare("SELECT * FROM workbench_threads ORDER BY id").all(), before);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'workbench_projects'").get(), undefined);
    assert.throws(() => migration.run(workbenchDatabaseSchema, discovery, { "old-name": path.resolve("missing") }), /relocation/i);
  } finally { database.close(); }
});
