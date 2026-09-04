/*
 * No production exports. Tests protect constrained relational thread-state shadow projection, source parity, and rollback. Keywords: thread state, shadow, sqlite, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import Database from "better-sqlite3";

import { installWorkbenchDatabaseSchema } from "../workbench-database-schema";
import WorkbenchThreadStateRelationalRepository from "./WorkbenchThreadStateRelationalRepository";

function openDatabase() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  return database;
}

test("a current project document becomes constrained relational shadow rows", () => {
  const database = openDatabase();
  try {
    database.prepare(`
      INSERT INTO workbench_thread_state_projects(project_id, document_json, updated_at)
      VALUES ('project', ?, 10)
    `).run(JSON.stringify({
      drafts: [{
        agent: null,
        attachments: [{ provider: "opaque" }],
        clientUpdatedAt: 2,
        composerSettings: {
          agentPath: null,
          agentSource: null,
          harness: "codex",
          model: "model",
          reasoningEffort: null,
          serviceTier: null,
        },
        createdAt: 1,
        draftId: "00000000-0000-4000-8000-000000000001",
        harness: "codex",
        model: "model",
        profileId: null,
        projectId: "project",
        prompt: "draft",
        reasoningEffort: null,
        serviceTier: null,
        updatedAt: 2,
      }],
      newThreadProfile: null,
      records: [{
        activityAt: 5,
        entryKind: "thread",
        gitHistoryCleanedAt: null,
        identity: { harness: "codex", threadId: "thread" },
        lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
        mcpGeneration: null,
        metadata: { archived: false, pinned: true, snoozed: false },
        profile: null,
        providerObserved: true,
        settledAt: null,
        snoozedUntil: null,
        title: "Thread",
      }],
      version: 4,
    }));
    const repository = new WorkbenchThreadStateRelationalRepository(database);
    const status = repository.rebuild({ now: 20, relationships: [] });
    assert.equal(status.state, "complete");
    assert.equal(status.mismatchCount, 0);
    assert.equal(status.projectedThreadCount, 1);
    assert.equal((database.prepare("SELECT COUNT(*) count FROM workbench_thread_state_drafts").get() as { count: number }).count, 1);
    assert.equal((database.prepare("SELECT COUNT(*) count FROM workbench_thread_state_draft_attachments").get() as { count: number }).count, 1);
    const changesBeforeRepeat = (
      database.prepare("SELECT total_changes() changes").get() as { changes: number }
    ).changes;
    repository.rebuild({ now: 21, relationships: [] });
    const repeatedChanges = (
      database.prepare("SELECT total_changes() changes").get() as { changes: number }
    ).changes - changesBeforeRepeat;
    assert.equal(repeatedChanges <= 2, true);

    database.prepare(`
      UPDATE workbench_thread_state_projects
      SET document_json = ?, updated_at = 22
      WHERE project_id = 'project'
    `).run(JSON.stringify({ drafts: [], newThreadProfile: null, records: [], version: 4 }));
    const emptied = repository.rebuild({ now: 23, relationships: [] });
    assert.equal(emptied.state, "complete");
    assert.equal(emptied.projectedThreadCount, 0);
    assert.equal((database.prepare("SELECT COUNT(*) count FROM workbench_thread_state_drafts").get() as { count: number }).count, 0);
    assert.equal((database.prepare("SELECT COUNT(*) count FROM workbench_thread_state_draft_attachments").get() as { count: number }).count, 0);
  } finally {
    database.close();
  }
});

test("variant checks reject impossible lifecycle, augmentation, layout, and profile rows", () => {
  const database = openDatabase();
  try {
    database.prepare(`
      INSERT INTO workbench_thread_state_threads(
        id, project_id, thread_kind, title, archived, pinned, snoozed,
        provider_observed, created_at, updated_at, activity_at, order_at
      ) VALUES ('top', 'project', 'topLevel', 'Top', 0, 0, 0, 1, 1, 1, 1, NULL)
    `).run();
    database.prepare(`
      INSERT INTO workbench_thread_state_threads(
        id, project_id, thread_kind, title, archived, pinned, snoozed,
        provider_observed, created_at, updated_at, activity_at, order_at
      ) VALUES ('parent', 'project', 'topLevel', 'Parent', 0, 0, 0, 1, 1, 1, 1, NULL)
    `).run();
    assert.throws(() => database.prepare(`
      INSERT INTO workbench_thread_state_lifecycles(
        thread_id, lifecycle_kind, reason, settled, provider_turn_id, request_key, agent_status
      ) VALUES ('top', 'needsAttention', 'pendingInput', 0, NULL, 'request', NULL)
    `).run(), /CHECK constraint failed/u);
    assert.throws(() => database.prepare(`
      INSERT INTO workbench_thread_state_subagents(
        thread_id, parent_thread_id, cwd, name, name_key, profile_id, profile_name, direct_subagent_index
      ) VALUES ('top', 'parent', 'C:/project', 'child', 'child', 'profile', 'Profile', 0)
    `).run(), /FOREIGN KEY constraint failed/u);
    assert.throws(() => database.prepare(`
      INSERT INTO workbench_thread_state_profiles(
        thread_id, selection_kind, profile_id, harness_id, model
      ) VALUES ('top', 'custom', 'profile', 'codex', 'model')
    `).run(), /CHECK constraint failed/u);

    database.prepare("INSERT INTO workbench_thread_state_layouts(id, owner_kind, revision) VALUES ('home', 'home', 0)").run();
    assert.throws(() => database.prepare(`
      INSERT INTO workbench_thread_state_layout_folders(
        folder_id, layout_id, layout_owner_kind, section, title
      ) VALUES ('folder', 'home', 'project', 'pinned', 'Folder')
    `).run(), /FOREIGN KEY constraint failed/u);

    database.prepare(`
      INSERT INTO workbench_thread_state_questionnaires(
        id, thread_id, state, request_key, request_id, title, summary, submit_label
      ) VALUES ('questionnaire', 'top', 'pending', 'request', 'request', 'Title', 'Summary', 'Submit')
    `).run();
    database.prepare(`
      INSERT INTO workbench_thread_state_questionnaire_questions(
        questionnaire_id, question_index, question_id, header, question, allow_other, is_secret
      ) VALUES ('questionnaire', 0, 'question', 'Header', 'Question?', 0, 0)
    `).run();
    assert.throws(() => database.prepare(`
      INSERT INTO workbench_thread_state_questionnaire_answers(
        questionnaire_id, questionnaire_state, question_id, answer_index, answer
      ) VALUES ('questionnaire', 'answered', 'question', 0, 'nope')
    `).run(), /FOREIGN KEY constraint failed/u);
  } finally {
    database.close();
  }
});

test("relationship-only identities create a visible child and hidden lifecycle-complete parent placeholder", () => {
  const database = openDatabase();
  try {
    const repository = new WorkbenchThreadStateRelationalRepository(database);
    const status = repository.rebuild({
      now: 10,
      relationships: [{
        createdAt: 1,
        cwd: "C:/project",
        directSubagentIndex: 0,
        harness: "codex",
        name: "child",
        parentThreadId: "parent",
        profileId: "profile",
        profileName: "Profile",
        projectId: "project",
        threadId: "child",
        title: "Child",
        updatedAt: 2,
      }],
    });
    assert.equal(status.state, "complete");
    assert.equal(status.sourceSubagentParentCount, 1);
    assert.deepEqual(database.prepare(`
      SELECT provider_thread_id, thread_kind, visibility
      FROM workbench_thread_state_threads
      JOIN workbench_thread_state_provider_identities
        ON thread_id = workbench_thread_state_threads.id
      ORDER BY provider_thread_id
    `).all(), [
      { provider_thread_id: "child", thread_kind: "subagent", visibility: "visible" },
      { provider_thread_id: "parent", thread_kind: "topLevel", visibility: "placeholder" },
    ]);
    assert.equal(
      (database.prepare("SELECT COUNT(*) count FROM workbench_thread_state_lifecycles").get() as { count: number }).count,
      2,
    );
  } finally {
    database.close();
  }
});

test("a failed rebuild rolls back rows and records bounded failed status", () => {
  const database = openDatabase();
  try {
    const repository = new WorkbenchThreadStateRelationalRepository(database);
    const complete = repository.rebuild({ now: 10, relationships: [] });
    assert.equal(complete.state, "complete");
    database.prepare(`
      INSERT INTO workbench_thread_state_projects(project_id, document_json, updated_at)
      VALUES ('broken', ?, 20)
    `).run(JSON.stringify({ drafts: [], newThreadProfile: null, records: [{}], version: 4 }));
    assert.throws(() => repository.rebuild({ now: 20, relationships: [] }), /recoverable identity/u);
    const failed = repository.recordFailure(new Error("private payload: secret"), {
      now: 21,
      relationships: [],
    });
    assert.equal(failed.state, "failed");
    assert.match(failed.errorText ?? "", /shadow rebuild failed/u);
    assert.equal(failed.errorText?.includes("secret"), false);
    assert.equal((database.prepare("SELECT COUNT(*) count FROM workbench_thread_state_threads").get() as { count: number }).count, 0);
  } finally {
    database.close();
  }
});
