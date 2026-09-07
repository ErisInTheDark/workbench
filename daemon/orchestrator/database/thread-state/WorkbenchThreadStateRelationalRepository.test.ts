/*
 * No production exports. Tests protect constrained relational thread-state shadow projection, source parity, and rollback. Keywords: thread state, shadow, sqlite, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import Database from "better-sqlite3";
import { z } from "zod";

import { installWorkbenchDatabaseSchema } from "../workbench-database-schema";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchTranscriptIdentityRepository from "../transcript/WorkbenchTranscriptIdentityRepository";
import WorkbenchThreadStateRelationalRepository from "./WorkbenchThreadStateRelationalRepository";

function openDatabase() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  return database;
}

function seedIdentities(database: Database.Database, projectId: string, ...nativeIds: string[]) {
  const owner = new WorkbenchThreadIdentityRepository(database);
  return nativeIds.map((nativeThreadId) => owner.observe({
    native: { harness: "codex", nativeLocation: `C:/${projectId}`, nativeThreadId },
    projectId, projectRoot: `C:/${projectId}`, title: nativeThreadId, createdAt: 1, updatedAt: 2, activityAt: 2,
  }).threadId);
}

test("questionnaire projection reuses admitted identity across settlement and repeated request keys", () => {
  const database = openDatabase();
  try {
    const [threadId] = seedIdentities(database, "project", "thread");
    const threads = new WorkbenchThreadIdentityRepository(database);
    const turn = threads.observeTurn({
      kind: "turn", threadId: threadId!, turnId: "turn", nativeTurnId: "turn", nativeThreadId: "thread",
      nativeLocation: "C:/project", harnessId: "codex", state: "inProgress",
      createdAt: 1, startedAt: 1, endedAt: null, durationMs: null,
    });
    const items = new WorkbenchTranscriptIdentityRepository(database);
    const first = items.admit({
      threadId: threadId!, sources: [],
      legacyAliases: [{ turnId: turn.turnId, alias: "old-questionnaire" }],
    });
    const second = items.admit({ threadId: threadId!, sources: [], legacyAliases: [] });
    const request = {
      id: "request", title: "Choose", summary: "", submitLabel: "Submit",
      questions: [{ id: "choice", header: "", question: "Continue?", allowOther: true, isSecret: false,
        options: [{ label: "Yes", description: "" }] }],
    };
    const pending = { itemId: "old-questionnaire", turnId: "turn", requestKey: "workbench-mcp:reused", request };
    const answered = {
      ...pending, threadId: "thread", resolvedAt: 10, insertAfterItemId: null, insertAfterItemIndex: null,
      response: { answers: { choice: { answers: ["Yes"] } } },
    };
    const write = (settled: boolean, duplicateQuestion = false) => database.prepare(`
      INSERT INTO workbench_thread_state_projects(project_id, document_json, updated_at)
      VALUES ('project', ?, 10) ON CONFLICT(project_id) DO UPDATE SET document_json = excluded.document_json
    `).run(JSON.stringify({
      drafts: [], newThreadProfile: null, version: 4,
      records: [{
        activityAt: 5, entryKind: "thread", identity: { harness: "codex", threadId: "thread" },
        lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
        metadata: { archived: false, pinned: false, snoozed: false }, title: "Thread",
        pendingQuestionnaire: settled ? { ...pending, itemId: second.itemId } : pending,
        questionnaireHistory: settled ? [{
          ...answered,
          request: duplicateQuestion ? { ...request, questions: [...request.questions, ...request.questions] } : request,
        }] : [],
      }],
    }));
    const repository = new WorkbenchThreadStateRelationalRepository(database);
    write(false);
    assert.equal(repository.rebuild({ now: 10, parents: [] }).state, "complete");
    assert.deepEqual(database.prepare("SELECT id, state FROM workbench_thread_state_questionnaires").all(),
      [{ id: first.itemId, state: "pending" }]);
    write(true);
    assert.equal(repository.rebuild({ now: 11, parents: [] }).state, "complete");
    const before = database.prepare("SELECT id, state FROM workbench_thread_state_questionnaires ORDER BY state").all();
    assert.deepEqual(before, [{ id: first.itemId, state: "answered" }, { id: second.itemId, state: "pending" }]);
    database.transaction(() => {
      database.pragma("defer_foreign_keys = ON");
      for (const table of ["questions", "options", "answers"]) {
        database.prepare(`UPDATE workbench_thread_state_questionnaire_${table} SET questionnaire_id = 'old-shadow-id' WHERE questionnaire_id = ?`)
          .run(first.itemId);
      }
      database.prepare("UPDATE workbench_thread_state_questionnaires SET id = 'old-shadow-id' WHERE id = ?").run(first.itemId);
    })();
    write(true, true);
    assert.equal(repository.rebuild({ now: 12, parents: [] }).state, "failed");
    assert.deepEqual(database.prepare("SELECT questionnaire_id, answer FROM workbench_thread_state_questionnaire_answers").all(),
      [{ questionnaire_id: "old-shadow-id", answer: "Yes" }]);
    write(true);
    assert.equal(repository.rebuild({ now: 12, parents: [] }).state, "complete");
    assert.equal(repository.rebuild({ now: 13, parents: [] }).state, "complete");
    assert.deepEqual(database.prepare("SELECT id, state FROM workbench_thread_state_questionnaires ORDER BY state").all(), before);
    assert.deepEqual(database.prepare("SELECT id FROM workbench_thread_state_questionnaires WHERE legacy_id = 'old-shadow-id'").get(),
      { id: first.itemId });
    assert.deepEqual(database.prepare("SELECT questionnaire_id, answer FROM workbench_thread_state_questionnaire_answers").all(),
      [{ questionnaire_id: first.itemId, answer: "Yes" }]);
    assert.deepEqual(database.prepare("SELECT id FROM thread_items").all(), []);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});

test("layout identities remain opaque and stable when sections and titles change", () => {
  const database = openDatabase();
  try {
    seedIdentities(database, "project", "first", "second");
    const folderId = "c02d3d83-776f-44f2-8810-ed5329d1e305";
    const otherFolderId = "920a94b2-8370-430f-be08-fea7ac56d2d1";
    const document = (section: "pinned" | "settled", title: string) => ({
      drafts: [], records: [], newThreadProfile: null, version: 4,
      displayOrder: {
        [section]: {
          [`folder:${folderId}`]: { above: [], below: [`folder:${otherFolderId}`] },
          [`folder:${otherFolderId}`]: { above: [`folder:${folderId}`], below: [] },
        },
        folders: [
          { folderId, section, threadKeys: ["codex:first"], title },
          { folderId: otherFolderId, section, threadKeys: ["codex:second"], title: "Other" },
        ],
      },
    });
    const write = (section: "pinned" | "settled", title: string) => database.prepare(`
      INSERT INTO workbench_thread_state_projects(project_id, document_json, updated_at)
      VALUES ('project', ?, 10) ON CONFLICT(project_id) DO UPDATE SET document_json = excluded.document_json
    `).run(JSON.stringify(document(section, title)));
    const repository = new WorkbenchThreadStateRelationalRepository(database);
    write("pinned", "Before");
    database.exec(`
      INSERT INTO workbench_thread_state_layouts(id, owner_kind, revision) VALUES ('project:project', 'project', 0);
      INSERT INTO workbench_thread_state_project_layouts(layout_id, project_id) VALUES ('project:project', 'project');
    `);
    database.prepare(`
      INSERT INTO workbench_thread_state_layout_folders(folder_id, layout_id, layout_owner_kind, section, title)
      VALUES (?, 'project:project', 'project', 'pinned', 'Before')
    `).run(folderId);
    database.exec(`
      INSERT INTO workbench_thread_state_layout_items(id, layout_id, section, item_kind)
      VALUES ('layout-item:old-folder', 'project:project', 'pinned', 'folder');
    `);
    database.prepare(`
      INSERT INTO workbench_thread_state_layout_folder_items(item_id, folder_id) VALUES ('layout-item:old-folder', ?)
    `).run(folderId);
    assert.equal(repository.rebuild({ now: 20, parents: [] }).state, "complete");
    const readIdentities = () => ({
      layouts: database.prepare("SELECT id, owner_kind FROM workbench_thread_state_layouts ORDER BY owner_kind").all(),
      items: database.prepare(`
        SELECT item.id, item.layout_id, folder.folder_id FROM workbench_thread_state_layout_items item
        JOIN workbench_thread_state_layout_folder_items folder ON folder.item_id = item.id ORDER BY folder.folder_id
      `).all() as Array<{ id: string; layout_id: string; folder_id: string }>,
    });
    const before = readIdentities();
    assert.equal(before.items.length, 2);
    for (const { id } of before.items) assert.equal(z.uuid().safeParse(id).success, true);
    for (const layout of before.layouts as Array<{ id: string }>) assert.equal(z.uuid().safeParse(layout.id).success, true);
    const retained = before.items.find((item) => item.folder_id === folderId)!;
    const members = database.prepare(`
      SELECT folder_item_id, member_item_id, member_index FROM workbench_thread_state_folder_members
      ORDER BY folder_item_id, member_index
    `).all();
    assert.equal(members.length, 2);
    assert.deepEqual(database.prepare("SELECT id FROM workbench_thread_state_layout_items WHERE legacy_id = ?")
      .get("layout-item:old-folder"), { id: retained.id });
    assert.deepEqual(database.prepare("SELECT id FROM workbench_thread_state_layouts WHERE legacy_id = ?")
      .get("project:project"), { id: retained.layout_id });
    write("settled", "After");
    assert.equal(repository.rebuild({ now: 21, parents: [] }).state, "complete");
    assert.deepEqual(readIdentities(), before);
    assert.deepEqual(database.prepare(`
      SELECT folder_item_id, member_item_id, member_index FROM workbench_thread_state_folder_members
      ORDER BY folder_item_id, member_index
    `).all(), members);
    assert.deepEqual(database.prepare(`
      SELECT section, title FROM workbench_thread_state_layout_folders WHERE folder_id = ?
    `).get(folderId), { section: "settled", title: "After" });
    const related = database.prepare("SELECT item_id, related_item_id FROM workbench_thread_state_layout_relations")
      .all() as Array<{ item_id: string; related_item_id: string }>;
    assert.equal(related.length, 2);
    assert.ok(related.every(({ item_id, related_item_id }) => (
      before.items.some(({ id }) => id === item_id) && before.items.some(({ id }) => id === related_item_id)
    )));
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});

test("a current project document becomes constrained relational shadow rows", () => {
  const database = openDatabase();
  try {
    const [threadId] = seedIdentities(database, "project", "thread");
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
    const status = repository.rebuild({ now: 20, parents: [] });
    assert.equal(status.state, "complete");
    assert.equal(status.mismatchCount, 0);
    assert.equal(status.projectedThreadCount, 1);
    assert.deepEqual(database.prepare("SELECT id FROM workbench_thread_state_threads").all(), [{ id: threadId }]);
    assert.equal((database.prepare("SELECT COUNT(*) count FROM workbench_thread_state_drafts").get() as { count: number }).count, 1);
    assert.equal((database.prepare("SELECT COUNT(*) count FROM workbench_thread_state_draft_attachments").get() as { count: number }).count, 1);
    const oldReference = "thread:7:project5:codex6:thread";
    database.transaction(() => {
      database.pragma("defer_foreign_keys = ON");
      database.prepare("UPDATE workbench_thread_state_threads SET id = ? WHERE id = ?").run(oldReference, threadId);
      database.prepare("UPDATE workbench_thread_state_provider_identities SET thread_id = ? WHERE thread_id = ?").run(oldReference, threadId);
      database.prepare("UPDATE workbench_thread_state_lifecycles SET thread_id = ? WHERE thread_id = ?").run(oldReference, threadId);
    })();
    assert.equal(repository.rebuild({ now: 20, parents: [] }).state, "complete");
    assert.deepEqual(database.prepare("SELECT id FROM workbench_thread_state_threads").all(), [{ id: threadId }]);
    assert.deepEqual(database.prepare("SELECT thread_id FROM workbench_thread_state_lifecycles").all(), [{ thread_id: threadId }]);
    assert.equal(new WorkbenchThreadIdentityRepository(database).resolve({ threadId: oldReference })?.threadId, threadId);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    const changesBeforeRepeat = (
      database.prepare("SELECT total_changes() changes").get() as { changes: number }
    ).changes;
    repository.rebuild({ now: 21, parents: [] });
    const repeatedChanges = (
      database.prepare("SELECT total_changes() changes").get() as { changes: number }
    ).changes - changesBeforeRepeat;
    assert.equal(repeatedChanges <= 2, true);

    database.prepare(`
      UPDATE workbench_thread_state_projects
      SET document_json = ?, updated_at = 22
      WHERE project_id = 'project'
    `).run(JSON.stringify({ drafts: [], newThreadProfile: null, records: [], version: 4 }));
    const emptied = repository.rebuild({ now: 23, parents: [] });
    assert.equal(emptied.state, "complete");
    assert.equal(emptied.projectedThreadCount, 0);
    assert.equal((database.prepare("SELECT COUNT(*) count FROM workbench_thread_state_drafts").get() as { count: number }).count, 0);
    assert.equal((database.prepare("SELECT COUNT(*) count FROM workbench_thread_state_draft_attachments").get() as { count: number }).count, 0);
  } finally {
    database.close();
  }
});

test("provider thread identities are scoped to their project", () => {
  const database = openDatabase();
  try {
    seedIdentities(database, "project-a", "shared-provider-id");
    seedIdentities(database, "project-b", "shared-provider-id");
    const document = (title: string) => JSON.stringify({
      drafts: [], newThreadProfile: null, version: 4,
      records: [{
        activityAt: 5, entryKind: "thread", gitHistoryCleanedAt: null,
        identity: { harness: "codex", threadId: "shared-provider-id" },
        lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
        mcpGeneration: null, metadata: { archived: false, pinned: false, snoozed: false },
        profile: null, providerObserved: true, settledAt: null, snoozedUntil: null, title,
      }],
    });
    database.prepare(`
      INSERT INTO workbench_thread_state_projects(project_id, document_json, updated_at)
      VALUES ('project-a', ?, 10), ('project-b', ?, 10)
    `).run(document("A"), document("B"));
    const status = new WorkbenchThreadStateRelationalRepository(database).rebuild({ now: 20, parents: [] });
    assert.equal(status.state, "complete");
    assert.equal(status.projectedThreadCount, 2);
    assert.deepEqual(database.prepare(`
      SELECT project_id, provider_thread_id FROM workbench_thread_state_provider_identities ORDER BY project_id
    `).all(), [
      { project_id: "project-a", provider_thread_id: "shared-provider-id" },
      { project_id: "project-b", provider_thread_id: "shared-provider-id" },
    ]);
  } finally {
    database.close();
  }
});

test("shadow does not allocate canonical identity from an unresolved provider reference", () => {
  const database = openDatabase();
  try {
    const result = new WorkbenchThreadStateRelationalRepository(database).rebuild({
      now: 10,
      parents: [{
        harness: "codex", projectId: "project", parentThreadId: "unobserved",
        nextDirectSubagentIndex: 0, relationships: [],
      }],
    });
    assert.equal(result.state, "failed");
    assert.deepEqual(database.prepare("SELECT id FROM workbench_thread_state_threads").all(), []);
    assert.deepEqual(database.prepare("SELECT id FROM workbench_threads").all(), []);
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
    seedIdentities(database, "project", "parent", "child");
    const repository = new WorkbenchThreadStateRelationalRepository(database);
    const status = repository.rebuild({
      now: 10,
      parents: [{
        harness: "codex",
        nextDirectSubagentIndex: 1,
        parentThreadId: "parent",
        projectId: "project",
        relationships: [{
          kind: "active",
          createdAt: 1, cwd: "C:/project", directSubagentIndex: 0, harness: "codex",
          name: "child", parentThreadId: "parent", profileId: "profile", profileName: "Profile",
          projectId: "project", threadId: "child", title: "Child", updatedAt: 2,
        }],
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

test("historical subagents do not reserve active sibling names or indexes", () => {
  const database = openDatabase();
  try {
    seedIdentities(database, "project", "parent", "historical-child", "active-child");
    database.prepare(`
      INSERT INTO workbench_thread_state_projects(project_id, document_json, updated_at)
      VALUES ('project', ?, 10)
    `).run(JSON.stringify({
      drafts: [],
      newThreadProfile: null,
      records: [{
        activityAt: 2,
        createdAt: 1,
        cwd: "C:/project",
        directSubagentIndex: 0,
        entryKind: "subagent",
        identity: { harness: "codex", threadId: "historical-child" },
        lifecycle: { kind: "completed", reason: "providerInactive", settled: true },
        name: "child",
        parentThreadId: "parent",
        pinned: false,
        profileId: "profile",
        profileName: "Profile",
        projectId: "project",
        title: "Historical child",
        updatedAt: 2,
      }],
      version: 4,
    }));
    const repository = new WorkbenchThreadStateRelationalRepository(database);
    const status = repository.rebuild({
      now: 10,
      parents: [{
        harness: "codex",
        nextDirectSubagentIndex: 1,
        parentThreadId: "parent",
        projectId: "project",
        relationships: [{
          kind: "active",
          createdAt: 3, cwd: "C:/project", directSubagentIndex: 0, harness: "codex",
          name: "child", parentThreadId: "parent", profileId: "profile", profileName: "Profile",
          projectId: "project", threadId: "active-child", title: "Active child", updatedAt: 4,
        }],
      }],
    });
    assert.equal(status.state, "complete");
    assert.equal(status.projectedSubagentCount, 2);
    assert.deepEqual(database.prepare(`
      SELECT provider_thread_id
      FROM workbench_thread_state_active_subagent_relationships
      JOIN workbench_thread_state_provider_identities
        ON workbench_thread_state_active_subagent_relationships.thread_id
          = workbench_thread_state_provider_identities.thread_id
    `).all(), [{ provider_thread_id: "active-child" }]);
  } finally {
    database.close();
  }
});

test("active sibling names stay unique without exposing source values in failure status", () => {
  const database = openDatabase();
  try {
    seedIdentities(database, "project", "parent", "private-child-a", "private-child-b");
    const relationship = (threadId: string, name: string, directSubagentIndex: number) => ({
      kind: "active" as const,
      createdAt: 1,
      cwd: "C:/private-project",
      directSubagentIndex,
      harness: "codex" as const,
      name,
      parentThreadId: "parent",
      profileId: "profile",
      profileName: "Profile",
      projectId: "project",
      threadId,
      title: `Private ${name}`,
      updatedAt: 2,
    });
    const status = new WorkbenchThreadStateRelationalRepository(database).rebuild({
      now: 10,
      parents: [{
        harness: "codex",
        nextDirectSubagentIndex: 2,
        parentThreadId: "parent",
        projectId: "project",
        relationships: [
          relationship("private-child-a", "Secret sibling", 0),
          relationship("private-child-b", "SECRET SIBLING", 1),
        ],
      }],
    });
    assert.equal(status.state, "failed");
    assert.equal(status.errorCode, "constraint-failure");
    assert.equal(
      status.errorText,
      "Thread-state projection failed: SQLite constraint failure (workbench_thread_state_subagent_relationships.parent_id, workbench_thread_state_subagent_relationships.name_key).",
    );
    assert.equal(status.errorText.includes("Secret sibling"), false);
    assert.equal(status.errorText.includes("private-child"), false);
    assert.equal(status.errorText.includes("C:/private-project"), false);
  } finally {
    database.close();
  }
});

test("pending relationships do not create fake provider threads", () => {
  const database = openDatabase();
  try {
    seedIdentities(database, "project", "parent");
    const repository = new WorkbenchThreadStateRelationalRepository(database);
    const status = repository.rebuild({
      now: 10,
      parents: [{
        harness: "codex",
        nextDirectSubagentIndex: 4,
        parentThreadId: "parent",
        projectId: "project",
        relationships: [{
          kind: "reserved",
          createdAt: 1, cwd: "C:/project", directSubagentIndex: 3, harness: "codex",
          name: "child", parentThreadId: "parent", profileId: "profile", profileName: "Profile",
          projectId: "project", reservationId: "0381be91-5c87-435d-8e0c-2f14291c27e3", title: "Child", updatedAt: 2,
        }],
      }],
    });
    assert.equal(status.state, "complete");
    assert.equal((database.prepare(`
      SELECT COUNT(*) count FROM workbench_thread_state_provider_identities WHERE provider_thread_id LIKE 'pending:%'
    `).get() as { count: number }).count, 0);
    assert.deepEqual(database.prepare(`
      SELECT relationship_kind, reservation_id
      FROM workbench_thread_state_pending_subagent_relationships
    `).get(), { relationship_kind: "pending", reservation_id: "0381be91-5c87-435d-8e0c-2f14291c27e3" });
    assert.equal((database.prepare(`
      SELECT next_direct_subagent_index FROM workbench_thread_state_subagent_parents
    `).get() as { next_direct_subagent_index: number }).next_direct_subagent_index, 4);
  } finally {
    database.close();
  }
});

test("subagent relationship identity survives activation and legacy conversion rolls back on failure", () => {
  const database = openDatabase();
  try {
    seedIdentities(database, "project", "parent", "active-child");
    const repository = new WorkbenchThreadStateRelationalRepository(database);
    const relationship = {
      kind: "reserved" as const,
      createdAt: 1, cwd: "C:/project", directSubagentIndex: 3, harness: "codex" as const,
      name: "child", parentThreadId: "parent", profileId: "profile", profileName: "Profile",
      projectId: "project", reservationId: "8761ec4e-6e44-427e-a6a7-fe7b7cc2c511", title: "Child", updatedAt: 2,
    };
    const parent = {
      harness: "codex" as const, nextDirectSubagentIndex: 4, parentThreadId: "parent",
      projectId: "project", relationships: [relationship],
    };
    assert.equal(repository.rebuild({ now: 10, parents: [parent] }).state, "complete");
    const ids = database.prepare(`
      SELECT parent_id, id FROM workbench_thread_state_subagent_relationships
    `).get() as { parent_id: string; id: string };
    assert.equal(z.uuid().safeParse(ids.id).success, true);
    assert.equal(z.uuid().safeParse(ids.parent_id).success, true);
    database.transaction(() => {
      database.pragma("defer_foreign_keys = ON");
      database.prepare("UPDATE workbench_thread_state_subagent_parents SET id = 'old-parent' WHERE id = ?")
        .run(ids.parent_id);
      database.prepare("UPDATE workbench_thread_state_subagent_relationships SET parent_id = 'old-parent', id = 'old-child' WHERE id = ?")
        .run(ids.id);
      database.prepare("UPDATE workbench_thread_state_pending_subagent_relationships SET relationship_id = 'old-child' WHERE relationship_id = ?")
        .run(ids.id);
    })();
    const failed = repository.rebuild({ now: 11, parents: [{
      ...parent,
      relationships: [relationship, { ...relationship, directSubagentIndex: 4, reservationId: "c8e110f9-570a-4319-a0c3-069601b26a48" }],
    }] });
    assert.equal(failed.state, "failed");
    assert.deepEqual(database.prepare(`
      SELECT parent_id, id FROM workbench_thread_state_subagent_relationships
    `).get(), { parent_id: "old-parent", id: "old-child" });
    assert.deepEqual(database.prepare(`
      SELECT relationship_id FROM workbench_thread_state_pending_subagent_relationships
    `).get(), { relationship_id: "old-child" });
    assert.equal(repository.rebuild({ now: 12, parents: [parent] }).state, "complete");
    const converted = database.prepare(`
      SELECT parent_id, id FROM workbench_thread_state_subagent_relationships WHERE legacy_id = 'old-child'
    `).get() as { parent_id: string; id: string };
    assert.ok(converted);
    assert.equal(z.uuid().safeParse(converted.id).success, true);
    assert.equal(z.uuid().safeParse(converted.parent_id).success, true);
    assert.deepEqual(database.prepare(`
      SELECT id FROM workbench_thread_state_subagent_parents WHERE legacy_id = 'old-parent'
    `).get(), { id: converted.parent_id });
    const { kind: _kind, reservationId: _reservationId, ...metadata } = relationship;
    const active = { ...parent, relationships: [{ ...metadata, kind: "active" as const, threadId: "active-child", title: "Running", updatedAt: 13 }] };
    assert.equal(repository.rebuild({ now: 13, parents: [active] }).state, "complete");
    assert.deepEqual(database.prepare(`
      SELECT parent_id, id FROM workbench_thread_state_subagent_relationships
    `).get(), converted);
    assert.equal(database.prepare("SELECT relationship_id FROM workbench_thread_state_pending_subagent_relationships").get(), undefined);
    assert.deepEqual(database.prepare(`
      SELECT relationship_id FROM workbench_thread_state_active_subagent_relationships
    `).get(), { relationship_id: converted.id });
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});

test("a failed rebuild rolls back rows and records bounded failed status", () => {
  const database = openDatabase();
  try {
    seedIdentities(database, "project", "preserved-thread");
    database.prepare(`
      INSERT INTO workbench_thread_state_projects(project_id, document_json, updated_at)
      VALUES ('project', ?, 10)
    `).run(JSON.stringify({
      drafts: [],
      newThreadProfile: null,
      records: [{
        activityAt: 5, entryKind: "thread", gitHistoryCleanedAt: null,
        identity: { harness: "codex", threadId: "preserved-thread" },
        lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
        mcpGeneration: null, metadata: { archived: false, pinned: false, snoozed: false },
        profile: null, providerObserved: true, settledAt: null, snoozedUntil: null, title: "Preserved",
      }],
      version: 4,
    }));
    const repository = new WorkbenchThreadStateRelationalRepository(database);
    const complete = repository.rebuild({ now: 10, parents: [] });
    assert.equal(complete.state, "complete");
    database.prepare(`
      UPDATE workbench_thread_state_projects
      SET document_json = ?, updated_at = 20
      WHERE project_id = 'project'
    `).run(JSON.stringify({ drafts: [], newThreadProfile: null, records: [{}], version: 4 }));
    const failed = repository.rebuild({ now: 20, parents: [] });
    assert.equal(failed.state, "failed");
    assert.equal(failed.errorCode, "projection-failure");
    assert.match(failed.errorText ?? "", /projection failed/u);
    assert.equal(failed.errorText?.includes("secret"), false);
    assert.equal(failed.projectedThreadCount, 1);
    assert.equal((database.prepare("SELECT COUNT(*) count FROM workbench_thread_state_threads").get() as { count: number }).count, 1);
  } finally {
    database.close();
  }
});
