/*
 * No production exports. Protect affected-fact commits and selection before payload reads.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { getProjectQualifiedThreadDisplayKey } from "workbench-shared/workbench/thread/thread-display-layout";
import type { WorkbenchThreadDraft, WorkbenchThreadLifecycle } from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchThreadStateRecord } from "../../workbench-thread-state-record";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchThreadStateRelationalRepository from "./WorkbenchThreadStateRelationalRepository";
import { parseProjectDocument } from "./workbench-thread-state-document-source";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  DraftId: {
    "f8b1c9b1-9b70-43af-a3e7-8c9e7d7ee83f": fixtureIdentitySchemas.DraftIdSchema.parse("f8b1c9b1-9b70-43af-a3e7-8c9e7d7ee83f"),
  },
  ProjectId: {
    "other": fixtureIdentitySchemas.ProjectIdSchema.parse("local:///other"),
    "project": fixtureIdentitySchemas.ProjectIdSchema.parse("local:///project"),
  },
};

function openDatabase() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  return database;
}

function seedIdentities(database: Database.Database, projectId: keyof typeof fixtureIdentityValues.ProjectId, ...nativeIds: string[]) {
  const owner = new WorkbenchThreadIdentityRepository(database);
  return nativeIds.map((nativeThreadId) => owner.observe({
    native: { harness: "codex", nativeLocation: `C:/${projectId}`, nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse(nativeThreadId) },
    projectId: fixtureIdentityValues.ProjectId[projectId], projectRoot: `C:/${projectId}`, title: nativeThreadId, createdAt: 1, updatedAt: 2, activityAt: 2,
  }).threadId);
}

test("draft-only writes require admitted parents and retained addresses share profiles and layouts", () => {
  const database = openDatabase();
  const repository = new WorkbenchThreadStateRelationalRepository(database);
  const projectId = fixtureIdentitySchemas.ProjectIdSchema.parse("local://C:/draft-only");
  const legacy = fixtureIdentitySchemas.ProjectIdSchema.parse("old-drafts");
  const draft: WorkbenchThreadDraft = {
    draftId: fixtureIdentityValues.DraftId["f8b1c9b1-9b70-43af-a3e7-8c9e7d7ee83f"], projectId,
    prompt: "retained", profileId: null, attachments: [{ id: "image", url: "image:retained" }],
    composerSettings: { harness: "codex", agentPath: null, agentSource: null, model: "model", reasoningEffort: null, serviceTier: null },
    clientUpdatedAt: 1, createdAt: 1, updatedAt: 1,
  };
  try {
    assert.throws(() => repository.readProject(projectId), /project/i);
    assert.throws(() => repository.readDrafts(projectId), /project/i);
    assert.throws(() => repository.readProjectProfile(projectId), /project/i);
    assert.throws(() => repository.readLayout({ kind: "project", projectId }), /project/i);
    assert.throws(() => repository.writeDrafts([{ draft, pinned: false, snoozed: false }]), /project/i);
    assert.equal(database.prepare("SELECT count(*) FROM workbench_projects").pluck().get(), 0);
    database.prepare("INSERT INTO workbench_projects(id) VALUES (?)").run(projectId);
    repository.writeDrafts([{ draft, pinned: false, snoozed: false }]);
    assert.ok(database.prepare("SELECT id FROM workbench_projects WHERE id = ?").get(projectId));
    database.prepare("INSERT INTO workbench_project_aliases(alias, project_id) VALUES (?, ?)").run(legacy, projectId);
    repository.commit({
      projectId: legacy,
      drafts: [{ draft: { ...draft, projectId: legacy, prompt: "edited" }, pinned: true, snoozed: false }],
      projectProfiles: [{ projectId: legacy, profile: { kind: "custom", settings: draft.composerSettings } }],
      layouts: [{ owner: { kind: "project", projectId: legacy }, revision: 1, displayOrder: {} }],
    });
    assert.deepEqual(repository.readDrafts(legacy), repository.readDrafts(projectId));
    assert.equal(repository.readDrafts(projectId)[0]?.draft.prompt, "edited");
    assert.equal(repository.readDrafts(projectId)[0]?.draft.projectId, projectId);
    assert.deepEqual(repository.readProjectProfile(legacy), { kind: "custom", settings: draft.composerSettings });
    assert.deepEqual(repository.readLayout({ kind: "project", projectId }), { revision: 1, displayOrder: {} });
    assert.throws(() => repository.commit({
      drafts: [{ draft: { ...draft, prompt: "must roll back" }, pinned: false, snoozed: false }],
      layouts: [{ owner: { kind: "project", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("remote://unregistered/project") }, revision: 0, displayOrder: {} }],
    }), /project/i);
    assert.equal(repository.readDrafts(projectId)[0]?.draft.prompt, "edited");
    const draftKey = fixtureIdentitySchemas.ThreadDisplayKeySchema.parse(`draft:${draft.draftId}`);
    const position = { above: [], below: [] };
    repository.commit({ layouts: [{
      owner: { kind: "pinned" }, revision: 2,
      displayOrder: { pinned: { [getProjectQualifiedThreadDisplayKey(legacy, draftKey)]: position } },
    }] });
    assert.deepEqual(repository.readLayout({ kind: "pinned" }), {
      revision: 2, displayOrder: { pinned: { [getProjectQualifiedThreadDisplayKey(projectId, draftKey)]: position } },
    });
    repository.commit({ projectId, deletedDraftIds: [draft.draftId] });
    assert.deepEqual(repository.readDrafts(legacy), []);
  } finally { database.close(); }
});

test("draft writes reject empty content without rejecting attachment-only drafts", () => {
  const database = openDatabase();
  const repository = new WorkbenchThreadStateRelationalRepository(database);
  const projectId = fixtureIdentityValues.ProjectId.project;
  const draft: WorkbenchThreadDraft = {
    attachments: [],
    clientUpdatedAt: 1,
    composerSettings: { harness: "codex", agentPath: null, agentSource: null, model: "model", reasoningEffort: null, serviceTier: null },
    createdAt: 1,
    draftId: fixtureIdentityValues.DraftId["f8b1c9b1-9b70-43af-a3e7-8c9e7d7ee83f"],
    profileId: null,
    projectId,
    prompt: " ",
    updatedAt: 1,
  };
  try {
    database.prepare("INSERT INTO workbench_projects(id) VALUES (?)").run(projectId);
    assert.throws(() => repository.writeDrafts([{ draft, pinned: false, snoozed: false }]), /content/i);
    repository.writeDrafts([{
      draft: { ...draft, attachments: [{ id: "shot", url: "image:shot" }] },
      pinned: false,
      snoozed: false,
    }]);
    assert.equal(repository.readDrafts(projectId).length, 1);
  } finally { database.close(); }
});

test("lifecycle upgrade preserves existing facts and permits thread-owned turnless states", () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  try {
    installWorkbenchDatabaseSchema(database, { targetVersion: 24 });
    const [threadId] = seedIdentities(database, "project", "thread");
    assert.ok(threadId);
    const repository = new WorkbenchThreadStateRelationalRepository(database);
    const record: WorkbenchThreadStateRecord = {
      entryKind: "thread", identity: { harness: "codex", threadId }, title: "Keep this title", activityAt: 7,
      lifecycle: { kind: "working", reason: "acceptedIntent", agent: { agentStatus: "working" }, settled: false },
      metadata: { archived: false, pinned: true, snoozed: false },
      profile: null, providerObserved: true, settledAt: null, gitHistoryCleanedAt: null, mcpGeneration: null, snoozedUntil: null,
    };
    repository.writeRecords([record]);
    const before = database.prepare("SELECT * FROM workbench_thread_lifecycle").all();
    const selection = { selection: "threads" as const, threadIds: [threadId] };
    const saved = repository.readRecords(selection);
    installWorkbenchDatabaseSchema(database);
    assert.deepEqual(database.prepare("SELECT * FROM workbench_thread_lifecycle").all(), before);
    assert.deepEqual(repository.readRecords(selection), saved);
    for (const lifecycle of [
      { kind: "completed", reason: "agentCompleted", agent: { agentStatus: "completed" }, settled: false },
      { kind: "needsAttention", reason: "agentBlocked", agent: { agentStatus: "blocked" }, settled: false },
      { kind: "needsAttention", reason: "pendingInput", requestKey: "question", settled: false },
    ] satisfies WorkbenchThreadLifecycle[]) {
      repository.writeRecords([{ ...record, lifecycle }]);
      assert.deepEqual(repository.readRecords(selection)[0]?.lifecycle, lifecycle);
    }
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally { database.close(); }
});

test("relational batches roll back invalid references and preserve valid draft promotion", () => {
  const database = openDatabase();
  try {
    const [threadId] = seedIdentities(database, "project", "promoted");
    const draft: WorkbenchThreadDraft = {
      draftId: fixtureIdentityValues.DraftId["f8b1c9b1-9b70-43af-a3e7-8c9e7d7ee83f"], projectId: fixtureIdentityValues.ProjectId["project"],
      prompt: "retain this draft", profileId: null,
      composerSettings: { harness: "codex", agentPath: null, agentSource: null, model: "model", reasoningEffort: null, serviceTier: null, contextWindowTokens: 500_000 },
      clientUpdatedAt: 1, createdAt: 1, updatedAt: 1,
      attachments: [{ id: "second", url: "image:second" }, { id: "first", url: "image:first" }],
    };
    const projectOwner = { kind: "project" as const, projectId: fixtureIdentityValues.ProjectId.project };
    const pinnedOwner = { kind: "pinned" as const };
    const draftKey = `draft:${draft.draftId}`;
    const threadKey = `codex:${threadId}`;
    const position = { above: [], below: [] };
    const projectOrder = { pinned: { [draftKey]: position } };
    const pinnedOrder = { pinned: { [getProjectQualifiedThreadDisplayKey(fixtureIdentityValues.ProjectId["project"], fixtureIdentitySchemas.ThreadDisplayKeySchema.parse(draftKey))]: position } };
    const repository = new WorkbenchThreadStateRelationalRepository(database);
    repository.commit({
      drafts: [{ draft, pinned: true, snoozed: false }],
      layouts: [
        { owner: projectOwner, revision: 1, displayOrder: projectOrder },
        { owner: pinnedOwner, revision: 1, displayOrder: pinnedOrder },
      ],
      pinnedImports: [fixtureIdentityValues.ProjectId["project"]],
    });
    assert.deepEqual(repository.readDrafts(fixtureIdentityValues.ProjectId["project"]), [{ draft, pinned: true, snoozed: false }]);
    const record: WorkbenchThreadStateRecord = {
      entryKind: "thread", identity: { harness: "codex", threadId: threadId! }, title: "promoted", activityAt: 1,
      lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
      metadata: { archived: false, pinned: true, snoozed: false },
      profile: { kind: "custom", settings: draft.composerSettings },
      providerObserved: true, settledAt: null, gitHistoryCleanedAt: null, mcpGeneration: null, snoozedUntil: null,
    };
    assert.throws(() => repository.commit({
      records: [record], deletedDraftIds: [draft.draftId],
      layouts: [
        { owner: projectOwner, revision: 2, displayOrder: { pinned: { [threadKey]: position } } },
        { owner: pinnedOwner, revision: 2, displayOrder: {
          pinned: { [getProjectQualifiedThreadDisplayKey(fixtureIdentityValues.ProjectId["project"], fixtureIdentitySchemas.ThreadDisplayKeySchema.parse("draft:missing"))]: position },
        } },
      ],
    }), /missing draft/);
    assert.deepEqual(repository.readDrafts(fixtureIdentityValues.ProjectId["project"]), [{ draft, pinned: true, snoozed: false }]);
    assert.deepEqual(repository.readRecords({ selection: "threads", threadIds: [threadId!] }), []);
    assert.deepEqual(repository.readLayout(projectOwner), { revision: 1, displayOrder: projectOrder });
    assert.deepEqual(repository.readLayout(pinnedOwner), { revision: 1, displayOrder: pinnedOrder });
    const nextPinned = { pinned: { [getProjectQualifiedThreadDisplayKey(fixtureIdentityValues.ProjectId["project"], fixtureIdentitySchemas.ThreadDisplayKeySchema.parse(threadKey))]: position } };
    repository.commit({
      records: [record], deletedDraftIds: [draft.draftId],
      layouts: [
        { owner: projectOwner, revision: 2, displayOrder: { pinned: { [threadKey]: position } } },
        { owner: pinnedOwner, revision: 2, displayOrder: nextPinned },
      ],
    });
    assert.deepEqual(repository.readDrafts(fixtureIdentityValues.ProjectId["project"]), []);
    assert.deepEqual(repository.readLayout(pinnedOwner), { revision: 2, displayOrder: nextPinned });
    assert.equal(repository.readRecords({ selection: "threads", threadIds: [threadId!] })[0]?.title, "promoted");
    assert.deepEqual(repository.readRecords({ selection: "threads", threadIds: [threadId!] })[0]?.profile, record.profile);
    repository.commit({ projectProfiles: [{ projectId: draft.projectId, profile: record.profile }] });
    assert.deepEqual(repository.readProjectProfile(draft.projectId), record.profile);
    assert.deepEqual(repository.readPinnedImports(), [fixtureIdentityValues.ProjectId.project]);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally { database.close(); }
});

test("affected-record writes preserve unchanged caches and roll back an entire failed batch", () => {
  const database = openDatabase();
  try {
    const [firstId, secondId] = seedIdentities(database, "project", "first", "second");
    const record = (threadId: string, title: string): WorkbenchThreadStateRecord => ({
      entryKind: "thread", identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId) }, title, activityAt: 1,
      lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
      metadata: { archived: false, pinned: false, snoozed: false },
      providerObserved: true, settledAt: null, gitHistoryCleanedAt: null, mcpGeneration: null,
      profile: null, snoozedUntil: null, titleHistory: [{ title, usedAt: 1 }],
      gitArcPlan: {
        checkpointCommit: "a".repeat(40), intentName: "retained", intentDescription: "",
        scopePaths: ["path.ts"], updatedAt: "retained timestamp",
      },
    });
    const first = record(firstId!, "first");
    const second = record(secondId!, "second");
    const retainedAddress = fixtureIdentitySchemas.ProjectIdSchema.parse("old-project");
    database.prepare("INSERT INTO workbench_project_aliases(alias, project_id) VALUES (?, ?)").run(retainedAddress, fixtureIdentityValues.ProjectId.project);
    first.snoozedUntil = { projectId: retainedAddress, identity: second.identity };
    const repository = new WorkbenchThreadStateRelationalRepository(database);
    repository.writeRecords([first, second]);
    database.exec(`
      CREATE TEMP TRIGGER reject_cache_rewrite BEFORE UPDATE ON workbench_thread_git_observations
      BEGIN SELECT RAISE(ABORT, 'unchanged cache rewritten'); END
    `);
    database.exec(`
      CREATE TEMP TRIGGER reject_neighbour_rewrite BEFORE UPDATE ON workbench_thread_states
      WHEN OLD.thread_id = '${secondId}' BEGIN SELECT RAISE(ABORT, 'neighbour rewritten'); END
    `);
    repository.commit({ projectId: fixtureIdentityValues.ProjectId["project"], records: [{ ...first, title: "updated" }] });
    const loaded = repository.readRecords({ selection: "threads", threadIds: [firstId!] })[0]!;
    assert.equal(loaded.title, "updated");
    assert.deepEqual(loaded.gitArcPlan, first.gitArcPlan);
    assert.deepEqual(loaded.snoozedUntil, { identity: second.identity, projectId: fixtureIdentityValues.ProjectId.project });
    assert.deepEqual(loaded.titleHistory, first.titleHistory);
    assert.throws(() => repository.writeRecords([
      { ...first, title: "rolled back" }, { ...second, title: "reject" },
    ]), /neighbour rewritten/);
    assert.equal(repository.readRecords({ selection: "threads", threadIds: [firstId!] })[0]?.title, "updated");
    assert.equal(repository.readRecords({ selection: "threads", threadIds: [secondId!] })[0]?.title, "second");
    const [foreignId] = seedIdentities(database, "other", "foreign");
    assert.throws(() => repository.commit({
      projectId: fixtureIdentityValues.ProjectId["project"],
      records: [{ ...first, title: "not committed" }, record(foreignId!, "foreign")],
    }), /project/i);
    assert.equal(repository.readRecords({ selection: "threads", threadIds: [firstId!] })[0]?.title, "updated");
    assert.deepEqual(repository.readRecords({ selection: "threads", threadIds: [foreignId!] }), []);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally { database.close(); }
});

test("unsupported draft attachments fail source admission rather than disappearing during repair", () => {
  assert.throws(() => parseProjectDocument(JSON.stringify({
    version: 4, records: [], drafts: [{
      draftId: fixtureIdentitySchemas.DraftIdSchema.parse("16263085-fd8e-4555-ac66-adf75d59f7c2"), harness: "codex",
      attachments: [{ provider: "opaque" }],
    }],
  }), fixtureIdentityValues.ProjectId["project"]), /unsupported draft attachments/);
});

test("live reads retain parent-status inputs without decoding settled history", () => {
  const database = openDatabase();
  try {
    database.prepare("INSERT INTO workbench_projects(id) VALUES (?)").run(fixtureIdentityValues.ProjectId.other);
    const [live, settled, archived, pinned, child] = seedIdentities(database, "project", "live", "settled", "archived", "pinned", "child");
    for (const [index, threadId] of [live!, settled!, archived!, pinned!, child!].entries()) {
      const isSettled = threadId !== live && threadId !== child;
      database.prepare(`
        INSERT INTO workbench_thread_states(thread_id, thread_kind, harness_id, title, activity_at, provider_observed)
        VALUES (?, ?, 'codex', ?, ?, 1)
      `).run(threadId, threadId === child ? "subagent" : "topLevel", threadId, index + 1);
      database.prepare(`
        INSERT INTO workbench_thread_lifecycle(thread_id, lifecycle_kind, reason, settled, updated_at) VALUES (?, ?, ?, ?, 1)
      `).run(threadId, isSettled ? "completed" : "needsAttention", isSettled ? "providerInactive" : "noActiveTurn", Number(isSettled));
      database.prepare("INSERT INTO workbench_thread_retention(thread_id, settled_at) VALUES (?, ?)").run(threadId, isSettled ? index + 1 : null);
      if (threadId === child) {
        database.prepare(`
          INSERT INTO workbench_subagent_thread_states(
            thread_id, thread_kind, parent_thread_id, cwd, name, profile_id, profile_name,
            direct_subagent_index, created_at, updated_at, pinned
          ) VALUES (?, 'subagent', ?, 'C:/project', 'child', 'profile', 'profile', 0, 1, 1, 0)
        `).run(threadId, live);
      } else {
        database.prepare(`
          INSERT INTO workbench_top_level_thread_states(thread_id, thread_kind, archived, pinned, snoozed)
          VALUES (?, 'topLevel', ?, ?, 0)
        `).run(threadId, Number(threadId === archived), Number(threadId === pinned));
      }
    }
    database.prepare(`
      INSERT INTO workbench_thread_git_observations(id, thread_id, observation_kind, has_value)
      VALUES ('incomplete-archive-observation', ?, 'arc', 1)
    `).run(archived);
    const repository = new WorkbenchThreadStateRelationalRepository(database);
    assert.deepEqual(new Set(repository.readRecords({ selection: "live", projectId: fixtureIdentityValues.ProjectId["project"] }).map(record => record.identity.threadId)), new Set([live, child]));
    assert.deepEqual(repository.readRecords({ selection: "children", parentThreadId: live! }).map(record => record.identity.threadId), [child]);
    assert.deepEqual(repository.readRecords({ selection: "threads", projectId: fixtureIdentityValues.ProjectId["other"], threadIds: [live!] }), []);
    assert.equal(repository.readNextArchiveEligibility(), 2);
    assert.deepEqual(repository.readArchiveEligible(2).map(({ record }) => record.identity.threadId), [settled]);
    assert.equal(repository.readProjectActivity(fixtureIdentityValues.ProjectId["project"]), 5);
    assert.throws(() => repository.readRecords({ selection: "threads", threadIds: [archived!] }), /unique summary/);
    database.prepare("DELETE FROM workbench_thread_git_observations WHERE thread_id = ?").run(archived);
    assert.equal(repository.readRecords({ selection: "project", projectId: fixtureIdentityValues.ProjectId["project"] }).length, 5);
    database.prepare("UPDATE workbench_thread_lifecycle SET lifecycle_kind = 'completed', reason = 'providerInactive', settled = 1 WHERE thread_id = ?").run(live);
    assert.deepEqual(new Set(repository.readRecords({ selection: "live", projectId: fixtureIdentityValues.ProjectId["project"] }).map(record => record.identity.threadId)), new Set([live, child]));
    database.prepare("UPDATE workbench_thread_lifecycle SET lifecycle_kind = 'completed', reason = 'providerInactive', settled = 1 WHERE thread_id = ?").run(child);
    assert.deepEqual(repository.readRecords({ selection: "live", projectId: fixtureIdentityValues.ProjectId["project"] }), []);
  } finally { database.close(); }
});
