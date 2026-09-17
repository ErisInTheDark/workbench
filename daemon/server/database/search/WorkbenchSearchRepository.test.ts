/*
 * No exports. Tests protect search-owner correctness and the 500ms query budget.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";

import { installWorkbenchDatabaseSchema } from "../workbench-database-schema";
import WorkbenchTranscriptRepository from "../transcript/WorkbenchTranscriptRepository";
import type { WorkbenchTranscriptObservation } from "../transcript/workbench-transcript-types";
import WorkbenchSearchRepository from "./WorkbenchSearchRepository";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";

function seedSearchThread(
  transcript: WorkbenchTranscriptRepository,
  {
    activityAt,
    assistantText,
    id,
    title,
    userText,
  }: {
    activityAt: number;
    assistantText: string;
    id: string;
    title: string;
    userText: string;
  },
) {
  const threadId = fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(id);
  const turnId = fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(`${id}-turn`);
  transcript.settle([{
    kind: "canonicalWindow",
    threadId,
    contentVersion: 3,
    materializedTurnIds: [turnId],
    observations: [
      {
        kind: "thread",
        threadId,
        projectId: testProjectIds.project,
        projectRoot: "C:/project",
        title,
        createdAt: activityAt,
        updatedAt: activityAt,
        activityAt,
      },
      {
        kind: "turn",
        threadId,
        turnId,
        turnIndex: 0,
        harnessId: "codex",
        nativeLocation: "C:/project",
        nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse(id),
        nativeTurnId: fixtureIdentitySchemas.NativeTurnIdSchema.parse(`${id}-turn`),
        state: "completed",
        createdAt: activityAt,
        startedAt: activityAt,
        endedAt: activityAt,
        durationMs: 0,
      },
      {
        kind: "item",
        threadId,
        turnId,
        lifecycle: "completed",
        observedAt: activityAt,
        item: {
          clientId: `${id}-user`,
          content: [{ text: userText, text_elements: [], type: "text" }],
          id: `${id}-user`,
          type: "userMessage",
        },
      },
      {
        kind: "item",
        threadId,
        turnId,
        lifecycle: "completed",
        observedAt: activityAt,
        item: {
          id: `${id}-assistant`,
          delivery: null,
          questions: null,
          memoryCitation: null,
          phase: "commentary",
          text: assistantText,
          type: "agentMessage",
        },
      },
    ],
  }]);
}

test("search ranks recent settled narrative, repeated terms, and match-centred excerpts without archived bodies", () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  try {
    const now = Date.UTC(2026, 8, 17);
    const transcript = new WorkbenchTranscriptRepository(database);
    seedSearchThread(transcript, {
      activityAt: now - 2 * 86_400_000,
      assistantText: "The implementation kept the loading state lifecycle-owned.",
      id: "recent-loader",
      title: "Recent visual repair",
      userText: `${"unrelated opening context ".repeat(20)}loader animation loader animation loader`,
    });
    seedSearchThread(transcript, {
      activityAt: now - 60 * 86_400_000,
      assistantText: "A loader animation was mentioned once.",
      id: "stale-loader",
      title: "Old visual note",
      userText: "Please inspect the loader.",
    });
    seedSearchThread(transcript, {
      activityAt: now - 86_400_000,
      assistantText: "Archived loader loading animation loader loading animation.",
      id: "archived-loader",
      title: "Archived unrelated work",
      userText: "Archived narrative must stay hidden.",
    });
    seedSearchThread(transcript, {
      activityAt: now - 2 * 86_400_000,
      assistantText: "freshnesssignal",
      id: "recent-freshness",
      title: "Recent freshness result",
      userText: "",
    });
    seedSearchThread(transcript, {
      activityAt: now - 60 * 86_400_000,
      assistantText: "",
      id: "stale-freshness",
      title: "Stale freshness result",
      userText: "freshnesssignal",
    });
    const lifecycle = database.prepare(`
      INSERT INTO workbench_thread_lifecycle
        (thread_id, lifecycle_kind, reason, settled, turn_id, request_key, agent_status, updated_at)
      VALUES (?, 'completed', 'agentCompleted', ?, ?, NULL, 'completed', ?)
    `);
    lifecycle.run("recent-loader", 1, "recent-loader-turn", now);
    lifecycle.run("stale-loader", 0, "stale-loader-turn", now);
    lifecycle.run("archived-loader", 1, "archived-loader-turn", now);
    lifecycle.run("recent-freshness", 1, "recent-freshness-turn", now);
    lifecycle.run("stale-freshness", 0, "stale-freshness-turn", now);
    database.prepare("UPDATE workbench_threads SET archived = 1 WHERE id = 'archived-loader'").run();

    const repository = new WorkbenchSearchRepository(database, { now: () => now });
    const results = repository.search({
      projectId: testProjectIds.project,
      query: "loader loading animation",
    }).results;

    assert.deepEqual(results.map(({ title }) => title), ["Recent visual repair", "Old visual note"]);
    assert.match(results[0]?.detail ?? "", /^You: \.\.\..*loader animation/u);
    assert.deepEqual(repository.search({
      projectId: testProjectIds.project,
      query: "\"Archived unrelated work\"",
    }).results, []);
    assert.deepEqual(repository.search({
      projectId: testProjectIds.project,
      query: "freshnesssignal",
    }).results.map(({ title }) => title), ["Recent freshness result", "Stale freshness result"]);
  } finally {
    database.close();
  }
});

test("search stays below 500ms per query on a multi-megabyte relational corpus", (t) => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  try {
    const transcript = new WorkbenchTranscriptRepository(database);
    const observations: WorkbenchTranscriptObservation[] = [];
    const vocabulary = ["controller", "database", "performance", "project", "request", "response", "selection", "thread", "architecture", "validation"];
    const paragraph = Array.from({ length: 1000 }, (_, index) => `${vocabulary[index % vocabulary.length]}${index} handles requests and preserves current state.`).join(" ");
    let corpusCharacters = 0;
    for (let index = 0; index < 920; index++) {
      const threadId = `search-thread-${index}`;
      const turnId = `search-turn-${index}`;
      const title = `Project maintenance ${index}`;
      const catalog = {
        kind: "thread" as const, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId), projectId: testProjectIds.project, projectRoot: "C:/project",
        title, createdAt: 1, updatedAt: index + 1, activityAt: index + 1,
      };
      if (index >= 42) {
        observations.push({ kind: "turnCatalog", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId), catalog: [catalog] });
        continue;
      }
      const text = `${index === 0 ? "quartzzeppelin exact phrase " : ""}${paragraph}`;
      corpusCharacters += text.length;
      observations.push({
        kind: "canonicalWindow", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId), contentVersion: 3, materializedTurnIds: [fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(turnId)],
        observations: [
          catalog,
          {
            kind: "turn", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId), turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(turnId), turnIndex: 0, harnessId: "codex",
            nativeLocation: "C:/project", nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse(threadId), nativeTurnId: fixtureIdentitySchemas.NativeTurnIdSchema.parse(turnId),
            state: "completed", createdAt: 1, startedAt: 1, endedAt: 2, durationMs: 1,
          },
          {
            kind: "item", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId), turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(turnId), lifecycle: "completed", observedAt: 2,
            item: {
              id: `body-${index}`, type: "agentMessage", phase: "commentary",
              text, delivery: null, questions: null, memoryCitation: null,
            },
          },
        ],
      });
    }
    transcript.settle(observations);
    const repository = new WorkbenchSearchRepository(database);
    repository.replaceProjects(Array.from({ length: 102 }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`, name: `Project ${index}`, rootPath: `C:/project-${index}` })));
    repository.replaceProjectFiles(testProjectIds.project, Array.from({ length: 1200 }, (_, index) => `src/components/component-${index}.tsx`));
    assert.ok(corpusCharacters >= 2_373_411);

    const measurements = [];
    for (const query of ["", "a", "quartzzeppeln", "quartzzeppelin state", '"exact phrase"', "maintenance -quartzzeppelin", "asdlfkajsdlfkjasdlfkjasdf"]) {
      const startedAt = performance.now();
      const response = repository.search({ projectId: testProjectIds.project, query });
      const elapsedMs = performance.now() - startedAt;
      measurements.push({ query, elapsedMs });
      if (query === "asdlfkajsdlfkjasdlfkjasdf") assert.deepEqual(response.results, []);
      else assert.ok(response.results.length > 0, query);
      if (query === "quartzzeppeln" || query === '"exact phrase"') {
        assert.deepEqual(response.results.map((result) => result.id), ["thread:search-thread-0"]);
      }
      if (query === "quartzzeppelin state") assert.equal(response.results[0]?.id, "thread:search-thread-0");
    }
    t.diagnostic(`corpus=${corpusCharacters} chars; ${measurements.map(({ query, elapsedMs }) => `${query || "(empty)"}=${elapsedMs.toFixed(1)}ms`).join("; ")}`);
    for (const { query, elapsedMs } of measurements) {
      assert.ok(elapsedMs < 500, `${query || "(empty)"} took ${elapsedMs.toFixed(1)}ms, exceeding the 500ms search budget`);
    }
  } finally {
    database.close();
  }
});
