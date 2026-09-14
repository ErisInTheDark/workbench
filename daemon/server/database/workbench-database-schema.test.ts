/* No production exports. Tests protect provider references and lossless profile upgrades. */
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { installWorkbenchDatabaseSchema } from "./workbench-database-schema.ts";

function insertProfile(database: Database.Database, id: string, harness: string) {
  database.prepare(`
    INSERT INTO workbench_composer_profiles
      (id, name, harness, model, scope_kind, created_at, updated_at)
    VALUES (?, 'retained profile', ?, 'retained-model', 'global', 1, 2)
  `).run(id, harness);
}

test("profile providers are durable references rather than a fixed product enum", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database);
    assert.throws(() => insertProfile(database, "unadmitted", "codex"), /FOREIGN KEY/);
    database.prepare("INSERT INTO workbench_harnesses(id) VALUES (?)").run("future-provider");
    insertProfile(database, "profile", "future-provider");
    assert.equal((database.prepare("SELECT harness FROM workbench_composer_profiles WHERE id = ?").get("profile") as { harness: string }).harness, "future-provider");
    assert.throws(() => database.prepare("DELETE FROM workbench_harnesses WHERE id = ?").run("future-provider"), /FOREIGN KEY/);
  } finally { database.close(); }
});

test("upgrading standalone profiles backfills provider identity without changing profile data", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database, { targetVersion: 30 });
    insertProfile(database, "profile", "opencode");
    const before = database.prepare("SELECT * FROM workbench_composer_profiles").all();
    installWorkbenchDatabaseSchema(database);
    assert.deepEqual(database.prepare("SELECT * FROM workbench_composer_profiles").all(), before);
    assert.deepEqual(database.prepare("SELECT id FROM workbench_harnesses").all(), [{ id: "opencode" }]);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally { database.close(); }
});

test("provider upgrade preserves every legacy reference owner and its dependent data", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database, { targetVersion: 30 });
    database.exec(`
      INSERT INTO workbench_thread_state_threads
        (id, project_id, thread_kind, visibility, title, archived, pinned, snoozed, provider_observed, created_at, updated_at, activity_at)
      VALUES ('thread', 'project', 'topLevel', 'visible', 'retained', 0, 0, 0, 1, 1, 2, 3);
      INSERT INTO workbench_thread_state_provider_identities
        (project_id, harness_id, provider_thread_id, thread_id)
      VALUES ('project', 'opencode', 'native', 'thread');
      INSERT INTO workbench_thread_state_subagent_parents
        (id, project_id, harness_id, parent_thread_id, next_direct_subagent_index, legacy_id)
      VALUES ('parent', 'project', 'copilot', 'thread', 4, 'retained-parent');
      INSERT INTO workbench_thread_state_profiles (thread_id, selection_kind, harness_id, model)
      VALUES ('thread', 'custom', 'opencode', 'retained-model');
      INSERT INTO workbench_thread_state_project_profiles (project_id, selection_kind, harness_id, model)
      VALUES ('project', 'custom', 'copilot', 'project-model');
      INSERT INTO workbench_thread_state_drafts
        (draft_id, project_id, harness_id, prompt, model, pinned, snoozed, client_updated_at, created_at, updated_at)
      VALUES ('draft', 'project', 'opencode', 'important unsent input', 'draft-model', 1, 0, 5, 1, 5);
      INSERT INTO workbench_thread_state_draft_attachments (draft_id, attachment_index, opaque_json)
      VALUES ('draft', 0, '{"url":"retained-asset"}');
      INSERT INTO git_claim_thread_file_days
        (project_id, root_id, harness_id, thread_id, claimed_path, claimed_day)
      VALUES ('project', 'root', 'copilot', 'thread', 'src/file.ts', 1);
      INSERT INTO git_claim_imports
        (project_id, root_id, repository_root, workspace_root, checkpoint_ref, checkpoint_commit,
         harness_id, thread_id, observed_at, state, updated_at)
      VALUES ('project', 'root', '/repo', '/repo', 'retained-ref', 'retained-commit', 'opencode', 'thread', 1, 'completed', 2);
      INSERT INTO thread_usage_imports
        (project_id, harness_id, provider_thread_id, state, discovered_at, source_activity_at, updated_at)
      VALUES ('project', 'copilot', 'native', 'unavailable', 1, 2, 3);
    `);
    insertProfile(database, "profile", "codex");
    const tables = [
      "workbench_composer_profiles", "workbench_thread_state_provider_identities",
      "workbench_thread_state_subagent_parents", "workbench_thread_state_profiles",
      "workbench_thread_state_project_profiles", "workbench_thread_state_drafts",
      "workbench_thread_state_draft_attachments", "git_claim_thread_file_days",
      "git_claim_imports", "thread_usage_imports",
    ];
    const before = tables.map(table => database.prepare(`SELECT * FROM ${table}`).all());
    installWorkbenchDatabaseSchema(database);
    installWorkbenchDatabaseSchema(database);
    for (const [index, table] of tables.entries()) {
      assert.deepEqual(database.prepare(`SELECT * FROM ${table}`).all(), before[index], table);
    }
    assert.deepEqual(database.prepare("SELECT id FROM workbench_harnesses ORDER BY id").all(),
      [{ id: "codex" }, { id: "copilot" }, { id: "opencode" }]);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally { database.close(); }
});
