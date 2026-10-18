/*
 * No production exports. Protect one batched read returning each thread's own runtime facts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { NativeThreadIdSchema, NativeTurnIdSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema";
import WorkbenchTranscriptRepository from "../transcript/WorkbenchTranscriptRepository";
import WorkbenchThreadGoalStore from "../goals/WorkbenchThreadGoalStore";
import WorkbenchThreadSkillStore from "../skills/WorkbenchThreadSkillStore";
import WorkbenchThreadTodoStore from "../todos/WorkbenchThreadTodoStore";
import WorkbenchThreadAddressedFeedbackStore from "../feedback/WorkbenchThreadAddressedFeedbackStore";
import WorkbenchThreadRuntimeFactsReader from "./WorkbenchThreadRuntimeFactsReader";

const usage = (inputTokens: number) => ({
  last: { cacheWriteInputTokens: 0, cachedInputTokens: 0, inputTokens, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: inputTokens + 1 },
  total: { cacheWriteInputTokens: 0, cachedInputTokens: 0, inputTokens, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: inputTokens + 1 },
  modelContextWindow: 200_000,
});

test("one read returns every requested thread's own goal, skills, todos, feedback, usage and latest turn", () => {
  const database = new Database(":memory:");
  installWorkbenchDatabaseSchema(database);
  const transcript = new WorkbenchTranscriptRepository(database);
  const [parent, child] = ["parent", "child"].map(id => WorkbenchThreadIdSchema.parse(id));
  try {
    transcript.settle([parent, child].flatMap(threadId => [{
      kind: "thread" as const, threadId, projectId: testProjectIds.project, projectRoot: "/repo",
      title: threadId, createdAt: 1, updatedAt: 1, activityAt: 1,
    }]));
    transcript.settle([0, 1].map(turnIndex => ({
      kind: "turn" as const, threadId: parent, turnId: WorkbenchTurnIdSchema.parse(`parent-${turnIndex}`), turnIndex,
      harnessId: "claude", nativeLocation: "/repo", nativeThreadId: NativeThreadIdSchema.parse("native"),
      nativeTurnId: NativeTurnIdSchema.parse(`native-${turnIndex}`), state: turnIndex ? "inProgress" as const : "completed" as const,
      createdAt: turnIndex + 1, startedAt: (turnIndex + 1) * 1000, endedAt: turnIndex ? null : 2000, durationMs: turnIndex ? null : 1000,
    })));
    transcript.settle([{ kind: "threadContextUsage", threadId: child, initialise: false, snapshot: { tokenUsage: usage(1234) } }]);
    new WorkbenchThreadGoalStore(database).execute({ kind: "set", threadId: parent, objective: "ship it", at: 5 });
    new WorkbenchThreadSkillStore(database).execute({
      kind: "activate", threadId: child, at: 6, skills: [{ path: "skills/a/SKILL.md", name: "a", source: "user" }],
    });
    new WorkbenchThreadTodoStore(database).execute({ kind: "add", threadId: parent, text: "follow up", required: true, at: 7 });
    new WorkbenchThreadAddressedFeedbackStore(database).execute({ kind: "record", threadId: child, feedback: [{
      kind: "feedback", id: 9, daemonId: "daemon", category: "bug", title: "slow", author: "lily",
      thread: "thread", createdAt: 8, report: "report",
    }] });

    const facts = new Map(new WorkbenchThreadRuntimeFactsReader(database, transcript)
      .read([parent, child, "unknown"]).map(entry => [entry.threadId, entry]));

    const parentFacts = facts.get(parent)!;
    assert.equal(parentFacts.goal?.objective, "ship it");
    assert.deepEqual(parentFacts.todos.map(({ text, required }) => ({ text, required })), [{ text: "follow up", required: true }]);
    assert.deepEqual(parentFacts.skills, []);
    assert.deepEqual(parentFacts.addressedFeedback, []);
    assert.equal(parentFacts.tokenUsage, null);
    assert.equal(parentFacts.latestTurn?.id, "parent-1");
    assert.equal(parentFacts.latestTurn?.status, "inProgress");

    const childFacts = facts.get(child)!;
    assert.equal(childFacts.goal, null);
    assert.deepEqual(childFacts.skills.map(({ path }) => path), ["skills/a/SKILL.md"]);
    assert.deepEqual(childFacts.addressedFeedback.map(({ id }) => id), [9]);
    assert.equal(childFacts.tokenUsage?.last.inputTokens, 1234);
    assert.equal(childFacts.latestTurn, null);

    assert.deepEqual(facts.get("unknown"), {
      threadId: "unknown", goal: null, skills: [], todos: [], addressedFeedback: [], tokenUsage: null, latestTurn: null,
    });
  } finally {
    database.close();
  }
});
