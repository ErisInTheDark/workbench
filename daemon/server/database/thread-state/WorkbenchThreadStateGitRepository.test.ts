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
      ...common, phase: "active", claimedPaths: ["z.ts", "a.ts"], stashedPaths: [],
      proposals: [
        {
          proposalId: "second", status: "proposed", rootId: "root-b",
          summary: {
            changes: [{ additions: 2, deletions: 1, kind: "update", path: "src/two.ts" }],
            committedSha: null,
            description: "keep details",
            mode: "commit",
            title: "second proposal",
          },
        },
        {
          proposalId: "first", status: "committed",
          summary: {
            changes: null,
            committedSha: "b".repeat(40),
            description: "",
            mode: "amend",
            title: "first proposal",
          },
        },
      ],
      members: [{ ...member, phase: "active", claimedPaths: ["member.ts"], stashedPaths: [], proposals: [] }],
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

test("stashed Git observations preserve retained paths without restoring live claims", () => {
  const { database, repository, threadId } = fixture();
  try {
    const active = observations().gitArc!;
    const stashed: WorkbenchThreadGitObservations = {
      gitArc: {
        ...active,
        claimedPaths: [],
        phase: "stashed",
        stashedPaths: ["z.ts", "a.ts"],
        members: active.members?.map((member) => ({
          ...member,
          claimedPaths: [],
          phase: "stashed",
          stashedPaths: member.claimedPaths,
        })),
      },
    };
    repository.replace(threadId, stashed);
    assert.deepEqual(repository.read(threadId), stashed);
  } finally {
    database.close();
  }
});

/** Observes one committed proposal in the live arc, which is how permanent history grows. */
function promote(repository: WorkbenchThreadStateGitRepository, threadId: string, commit: {
  committedAt?: string; commitSha: string; description?: string; proposalId: string; title: string;
}) {
  const arc = observations().gitArc!;
  repository.replace(threadId, {
    gitArc: {
      ...arc,
      proposals: [{
        proposalId: commit.proposalId, rootId: "root-a", status: "committed",
        summary: {
          changes: null, ...(commit.committedAt ? { committedAt: commit.committedAt } : {}), committedSha: commit.commitSha,
          description: commit.description ?? "", mode: "commit", title: commit.title,
        },
      }],
    },
  });
}

test("accepted commit history survives arc replacement, amends in place, and never rides the cache read", () => {
  const { database, repository, threadId } = fixture();
  try {
    promote(repository, threadId, { commitSha: "c".repeat(40), description: "first description", proposalId: "accepted-proposal", title: "first title" });
    repository.replace(threadId, { gitArc: null });
    assert.deepEqual(repository.read(threadId), { gitArc: null });
    const accepted = {
      commitSha: "c".repeat(40), description: "first description", historyIndex: 0, rootId: "root-a",
      sourceProposalId: "accepted-proposal", title: "first title",
    };
    assert.deepEqual(repository.readCommits([threadId]).get(threadId), [accepted]);

    promote(repository, threadId, { commitSha: "d".repeat(40), description: "amended description", proposalId: "accepted-proposal", title: "amended title" });
    assert.deepEqual(repository.readCommits([threadId]).get(threadId), [
      { ...accepted, commitSha: "d".repeat(40), description: "amended description", title: "amended title" },
    ]);
    assert.equal((database.prepare(`
      SELECT COUNT(*) AS count FROM workbench_thread_git_commits WHERE thread_id = ?
    `).get(threadId) as { count: number }).count, 1);
  } finally {
    database.close();
  }
});

test("committed live proposals promote into permanent history before arc replacement", () => {
  const { database, repository, threadId } = fixture();
  try {
    const value = observations();
    const arc = value.gitArc!;
    const proposed = arc.proposals[0]!;
    repository.replace(threadId, {
      gitArc: {
        ...arc,
        proposals: [{
          ...proposed,
          status: "committed",
          summary: { ...proposed.summary!, committedSha: "e".repeat(40) },
        }],
      },
    });
    repository.replace(threadId, { gitArc: null });
    assert.deepEqual(repository.readCommits([threadId]).get(threadId), [{
      commitSha: "e".repeat(40),
      description: "keep details",
      historyIndex: 0,
      rootId: "root-b",
      sourceProposalId: "second",
      title: "second proposal",
    }]);
  } finally {
    database.close();
  }
});

test("accepted commit times live on permanent history, and the first known time is kept", () => {
  const { database, repository, threadId, otherThreadId } = fixture();
  try {
    const committedAt = "2026-10-16T03:00:00.000Z";
    const timesOf = () => repository.readCommits([threadId]).get(threadId)?.map((commit) => commit.committedAt);
    promote(repository, threadId, { committedAt, commitSha: "e".repeat(40), proposalId: "timed", title: "timed" });
    assert.equal(repository.read(threadId).gitArc?.proposals[0]?.summary?.committedAt, undefined);
    assert.deepEqual(timesOf(), [committedAt]);

    // Re-observing without a time, or with a later one, never replaces a recorded time.
    promote(repository, threadId, { commitSha: "e".repeat(40), proposalId: "timed", title: "timed" });
    promote(repository, threadId, { committedAt: "2026-10-17T00:00:00.000Z", commitSha: "e".repeat(40), proposalId: "timed", title: "timed" });
    assert.deepEqual(timesOf(), [committedAt]);

    // Backfilled times fill only rows stored without one, and only for the named thread.
    promote(repository, threadId, { commitSha: "f".repeat(40), proposalId: "legacy", title: "legacy" });
    promote(repository, otherThreadId, { commitSha: "f".repeat(40), proposalId: "legacy", title: "legacy" });
    const backfilled = "2026-10-01T00:00:00.000Z";
    repository.recordCommitTimes(threadId, [
      { commitSha: "e".repeat(40), committedAt: backfilled, rootId: "root-a" },
      { commitSha: "f".repeat(40), committedAt: backfilled, rootId: "root-a" },
    ]);
    assert.deepEqual(timesOf(), [committedAt, backfilled]);
    assert.deepEqual(repository.readCommits([otherThreadId]).get(otherThreadId)?.map((commit) => commit.committedAt), [undefined]);

    // Durable owners are found by sha within the thread's project.
    const { project_id: projectId } = database.prepare("SELECT project_id FROM workbench_threads WHERE id = ?").get(threadId) as { project_id: string };
    assert.deepEqual(repository.findCommitOwners(projectId, "f".repeat(40)), [threadId, otherThreadId].sort());
    assert.deepEqual(repository.findCommitOwners(projectId, "e".repeat(40)), [threadId]);
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
