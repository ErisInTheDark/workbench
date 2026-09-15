/*
 * No exports. Tests protect source preservation and receipt-last cutover.
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { applyWorkbenchDatabaseSchema } from "workbench-shared/database/schema/schema-history";
import { defineRelationalThreadStateSchema } from "../workbench-database-schema";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchThreadStateMigration, { type WorkbenchThreadStateRelationshipSource } from "./WorkbenchThreadStateMigration";
import { parseProjectImport } from "./workbench-thread-state-document-source";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  NativeThreadId: {
    "empty-parent": fixtureIdentitySchemas.NativeThreadIdSchema.parse("empty-parent"),
    "parent-native": fixtureIdentitySchemas.NativeThreadIdSchema.parse("parent-native"),
    "retained-parent": fixtureIdentitySchemas.NativeThreadIdSchema.parse("retained-parent"),
  },
  ProjectId: {
    "other": fixtureIdentitySchemas.ProjectIdSchema.parse("other"),
    "project": fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  },
  ThreadReference: {
    "child": fixtureIdentitySchemas.ThreadReferenceSchema.parse("child"),
    "empty-parent": fixtureIdentitySchemas.ThreadReferenceSchema.parse("empty-parent"),
    "parent-native": fixtureIdentitySchemas.ThreadReferenceSchema.parse("parent-native"),
    "retained-parent": fixtureIdentitySchemas.ThreadReferenceSchema.parse("retained-parent"),
  },
};

const schema = defineRelationalThreadStateSchema(23);

test("thread conversion stops before project conversion and verifies after its consumed source is retired", () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  try {
    const migration = new WorkbenchThreadStateMigration(database);
    migration.run(schema, [], 1);
    assert.equal(database.pragma("user_version", { simple: true }), 31);
    database.exec("DROP TABLE workbench_thread_state_projects");
    assert.deepEqual(migration.run(schema, [], 2), { imported: false });
  } finally { database.close(); }
});

test("missing parent metadata preserves relationship ownership without inventing a harness", () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  try {
    applyWorkbenchDatabaseSchema(database, schema, { targetVersion: 22 });
    const relationships: WorkbenchThreadStateRelationshipSource[] = [{
      parentThreadId: fixtureIdentityValues.ThreadReference["retained-parent"], nextDirectSubagentIndex: 5,
      relationships: [{
        kind: "active", threadId: fixtureIdentityValues.ThreadReference["child"], parentThreadId: fixtureIdentityValues.ThreadReference["retained-parent"], projectId: fixtureIdentityValues.ProjectId["project"],
        harness: "opencode", cwd: "C:/Retained/Project", name: "child", title: "child",
        profileId: "profile", profileName: "profile", createdAt: 1, updatedAt: 2, directSubagentIndex: 4,
      }],
    }];
    const migration = new WorkbenchThreadStateMigration(database);
    const conflicting = structuredClone(relationships);
    conflicting[0]!.relationships.push({ ...conflicting[0]!.relationships[0]!, projectId: fixtureIdentityValues.ProjectId["other"] });
    assert.throws(() => migration.run(schema, conflicting, 30), /project ownership/);
    assert.equal(database.pragma("user_version", { simple: true }), 22);
    assert.equal(database.prepare("SELECT count(*) FROM workbench_threads").pluck().get(), 0);
    migration.run(schema, relationships, 31);
    const identities = new WorkbenchThreadIdentityRepository(database);
    const parent = identities.resolve({ projectId: fixtureIdentityValues.ProjectId["project"], threadId: fixtureIdentitySchemas.ThreadReferenceSchema.parse("retained-parent") })!;
    assert.deepEqual(parent.bindings, []);
    assert.equal(database.prepare("SELECT count(*) FROM workbench_thread_states WHERE thread_id = ?").pluck().get(parent.threadId), 0);
    assert.equal(database.prepare("SELECT next_direct_subagent_index FROM workbench_subagent_parents WHERE parent_thread_id = ?").pluck().get(parent.threadId), 5);
    assert.equal(identities.observe({
      native: { harness: "codex", nativeThreadId: fixtureIdentityValues.NativeThreadId["retained-parent"], nativeLocation: "C:/Retained/Project" },
      projectId: fixtureIdentityValues.ProjectId["project"], projectRoot: "C:/Retained/Project", title: "real parent", createdAt: 1, updatedAt: 40, activityAt: 40,
    }).threadId, parent.threadId);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally { database.close(); }
});

test("conversion admits archived metadata and preserves canonical titles, empty parents and reservations across rollback and retry", () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  try {
    applyWorkbenchDatabaseSchema(database, schema, { targetVersion: 22 });
    const identities = new WorkbenchThreadIdentityRepository(database);
    const projectRoot = path.resolve("migration-project");
    const parent = identities.observe({
      native: { harness: "codex", nativeThreadId: fixtureIdentityValues.NativeThreadId["parent-native"], nativeLocation: projectRoot },
      projectId: fixtureIdentityValues.ProjectId["project"], projectRoot, title: "parent", createdAt: 1, updatedAt: 1, activityAt: 1,
    });
    const emptyParent = identities.observe({
      native: { harness: "codex", nativeThreadId: fixtureIdentityValues.NativeThreadId["empty-parent"], nativeLocation: projectRoot },
      projectId: fixtureIdentityValues.ProjectId["project"], projectRoot, title: "empty parent", createdAt: 1, updatedAt: 1, activityAt: 1,
    });
    const source = JSON.stringify({
      version: 4, newThreadProfile: null, drafts: [], displayOrder: {},
      records: [{
        entryKind: "thread", identity: { harness: "copilot", threadId: "archived-native" },
        title: "current title", activityAt: 17, orderAt: 12, providerObserved: false,
        metadata: { archived: true, pinned: false, snoozed: false },
        lifecycle: { kind: "completed", reason: "userCompleted", settled: true },
        gitArc: null, settledAt: 10, gitHistoryCleanedAt: null,
        mcpGeneration: "retained-generation", profile: null, snoozedUntil: null,
      }],
    });
    database.prepare("INSERT INTO workbench_thread_state_projects(project_id, document_json, updated_at) VALUES (?, ?, ?)").run("project", source, 20);
    database.prepare("INSERT INTO workbench_thread_title_history(project_id, harness_id, thread_id, title, used_at) VALUES (?, ?, ?, ?, ?)").run(
      "project", "copilot", "archived-native", "previous title", 4,
    );
    const relationships: WorkbenchThreadStateRelationshipSource[] = [{
      parentThreadId: fixtureIdentityValues.ThreadReference["parent-native"], nextDirectSubagentIndex: 17,
      relationships: [{
        kind: "reserved" as const, reservationId: "74eb14aa-97bc-43e6-a37f-e2633bf88d6b",
        parentThreadId: fixtureIdentityValues.ThreadReference["parent-native"], projectId: fixtureIdentityValues.ProjectId["project"], harness: "opencode" as const,
        cwd: projectRoot, name: "reserved child", title: "reserved title", profileId: "profile", profileName: "profile name",
        createdAt: 3, updatedAt: 5, directSubagentIndex: 2,
      }],
    }, { parentThreadId: fixtureIdentityValues.ThreadReference["empty-parent"], nextDirectSubagentIndex: 9, relationships: [] }];
    // Fail after readback but before the receipt. Both DDL and admitted identities
    // must roll back with the source-document deletion.
    database.exec("CREATE TRIGGER fail_retirement BEFORE DELETE ON workbench_thread_state_projects BEGIN SELECT RAISE(ABORT, 'injected retirement failure'); END");
    const migration = new WorkbenchThreadStateMigration(database);
    assert.throws(() => migration.run(schema, relationships, 30), /injected retirement failure/);
    assert.equal(database.pragma("user_version", { simple: true }), 22);
    assert.equal(database.prepare("SELECT document_json FROM workbench_thread_state_projects").pluck().get(), source);
    assert.equal(identities.resolve({ projectId: fixtureIdentityValues.ProjectId["project"], harness: "copilot", threadId: fixtureIdentitySchemas.ThreadReferenceSchema.parse("archived-native") }), null);
    assert.equal(database.prepare("SELECT name FROM sqlite_schema WHERE name = 'workbench_thread_state_import'").get(), undefined);
    database.exec("DROP TRIGGER fail_retirement");
    assert.deepEqual(migration.run(schema, relationships, 31), { imported: true });

    const archived = identities.resolve({ projectId: fixtureIdentityValues.ProjectId["project"], harness: "copilot", threadId: fixtureIdentitySchemas.ThreadReferenceSchema.parse("archived-native") })!;
    assert.ok(archived);
    assert.deepEqual(database.prepare(`
      SELECT state.title, state.activity_at, state.provider_observed, top.archived, top.order_at,
        lifecycle.lifecycle_kind, lifecycle.settled, retention.mcp_generation
      FROM workbench_thread_states state
      JOIN workbench_top_level_thread_states top USING(thread_id)
      JOIN workbench_thread_lifecycle lifecycle USING(thread_id)
      JOIN workbench_thread_retention retention USING(thread_id)
      WHERE state.thread_id = ?
    `).get(archived.threadId), {
      title: "current title", activity_at: 17, provider_observed: 0, archived: 1, order_at: 12,
      lifecycle_kind: "completed", settled: 1, mcp_generation: "retained-generation",
    });
    assert.deepEqual(database.prepare("SELECT thread_id, title, used_at FROM workbench_thread_title_history").all(), [
      { thread_id: archived.threadId, title: "previous title", used_at: 4 },
    ]);
    assert.deepEqual(database.prepare("SELECT parent_thread_id, next_direct_subagent_index FROM workbench_subagent_parents ORDER BY parent_thread_id").all(), [
      { parent_thread_id: parent.threadId, next_direct_subagent_index: 17 },
      { parent_thread_id: emptyParent.threadId, next_direct_subagent_index: 9 },
    ].sort((left, right) => left.parent_thread_id.localeCompare(right.parent_thread_id)));
    assert.deepEqual(database.prepare("SELECT relationship_kind, direct_subagent_index FROM workbench_subagent_relationships").all(), [
      { relationship_kind: "reserved", direct_subagent_index: 2 },
    ]);
    assert.equal(database.prepare("SELECT has_value FROM workbench_thread_git_observations WHERE thread_id = ? AND observation_kind = 'arc'").pluck().get(archived.threadId), 0);
    assert.equal(database.prepare("SELECT count(*) FROM workbench_thread_state_projects").pluck().get(), 0);
    assert.deepEqual(migration.run(schema, [], 32), { imported: false });
    assert.equal(database.prepare("SELECT completed_at FROM workbench_thread_state_import").pluck().get(), 31);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});

test("conversion refuses a source fact that compatibility repair would discard", () => {
  const source = {
    version: 4, drafts: [], newThreadProfile: null,
    records: [{
      entryKind: "thread", identity: { harness: "codex", threadId: "native" },
      title: "title", activityAt: 1, lifecycle: { kind: "completed", reason: "userCompleted", settled: true },
      metadata: { archived: true, pinned: false, snoozed: false },
      gitArc: { importantUnsupportedFact: "must survive" },
    }],
  };
  assert.throws(() => parseProjectImport(JSON.stringify(source), fixtureIdentityValues.ProjectId["project"]), /import would/);
});

test("draft conversion uses composer settings without retaining conflicting aliases", () => {
  const settings = {
    agentPath: null, agentSource: null, harness: "copilot", model: "current",
    reasoningEffort: null, serviceTier: null,
  };
  const draft = {
    draftId: fixtureIdentitySchemas.DraftIdSchema.parse("b15d6643-e876-407d-a706-27c832ab47e5"), projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    attachments: [], clientUpdatedAt: 1, createdAt: 1, updatedAt: 1, profileId: null, prompt: "preserve",
    composerSettings: settings, harness: "codex", model: "old",
    agent: "old-agent", reasoningEffort: "old-effort", serviceTier: "old-tier",
  };
  const source = (value: object) => JSON.stringify({ version: 4, records: [], drafts: [value], newThreadProfile: null });
  const converted = parseProjectImport(source(draft), fixtureIdentityValues.ProjectId["project"]).drafts[0]!;
  assert.deepEqual(converted.composerSettings, settings);
  assert.equal(converted.prompt, draft.prompt);
  assert.deepEqual(parseProjectImport(source(converted), fixtureIdentityValues.ProjectId["project"]).drafts, [converted]);
  const recovered = parseProjectImport(source({ ...draft, composerSettings: {} }), fixtureIdentityValues.ProjectId["project"]).drafts[0]!;
  assert.equal(recovered.composerSettings.harness, "codex");
  assert.equal(recovered.composerSettings.model, "old");
  assert.throws(() => parseProjectImport(source({ ...draft, unsupportedFact: true }), fixtureIdentityValues.ProjectId["project"]), /draft facts/);
});
