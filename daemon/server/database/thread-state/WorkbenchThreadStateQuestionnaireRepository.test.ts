/*
 * No production exports. Protect source questionnaire facts without transcript bodies.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchTranscriptIdentityRepository from "../transcript/WorkbenchTranscriptIdentityRepository";
import WorkbenchThreadStateQuestionnaireRepository, { type WorkbenchThreadQuestionnaires } from "./WorkbenchThreadStateQuestionnaireRepository";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";

const fixtureIdentityValues = {
  NativeThreadId: {
    "thread": fixtureIdentitySchemas.NativeThreadIdSchema.parse("thread"),
  },
  NativeTurnId: {
    "turn": fixtureIdentitySchemas.NativeTurnIdSchema.parse("turn"),
  },
  ProjectId: {
    "project": testProjectIds.project,
  },
};

function fixture() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  const identities = new WorkbenchThreadIdentityRepository(database);
  const { threadId } = identities.observe({
    native: { harness: "codex", nativeLocation: "C:/project", nativeThreadId: fixtureIdentityValues.NativeThreadId["thread"] },
    projectId: fixtureIdentityValues.ProjectId["project"], projectRoot: "C:/project", title: "thread", createdAt: 1, updatedAt: 1, activityAt: 1,
  });
  const { turnId } = identities.observeTurn({
    kind: "turn", threadId, turnId: fixtureIdentityValues.NativeTurnId.turn, nativeTurnId: fixtureIdentityValues.NativeTurnId["turn"], nativeThreadId: fixtureIdentityValues.NativeThreadId["thread"],
    nativeLocation: "C:/project", harnessId: "codex", state: "inProgress",
    createdAt: 1, startedAt: 1, endedAt: null, durationMs: null,
  });
  const { itemId } = new WorkbenchTranscriptIdentityRepository(database).admit({
    threadId, sources: [],
  });
  database.prepare(`
    INSERT INTO workbench_thread_states(thread_id, thread_kind, harness_id, title, activity_at, provider_observed)
    VALUES (?, 'topLevel', 'codex', 'thread', 1, 1)
  `).run(threadId);
  const request = {
    id: "request", title: "choose", summary: "", submitLabel: "submit",
    questions: ["empty", "missing", "ordered"].map((id) => ({
      id, header: "", question: id, allowOther: true, isSecret: false,
      options: [{ label: "second", description: "" }, { label: "first", description: "" }],
    })),
  };
  const value: WorkbenchThreadQuestionnaires = {
    pending: { itemId: null, turnId: null, requestKey: "pending", request },
    history: [{
      itemId, turnId, threadId, requestKey: "answered", request, resolvedAt: 4,
      insertAfterItemId: itemId, insertAfterItemIndex: 0,
      response: { answers: { empty: { answers: [] }, ordered: { answers: ["second", "first"] } } },
    }],
  };
  return { database, threadId, value, repository: new WorkbenchThreadStateQuestionnaireRepository(database) };
}

test("questionnaires preserve empty versus missing answers and source anchors without materialised items", () => {
  const { database, threadId, value, repository } = fixture();
  try {
    assert.deepEqual(repository.read(threadId), { pending: null, history: [] });
    repository.replace(threadId, value);
    assert.deepEqual(repository.read(threadId), value);
    assert.deepEqual(database.prepare("SELECT id FROM thread_items").all(), []);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    const withoutPending = { pending: null, history: value.history };
    repository.replace(threadId, withoutPending);
    assert.deepEqual(repository.read(threadId), withoutPending);
  } finally {
    database.close();
  }
});

test("failed questionnaire replacement preserves the prior source and surrounding transactions own rollback", () => {
  const { database, threadId, value, repository } = fixture();
  try {
    repository.replace(threadId, value);
    const answered = value.history[0]!;
    assert.throws(() => repository.replace(threadId, {
      pending: null,
      history: [{ ...answered, request: {
        ...answered.request, questions: [answered.request.questions[0]!, answered.request.questions[0]!],
      } }],
    }), /UNIQUE/);
    assert.deepEqual(repository.read(threadId), value);
    assert.throws(database.transaction(() => {
      repository.replace(threadId, { pending: null, history: [] });
      throw new Error("outer commit failed");
    }), /outer commit failed/);
    assert.deepEqual(repository.read(threadId), value);
  } finally {
    database.close();
  }
});
