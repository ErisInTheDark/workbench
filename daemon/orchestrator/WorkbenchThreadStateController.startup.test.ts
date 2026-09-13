/*
 * No exports. Tests protect provider-free cold serving of durable thread state.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import WorkbenchThreadStateController from "./WorkbenchThreadStateController";
import { createThreadStateTestDatabase } from "./workbench-thread-state-test-database";
import { parseWorkbenchThreadStateEntry } from "./workbench-thread-state-record";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  ProjectId: {
    "project": fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  },
};

function record(value: object) {
  const entry = parseWorkbenchThreadStateEntry(value);
  assert.ok(entry.entryKind !== "draft");
  return entry;
}

function controller(database: ReturnType<typeof createThreadStateTestDatabase>) {
  return new WorkbenchThreadStateController({
    getProjectCatalog: () => ({
      data: [{ id: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), kind: "git", name: "Project", relativePath: "repo", rootPath: "/repo",
        roots: [{ id: "repo", name: "Repo", relativePath: ".", rootPath: "/repo", isPrimary: true }],
        lastCommitTimeMs: null }],
      rootPath: "/",
    }),
    hasLiveGitArcClaims: async () => false,
    resolveGitArc: async () => null,
    resolveGitArcPlan: async () => null,
    runGitArcReadTransition: async (_projectId, operation) => await operation(),
    projectState: { getCurrentUpdate: () => null, handleRequest: async () => ({}), observe: () => () => undefined },
    publish: () => undefined,
    reconcileProject: async () => [],
    threadStateStore: database.persistence,
  });
}

test("cold relational startup preserves canonical entries and layout across reopen without provider metadata reads", async () => {
  const sqlite = new Database(":memory:");
  const database = createThreadStateTestDatabase(sqlite);
  const threadId = "43596355-c379-497b-b1e0-2f2619c977a1";
  const turnId = "8997417f-de30-47a7-b63b-fb41e6e8b4e5";
  database.admitThread("project", threadId);
  const storedRecord = record({
    entryKind: "thread", identity: { harness: "codex", threadId },
    title: "Saved", activityAt: 2,
    metadata: { archived: false, pinned: true, snoozed: false },
    lifecycle: { kind: "completed", reason: "agentCompleted", settled: false,
      agent: { agentStatus: "completed", turnId } },
  });
  database.admitRecord(storedRecord);
  await database.commitThreadState({
    records: [storedRecord],
    layouts: [{ owner: { kind: "project", projectId: fixtureIdentityValues.ProjectId["project"] },
      revision: 1, displayOrder: { pinned: { [`codex:${threadId}`]: { above: [], below: [] } } } }],
  });
  let current = controller(database);
  try {
    const first = await current.open("client", fixtureIdentityValues.ProjectId.project, 5);
    const entry = first.sidebar.entries[0]!;
    assert.equal(entry.entryKind, "thread");
    assert.ok(entry.entryKind === "thread");
    assert.equal(entry.identity.threadId, threadId);
    assert.ok("agent" in entry.lifecycle && entry.lifecycle.agent);
    assert.equal(entry.lifecycle.agent.turnId, turnId);
    assert.deepEqual(sqlite.prepare("SELECT COUNT(*) AS count FROM thread_items").get(), { count: 0 });
    await current.dispose();
    current = controller(createThreadStateTestDatabase(sqlite));
    const reopened = await current.open("client", fixtureIdentityValues.ProjectId.project, 5);
    assert.deepEqual(reopened.sidebar.entries, first.sidebar.entries);
    assert.deepEqual(reopened.sidebar.displayOrder, first.sidebar.displayOrder);
    assert.deepEqual(sqlite.pragma("foreign_key_check"), []);
  } finally {
    await current.dispose();
  }
});

test("complete cold serving isolates projects and retains settled cross-harness children", async () => {
  const database = createThreadStateTestDatabase();
  const parentId = fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("7b6a28d5-0aad-4bed-8997-4d3cec747e68");
  const childId = "17cbfbd0-4b9e-41e0-925e-6e5edb833904";
  const foreignId = fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("f5efad70-c326-4947-b0ce-6b389d04cab3");
  for (const [projectId, id] of [["project", parentId], ["project", childId], ["other", foreignId]]) {
    database.admitThread(projectId!, id!);
  }
  await database.commitThreadState({ records: [
    ...[parentId, foreignId].map(threadId => record({
      entryKind: "thread", identity: { harness: "codex", threadId }, title: threadId, activityAt: 2,
      metadata: { archived: false, pinned: true, snoozed: false },
      lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    })),
    record({
      entryKind: "subagent", identity: { harness: "opencode", threadId: childId },
      parentThreadId: parentId, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), name: "Child", profileId: "profile", profileName: "Profile",
      cwd: "/repo", title: "Child", activityAt: 2, createdAt: 1, updatedAt: 2,
      directSubagentIndex: 0, pinned: false,
      lifecycle: { kind: "completed", reason: "providerInactive", settled: true },
    }),
  ] });
  const current = controller(database);
  try {
    const opened = await current.open("client", fixtureIdentityValues.ProjectId.project, 5);
    assert.deepEqual(new Set(opened.sidebar.entries.map(entry => entry.entryKind !== "draft" && entry.identity.threadId)), new Set([parentId, childId]));
    const children = await database.readThreadStateRecords({ selection: "children", parentThreadId: parentId });
    assert.equal(children.length, 1);
    assert.ok(children[0]?.entryKind === "subagent");
    assert.equal(children[0].parentThreadId, parentId);
    assert.equal(children[0].identity.harness, "opencode");
    assert.deepEqual(await database.readThreadStateRecords({ selection: "threads", projectId: fixtureIdentityValues.ProjectId["project"], threadIds: [foreignId] }), []);
  } finally {
    await current.dispose();
  }
});
