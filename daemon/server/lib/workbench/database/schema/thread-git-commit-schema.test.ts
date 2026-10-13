/*
 * Exports: none. Tests protect permanent accepted-commit ownership and migration.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { installWorkbenchDatabaseSchema } from "../../../../database/workbench-database-schema";
import WorkbenchThreadIdentityRepository from "../../../../database/thread-identity/WorkbenchThreadIdentityRepository";
import databaseReleases from "workbench-shared/workbench/database/schema/releases";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";

test("current schema owns permanent thread commit history", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database);
    const table = database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name = 'workbench_thread_git_commits'
    `).get();
    assert.deepEqual(table, { name: "workbench_thread_git_commits" });
  } finally {
    database.close();
  }
});

test("schema 80 backfills accepted observations and thread deletion cascades", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database, { targetVersion: databaseReleases.threadErrors.version });
    const { threadId } = new WorkbenchThreadIdentityRepository(database).observe({
      activityAt: 1,
      createdAt: 1,
      native: {
        harness: "codex",
        nativeLocation: "C:/project",
        nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse("native"),
      },
      projectId: testProjectIds.project,
      projectRoot: "C:/project",
      title: "thread",
      updatedAt: 1,
    });
    database.prepare(`
      INSERT INTO workbench_thread_states(thread_id, thread_kind, harness_id, title, activity_at, provider_observed)
      VALUES (?, 'topLevel', 'codex', 'thread', 1, 1)
    `).run(threadId);
    database.prepare(`
      INSERT INTO workbench_thread_git_observations(id, thread_id, observation_kind, has_value)
      VALUES ('observation', ?, 'arc', 1)
    `).run(threadId);
    database.exec(`
      INSERT INTO workbench_thread_git_entries(
        id, observation_id, observation_kind, has_value, entry_kind, entry_index,
        checkpoint_commit, intent_name, intent_description, updated_at, phase,
        harness, thread_id, repo_root, root_id
      ) VALUES (
        'entry', 'observation', 'arc', 1, 'summary', 0,
        '${"a".repeat(40)}', '', '', '2026-10-14T00:00:00.000Z', 'resolved',
        NULL, NULL, NULL, NULL
      );
      INSERT INTO workbench_thread_git_proposals(
        entry_id, observation_kind, proposal_index, proposal_id, root_id, status,
        summary_title, summary_description, summary_mode, summary_committed_sha, summary_changes_known
      ) VALUES (
        'entry', 'arc', 0, 'proposal', 'root', 'committed',
        'accepted title', 'accepted description', 'commit', '${"b".repeat(40)}', 0
      );
    `);

    installWorkbenchDatabaseSchema(database);
    assert.deepEqual(database.prepare(`
      SELECT thread_id, root_id, source_proposal_id, history_index, commit_sha, title, description
      FROM workbench_thread_git_commits
    `).get(), {
      commit_sha: "b".repeat(40),
      description: "accepted description",
      history_index: 0,
      root_id: "root",
      source_proposal_id: "proposal",
      thread_id: threadId,
      title: "accepted title",
    });
    database.prepare("DELETE FROM workbench_thread_states WHERE thread_id = ?").run(threadId);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM workbench_thread_git_commits").get() as { count: number }).count, 0);
  } finally {
    database.close();
  }
});
