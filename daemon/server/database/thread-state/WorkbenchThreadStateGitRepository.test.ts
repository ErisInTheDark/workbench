/*
 * No production exports. Protect persisted observation semantics without invoking Git.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchThreadStateGitRepository, { type WorkbenchThreadGitObservations } from "./WorkbenchThreadStateGitRepository";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";

const fixtureIdentityValues = {
  ProjectId: {
    "project": testProjectIds.project,
  },
};

function fixture() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  const identities = new WorkbenchThreadIdentityRepository(database);
  const threadIds = ["first", "second"].map((nativeThreadId) => {
    const { threadId } = identities.observe({
      native: { harness: "codex", nativeLocation: "C:/project", nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse(nativeThreadId) },
      projectId: fixtureIdentityValues.ProjectId["project"], projectRoot: "C:/project", title: nativeThreadId,
      createdAt: 1, updatedAt: 1, activityAt: 1,
    });
    database.prepare(`
      INSERT INTO workbench_thread_states(thread_id, thread_kind, harness_id, title, activity_at, provider_observed)
      VALUES (?, 'topLevel', 'codex', ?, 1, 1)
    `).run(threadId, nativeThreadId);
    return threadId;
  });
  return { database, threadId: threadIds[0]!, otherThreadId: threadIds[1]!, repository: new WorkbenchThreadStateGitRepository(database) };
}

function observations(): WorkbenchThreadGitObservations {
  const common = {
    checkpointCommit: "a".repeat(40), intentDescription: "", intentName: "keep cache",
    updatedAt: "2026-09-10T00:00:00.000Z",
  };
  const member = {
    ...common, harness: "codex", threadId: "git-owner-not-canonical", repoRoot: "C:/project",
    rootId: "root-b", rootIds: ["root-b", "root-a"],
  };
  return {
    gitArc: {
      ...common, phase: "active", claimedPaths: ["z.ts", "a.ts"],
      proposals: [
        { proposalId: "second", status: "proposed", rootId: "root-b" },
        { proposalId: "first", status: "committed" },
      ],
      members: [{ ...member, phase: "active", claimedPaths: ["member.ts"], proposals: [] }],
    },
    gitArcPlan: {
      ...common, scopePaths: [],
      members: [{ ...member, scopePaths: ["two.ts", "one.ts"] }],
    },
  };
}

test("Git observations preserve ordered facts, opaque owner identifiers and independent absence", () => {
  const { database, repository, threadId, otherThreadId } = fixture();
  try {
    assert.deepEqual(repository.read(threadId), {});
    const value = observations();
    repository.replace(threadId, value);
    repository.replace(otherThreadId, value);
    assert.deepEqual(repository.read(threadId), value);
    repository.replace(threadId, { gitArc: null });
    assert.deepEqual(repository.read(threadId), { gitArc: null });
    assert.deepEqual(repository.read(otherThreadId), value);
    repository.replace(threadId, { gitArcPlan: null });
    assert.deepEqual(repository.read(threadId), { gitArcPlan: null });
    repository.replace(threadId, {});
    assert.deepEqual(repository.read(threadId), {});
    assert.deepEqual(repository.read(otherThreadId), value);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});

test("failed Git cache replacement restores both observations and the caller transaction can roll it back", () => {
  const { database, repository, threadId } = fixture();
  try {
    const original = observations();
    repository.replace(threadId, original);
    database.exec(`
      CREATE TEMP TRIGGER reject_plan BEFORE INSERT ON workbench_thread_git_entries
      WHEN NEW.observation_kind = 'plan' BEGIN SELECT RAISE(ABORT, 'injected plan write failure'); END
    `);
    assert.throws(() => repository.replace(threadId, { gitArc: null, gitArcPlan: original.gitArcPlan }), /injected/);
    assert.deepEqual(repository.read(threadId), original);
    database.exec("DROP TRIGGER reject_plan");
    assert.throws(database.transaction(() => {
      repository.replace(threadId, {});
      throw new Error("caller commit failed");
    }), /caller commit failed/);
    assert.deepEqual(repository.read(threadId), original);
  } finally {
    database.close();
  }
});

test("Git cache readback rejects incomplete value-bearing observations", () => {
  const { database, repository, threadId } = fixture();
  try {
    repository.replace(threadId, observations());
    database.prepare(`
      DELETE FROM workbench_thread_git_paths WHERE entry_id IN (
        SELECT entry.id FROM workbench_thread_git_entries entry
        JOIN workbench_thread_git_observations observation ON observation.id = entry.observation_id
        WHERE observation.thread_id = ? AND entry.entry_kind = 'summary'
      ) AND path_index = 0
    `).run(threadId);
    assert.throws(() => repository.read(threadId), /incomplete ordered facts/);
    repository.replace(threadId, observations());
    database.prepare(`
      DELETE FROM workbench_thread_git_entries WHERE observation_id IN (
        SELECT id FROM workbench_thread_git_observations WHERE thread_id = ?
      ) AND entry_kind = 'summary'
    `).run(threadId);
    assert.throws(() => repository.read(threadId), /unique summary/);
  } finally {
    database.close();
  }
});
