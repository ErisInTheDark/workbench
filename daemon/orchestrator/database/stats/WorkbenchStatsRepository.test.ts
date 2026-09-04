/*
 * No production exports. Tests protect cumulative token arithmetic/filtering, distinct claimants, pricing attribution, and nullable rate windows. Keywords: stats, database, tokens, claims, rate limits, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { installWorkbenchDatabaseSchema } from "../workbench-database-schema.ts";
import WorkbenchTranscriptRepository from "../transcript/WorkbenchTranscriptRepository.ts";
import type { WorkbenchTranscriptAtomicObservation } from "../transcript/workbench-transcript-types.ts";
import WorkbenchStatsRepository from "./WorkbenchStatsRepository.ts";

function createDatabase() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  return database;
}

function seedTurn(database: Database.Database, now: number) {
  const observations: WorkbenchTranscriptAtomicObservation[] = [{
    activityAt: now, createdAt: now, kind: "thread", projectId: "project", projectRoot: "C:/project",
    threadId: "thread", title: "Stats thread", updatedAt: now,
  }, {
    createdAt: now, durationMs: 1, endedAt: now + 1, harnessId: "codex", kind: "turn",
    nativeLocation: "C:/project", nativeThreadId: "thread", nativeTurnId: "turn", startedAt: now,
    state: "completed", threadId: "thread", turnId: "turn", turnIndex: 0,
  }, {
    kind: "turnUsageContext", model: "gpt-5.4", observedAt: now, serviceTier: "standard",
    threadId: "thread", turnId: "turn",
  }, {
    cumulative: {
      cacheWriteInputTokens: 100, cachedInputTokens: 200, inputTokens: 1_000,
      outputTokens: 300, reasoningOutputTokens: 100, totalTokens: 9_999,
    },
    kind: "turnTokenUsage", observedAt: now, threadId: "thread", turnId: "turn", usageDataVersion: 2,
  }];
  new WorkbenchTranscriptRepository(database).settle(observations);
}

test("token reads separate input categories and expose filters, drivers, and exact pricing basis", () => {
  const database = createDatabase();
  try {
    const now = Date.UTC(2026, 8, 4, 12);
    seedTurn(database, now - 60_000);
    const repository = new WorkbenchStatsRepository(database);
    const result = repository.read({ projectId: "project", range: "7d" }, now);
    assert.deepEqual(result.tokens.totals, {
      all: 1_300,
      cachedInput: 200,
      cacheWriteInput: 100,
      input: 1_000,
      output: 300,
      uncachedInput: 700,
    });
    assert.deepEqual(result.cost.basis, {
      defaultModelTokens: 0,
      exactModelTokens: 1_300,
      projectInferredModelTokens: 0,
      threadInferredModelTokens: 0,
    });
    assert.deepEqual(result.usageFilters, { models: ["gpt-5.4"], providers: ["codex"] });
    assert.equal(result.models[0]?.tokens, 1_300);
    assert.equal(result.topThreads[0]?.threadId, "thread");
    assert.equal(repository.read({ projectId: "project", provider: "copilot", range: "7d" }, now).tokens.totals.all, 0);
  } finally {
    database.close();
  }
});

test("token reads derive turn usage from cumulative thread snapshots", () => {
  const database = createDatabase();
  try {
    const now = Date.UTC(2026, 8, 4, 12);
    const repository = new WorkbenchTranscriptRepository(database);
    repository.settle([{
      activityAt: now, createdAt: now, kind: "thread", projectId: "project", projectRoot: "C:/project",
      threadId: "thread", title: "Cumulative stats", updatedAt: now,
    }, {
      createdAt: now - 2_000, durationMs: 1, endedAt: now - 1_999, harnessId: "codex", kind: "turn",
      nativeLocation: "C:/project", nativeThreadId: "thread", nativeTurnId: "one", startedAt: now - 2_000,
      state: "completed", threadId: "thread", turnId: "one", turnIndex: 0,
    }, {
      cumulative: {
        cacheWriteInputTokens: 0, cachedInputTokens: 60, inputTokens: 100,
        outputTokens: 10, reasoningOutputTokens: 2, totalTokens: 110,
      },
      kind: "turnTokenUsage", observedAt: now - 1_999,
      threadId: "thread", turnId: "one", usageDataVersion: 2,
    }, {
      createdAt: now - 1_000, durationMs: 1, endedAt: now - 999, harnessId: "codex", kind: "turn",
      nativeLocation: "C:/project", nativeThreadId: "thread", nativeTurnId: "two", startedAt: now - 1_000,
      state: "completed", threadId: "thread", turnId: "two", turnIndex: 1,
    }, {
      cumulative: {
        cacheWriteInputTokens: 0, cachedInputTokens: 180, inputTokens: 300,
        outputTokens: 30, reasoningOutputTokens: 6, totalTokens: 330,
      },
      kind: "turnTokenUsage", observedAt: now - 999,
      threadId: "thread", turnId: "two", usageDataVersion: 2,
    }]);

    assert.deepEqual(new WorkbenchStatsRepository(database).read({
      projectId: "project",
      range: "7d",
    }, now).tokens.totals, {
      all: 330,
      cachedInput: 180,
      cacheWriteInput: 0,
      input: 300,
      output: 30,
      uncachedInput: 120,
    });
  } finally {
    database.close();
  }
});

test("cumulative usage keeps pre-filter baselines, ignores repeats, and counts resets from zero", () => {
  const database = createDatabase();
  try {
    const now = Date.UTC(2026, 8, 4, 12);
    const repository = new WorkbenchTranscriptRepository(database);
    const turn = (
      id: string,
      turnIndex: number,
      startedAt: number,
      model: string,
      cumulative: {
        cachedInputTokens: number;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      },
    ): WorkbenchTranscriptAtomicObservation[] => [{
      createdAt: startedAt, durationMs: 1, endedAt: startedAt + 1, harnessId: "codex", kind: "turn",
      nativeLocation: "C:/project", nativeThreadId: "thread", nativeTurnId: id, startedAt,
      state: "completed", threadId: "thread", turnId: id, turnIndex,
    }, {
      kind: "turnUsageContext", model, observedAt: startedAt, serviceTier: "standard",
      threadId: "thread", turnId: id,
    }, {
      cumulative: {
        cacheWriteInputTokens: 0,
        reasoningOutputTokens: 0,
        ...cumulative,
      },
      kind: "turnTokenUsage", observedAt: startedAt + 1,
      threadId: "thread", turnId: id, usageDataVersion: 2,
    }];
    repository.settle([{
      activityAt: now, createdAt: now - 8 * 86_400_000, kind: "thread",
      projectId: "project", projectRoot: "C:/project", threadId: "thread",
      title: "Filtered cumulative stats", updatedAt: now,
    }, ...turn("baseline", 0, now - 8 * 86_400_000, "gpt-5.3", {
      cachedInputTokens: 60,
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
    }), ...turn("delta", 1, now - 3 * 86_400_000, "gpt-5.4", {
      cachedInputTokens: 180,
      inputTokens: 300,
      outputTokens: 30,
      totalTokens: 330,
    }), ...turn("repeat", 2, now - 2 * 86_400_000, "gpt-5.4", {
      cachedInputTokens: 180,
      inputTokens: 299,
      outputTokens: 31,
      totalTokens: 330,
    }), ...turn("reset", 3, now - 86_400_000, "gpt-5.4", {
      cachedInputTokens: 20,
      inputTokens: 50,
      outputTokens: 5,
      totalTokens: 55,
    })]);

    assert.deepEqual(new WorkbenchStatsRepository(database).read({
      model: "gpt-5.4",
      projectId: "project",
      range: "7d",
    }, now).tokens.totals, {
      all: 275,
      cachedInput: 140,
      cacheWriteInput: 0,
      input: 250,
      output: 25,
      uncachedInput: 110,
    });
  } finally {
    database.close();
  }
});

test("token reads omit stale snapshots and first snapshots without a retained baseline", () => {
  const database = createDatabase();
  try {
    const now = Date.UTC(2026, 8, 4, 12);
    const usage = (threadId: string, turnId: string, turnIndex: number): WorkbenchTranscriptAtomicObservation[] => [{
      activityAt: now, createdAt: now, kind: "thread", projectId: "project", projectRoot: "C:/project",
      threadId, title: threadId, updatedAt: now,
    }, {
      createdAt: now, durationMs: 1, endedAt: now + 1, harnessId: "codex", kind: "turn",
      nativeLocation: "C:/project", nativeThreadId: threadId, nativeTurnId: turnId, startedAt: now,
      state: "completed", threadId, turnId, turnIndex,
    }, {
      cumulative: {
        cacheWriteInputTokens: 0,
        cachedInputTokens: 800,
        inputTokens: 1_000,
        outputTokens: 100,
        reasoningOutputTokens: 0,
        totalTokens: 1_100,
      },
      kind: "turnTokenUsage", observedAt: now,
      threadId, turnId, usageDataVersion: 2,
    }];
    new WorkbenchTranscriptRepository(database).settle([
      ...usage("ambiguous", "ambiguous-turn", 2),
      ...usage("stale", "stale-turn", 0),
    ]);
    database.prepare(`
      UPDATE thread_turn_usage SET usage_data_version = 1 WHERE turn_id = 'stale-turn'
    `).run();

    assert.equal(new WorkbenchStatsRepository(database).read({
      projectId: "project",
      range: "7d",
    }, now).tokens.totals.all, 0);
  } finally {
    database.close();
  }
});

test("claim traffic counts distinct threads instead of observations or occupied time", () => {
  const database = createDatabase();
  try {
    const repository = new WorkbenchStatsRepository(database);
    const now = Date.UTC(2026, 8, 4, 12);
    for (const [threadId, observedAt] of [["one", now - 60_000], ["one", now], ["two", now]] as const) {
      repository.recordClaimSnapshot({
        harness: "codex",
        observedAt,
        projectId: "project",
        roots: [{ paths: ["src/file.ts"], rootId: "root" }],
        threadId,
      });
    }
    assert.deepEqual(repository.read({ projectId: "project", range: "7d" }, now).claimHotspots, [{
      path: "src/file.ts",
      projectId: "project",
      rootId: "root",
      threadCount: 2,
    }]);
  } finally {
    database.close();
  }
});

test("rate limits record a current absent secondary window instead of preserving stale history", () => {
  const database = createDatabase();
  try {
    const repository = new WorkbenchStatsRepository(database);
    const now = Date.UTC(2026, 8, 4, 12);
    repository.recordRateLimits({
      harness: "codex",
      observedAt: now - 2_000,
      snapshots: [{
        limitId: "codex",
        limitName: null,
        primary: { durationMinutes: 10_080, resetsAt: now, usedPercent: 41 },
        secondary: { durationMinutes: 300, resetsAt: now, usedPercent: 12 },
      }],
    });
    repository.recordRateLimits({
      harness: "codex",
      observedAt: now - 1_000,
      snapshots: [{
        limitId: "codex",
        limitName: null,
        primary: { durationMinutes: 10_080, resetsAt: now, usedPercent: 42 },
        secondary: null,
      }],
    });
    const samples = repository.read({ projectId: null, range: "7d" }, now).rateLimits[0]?.samples;
    assert.equal(samples?.[0]?.secondary?.usedPercent, 12);
    const sample = samples?.at(-1);
    assert.equal(sample?.primary?.usedPercent, 42);
    assert.equal(sample?.secondary, null);
  } finally {
    database.close();
  }
});
