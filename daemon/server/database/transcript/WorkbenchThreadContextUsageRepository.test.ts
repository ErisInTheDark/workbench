/*
 * No production exports. Tests protect durable measurements, negative recovery and live-first ordering.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema";
import WorkbenchTranscriptRepository from "./WorkbenchTranscriptRepository";
import WorkbenchThreadContextUsageRepository from "./WorkbenchThreadContextUsageRepository";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";

const fixtureIdentityValues = {
  ProjectId: {
    "project": testProjectIds.project,
  },
  WorkbenchThreadId: {
    "thread": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"),
  },
};

function setup() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  new WorkbenchTranscriptRepository(database).settle([{
    kind: "thread", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"], projectId: fixtureIdentityValues.ProjectId["project"], projectRoot: "C:/repo",
    title: "", createdAt: 1, updatedAt: 1, activityAt: 1,
  }]);
  return { database, repository: new WorkbenchThreadContextUsageRepository(database) };
}

function snapshot(inputTokens: number) {
  return { tokenUsage: {
    last: { inputTokens, cachedInputTokens: 1, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: inputTokens + 2 },
    total: { inputTokens: inputTokens * 10, cachedInputTokens: 10, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 0, totalTokens: inputTokens * 10 + 20 },
    modelContextWindow: 1000,
  } };
}

test("context measurement survives a repository replacement and remains thread-owned", () => {
  const { database, repository } = setup();
  try {
    assert.equal(repository.read("thread"), null);
    repository.write("thread", snapshot(10), false);
    assert.deepEqual(new WorkbenchThreadContextUsageRepository(database).read("thread"), snapshot(10));
    assert.equal(repository.read("different-thread"), null);
  } finally { database.close(); }
});

test("historical initialisation cannot replace live usage and unavailable recovery is durable", () => {
  const { database, repository } = setup();
  try {
    repository.write("thread", { tokenUsage: null }, true);
    assert.deepEqual(repository.read("thread"), { tokenUsage: null });
    repository.write("thread", snapshot(20), false);
    repository.write("thread", snapshot(10), true);
    assert.deepEqual(repository.read("thread"), snapshot(20));
    repository.write("thread", snapshot(30), false);
    assert.deepEqual(repository.read("thread"), snapshot(30));
  } finally { database.close(); }
});
