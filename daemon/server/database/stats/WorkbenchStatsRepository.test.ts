/*
 * No production exports. Tests protect cumulative token arithmetic/filtering, distinct claimants, pricing attribution, and nullable rate windows.
 */
import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { installWorkbenchDatabaseSchema } from "../workbench-database-schema.ts";
import WorkbenchTranscriptRepository from "../transcript/WorkbenchTranscriptRepository.ts";
import type { WorkbenchTranscriptAtomicObservation } from "../transcript/workbench-transcript-types.ts";
import WorkbenchStatsRepository from "./WorkbenchStatsRepository.ts";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";

const fixtureIdentityValues = {
  NativeThreadId: {
    "thread": fixtureIdentitySchemas.NativeThreadIdSchema.parse("thread"),
  },
  NativeTurnId: {
    "one": fixtureIdentitySchemas.NativeTurnIdSchema.parse("one"),
    "turn": fixtureIdentitySchemas.NativeTurnIdSchema.parse("turn"),
    "two": fixtureIdentitySchemas.NativeTurnIdSchema.parse("two"),
  },
  ProjectId: {
    "project": testProjectIds.project,
  },
  WorkbenchThreadId: {
    "thread": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"),
  },
  WorkbenchTurnId: {
    "one": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("one"),
    "turn": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn"),
    "two": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("two"),
  },
};

function createDatabase() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  return database;
}

test("live claims admit their provider without a thread and repeated snapshots do not duplicate facts", () => {
  const database = createDatabase();
  try {
    const repository = new WorkbenchStatsRepository(database);
    const snapshot = {
      projectId: fixtureIdentityValues.ProjectId.project, threadId: "future-thread", harness: "future-provider",
      observedAt: Date.UTC(2026, 8, 4), roots: [{ rootId: "root", paths: ["src/file.ts"] }],
    };
    repository.recordClaimSnapshot(snapshot);
    assert.ok(database.prepare("SELECT id FROM workbench_projects WHERE id = ?").get(snapshot.projectId));
    const canonical = testProjectIds.other;
    database.prepare("INSERT INTO workbench_projects(id) VALUES (?)").run(canonical);
    database.prepare("INSERT INTO workbench_project_aliases(alias, project_id) VALUES ('old-claims', ?)").run(canonical);
    repository.recordClaimSnapshot({ ...snapshot, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("old-claims"), roots: [{ rootId: "root", paths: ["aliased.ts"] }] });
    assert.equal(database.prepare("SELECT project_id FROM git_claim_thread_file_days WHERE claimed_path = 'aliased.ts'").pluck().get(), canonical);
    database.prepare("DELETE FROM git_claim_thread_file_days WHERE claimed_path = 'aliased.ts'").run();
    repository.recordClaimSnapshot(snapshot);
    assert.deepEqual(database.prepare("SELECT harness_id, thread_id FROM git_claim_thread_file_days").all(), [
      { harness_id: "future-provider", thread_id: "future-thread" },
    ]);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally { database.close(); }
});

function seedTurn(database: Database.Database, now: number) {
  const observations: WorkbenchTranscriptAtomicObservation[] = [{
    activityAt: now, createdAt: now, kind: "thread", projectId: fixtureIdentityValues.ProjectId["project"], projectRoot: "C:/project",
    threadId: fixtureIdentityValues.WorkbenchThreadId["thread"], title: "Stats thread", updatedAt: now,
  }, {
    createdAt: now, durationMs: 1, endedAt: now + 1, harnessId: "codex", kind: "turn",
    nativeLocation: "C:/project", nativeThreadId: fixtureIdentityValues.NativeThreadId["thread"], nativeTurnId: fixtureIdentityValues.NativeTurnId["turn"], startedAt: now,
    state: "completed", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"], turnId: fixtureIdentityValues.WorkbenchTurnId["turn"], turnIndex: 0,
  }, {
    kind: "turnUsageContext", model: "gpt-5.4", observedAt: now, serviceTier: "standard",
    threadId: fixtureIdentityValues.WorkbenchThreadId["thread"], turnId: fixtureIdentityValues.WorkbenchTurnId["turn"],
  }, {
    cumulative: {
      cacheWriteInputTokens: 100, cachedInputTokens: 200, inputTokens: 1_000,
      outputTokens: 300, reasoningOutputTokens: 100, totalTokens: 9_999,
    },
    kind: "turnTokenUsage", observedAt: now, threadId: fixtureIdentityValues.WorkbenchThreadId["thread"], turnId: fixtureIdentityValues.WorkbenchTurnId["turn"], usageDataVersion: 2,
  }];
  new WorkbenchTranscriptRepository(database).settle(observations);
}

test("older usage imports cannot rewind live context or counters and rerouted models remain inferred", () => {
  const database = createDatabase();
  try {
    const now = Date.UTC(2026, 8, 4, 12);
    seedTurn(database, now - 100);
    const transcript = new WorkbenchTranscriptRepository(database);
    transcript.settle([{
      kind: "turnUsageContext", model: "gpt-5.6-sol", serviceTier: null,
      modelChanged: true, observedAt: now - 50, threadId: fixtureIdentityValues.WorkbenchThreadId["thread"], turnId: fixtureIdentityValues.WorkbenchTurnId["turn"],
    }, {
      kind: "turnUsageContext", model: null, serviceTier: null,
      observedAt: now - 200, threadId: fixtureIdentityValues.WorkbenchThreadId["thread"], turnId: fixtureIdentityValues.WorkbenchTurnId["turn"],
    }, {
      kind: "turnTokenUsage", observedAt: now - 200, threadId: fixtureIdentityValues.WorkbenchThreadId["thread"], turnId: fixtureIdentityValues.WorkbenchTurnId["turn"], usageDataVersion: 2,
      cumulative: { inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 1 },
    }]);
    const result = new WorkbenchStatsRepository(database).read({ projectId: fixtureIdentityValues.ProjectId.project, range: "7d" }, now);
    assert.equal(result.tokens.totals.all, 1_300);
    assert.equal(result.cost.basis.exactModelTokens, 0);
    assert.equal(result.cost.basis.threadInferredModelTokens, 1_300);
    assert.deepEqual(result.usageFilters.models, ["gpt-5.6-sol"]);
  } finally {
    database.close();
  }
});

test("token reads separate input categories and expose filters, drivers, and exact pricing basis", () => {
  const database = createDatabase();
  try {
    const now = Date.UTC(2026, 8, 4, 12);
    seedTurn(database, now - 60_000);
    const repository = new WorkbenchStatsRepository(database);
    const result = repository.read({ projectId: fixtureIdentityValues.ProjectId.project, range: "7d" }, now);
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
    assert.equal(repository.read({ projectId: fixtureIdentityValues.ProjectId.project, provider: "copilot", range: "7d" }, now).tokens.totals.all, 0);
  } finally {
    database.close();
  }
});

test("selected output applies to totals, pricing basis, and usage drivers", () => {
  const database = createDatabase();
  try {
    const now = Date.UTC(2026, 8, 4, 12);
    seedTurn(database, now - 60_000);
    const request = { projectId: fixtureIdentityValues.ProjectId.project, range: "7d" as const, tokenTypes: ["output" as const] };
    const result = new WorkbenchStatsRepository(database).read(request, now);
    assert.equal(result.tokens.totals.all, 300);
    assert.equal(result.tokens.totals.input, 0);
    assert.equal(result.cost.totalUsd, 0.0045);
    assert.equal(result.cost.basis.exactModelTokens, 300);
    assert.equal(result.models[0]?.tokens, 300);
    assert.equal(result.topThreads[0]?.tokens, 300);
  } finally {
    database.close();
  }
});

test("cache efficiency weighs full input, preserves empty buckets, and ignores category selection", () => {
  const database = createDatabase();
  try {
    const now = Date.UTC(2026, 8, 4, 12);
    seedTurn(database, now - 60_000);
    const repository = new WorkbenchStatsRepository(database);
    const base = { projectId: fixtureIdentityValues.ProjectId.project, range: "7d" as const };
    const full = repository.readDetailed(base, now);
    assert.ok("cacheEfficiency" in full && full.cacheEfficiency, "Cache facts must be returned independently of category totals");
    assert.deepEqual(full.cacheEfficiency.totals, { inputTokens: 1_000, cachedInputTokens: 200, cacheHitPercent: 20 });
    assert.deepEqual(full.cacheEfficiency.buckets.at(-1), { ...full.cacheEfficiency.totals,
      startedAt: Date.UTC(2026, 8, 4) });
    assert.ok(full.cacheEfficiency.buckets.slice(0, -1).every((bucket) => bucket.cacheHitPercent === null));
    assert.deepEqual(full.cacheEfficiency.worstThreads, [{
      ...full.cacheEfficiency.totals, cacheWriteInputTokens: 100,
      projectId: fixtureIdentityValues.ProjectId.project, threadId: "thread", title: "Stats thread",
    }]);
    for (const tokenTypes of [[], ["cache"], ["output"], ["input"]] as const) {
      assert.deepEqual(repository.readDetailed({ ...base, tokenTypes: [...tokenTypes] }, now).cacheEfficiency, full.cacheEfficiency);
    }
    for (const filter of [{ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("other") }, { provider: "copilot" as const }, { model: "other" }]) {
      const result = repository.readDetailed({ ...base, ...filter }, now).cacheEfficiency;
      assert.ok(result);
      assert.deepEqual(result.totals, { inputTokens: 0, cachedInputTokens: 0, cacheHitPercent: null });
      assert.deepEqual(result.worstThreads, []);
    }
  } finally { database.close(); }
});

test("cache leaderboard ranks all positive-input threads by percentage, then input volume, before limiting", () => {
  const database = createDatabase();
  try {
    const now = Date.UTC(2026, 8, 4, 12);
    const transcript = new WorkbenchTranscriptRepository(database);
    let totalInput = 0;
    let totalCached = 0;
    for (let index = 0; index < 16; index++) {
      const id = `cache-${index}`;
      const input = index === 15 ? 0 : index === 14 ? 100 : 10_000 + index;
      const cached = index >= 13 ? 0 : 9_000;
      totalInput += input;
      totalCached += cached;
      transcript.settle([{
        activityAt: now, createdAt: now, kind: "thread", projectId: fixtureIdentityValues.ProjectId["project"], projectRoot: "C:/project",
        threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(id), title: id, updatedAt: now,
      }, {
        createdAt: now, durationMs: 1, endedAt: now + 1, harnessId: "codex", kind: "turn",
        nativeLocation: "C:/project", nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse(id), nativeTurnId: fixtureIdentitySchemas.NativeTurnIdSchema.parse(id), startedAt: now,
        state: "completed", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(id), turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(id), turnIndex: 0,
      }, {
        cumulative: { inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: 0,
          outputTokens: 1, reasoningOutputTokens: 0, totalTokens: input + 1 },
        kind: "turnTokenUsage", observedAt: now, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(id), turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(id), usageDataVersion: 2,
      }]);
    }
    const result = new WorkbenchStatsRepository(database).readDetailed({ projectId: null, range: "7d" }, now);
    assert.ok(result.cacheEfficiency);
    assert.equal(result.cacheEfficiency.totals.cacheHitPercent, totalCached / totalInput * 100);
    assert.equal(result.cacheEfficiency.worstThreads.length, 12);
    assert.deepEqual(result.cacheEfficiency.worstThreads.slice(0, 3).map((row) => row.threadId), ["cache-13", "cache-14", "cache-12"]);
    assert.ok(result.cacheEfficiency.worstThreads.every((row) => row.inputTokens > 0));
    assert.equal(result.topThreads.some((row) => row.threadId === "cache-14"), false);
  } finally { database.close(); }
});

test("category selection reconciles costs, includes cache writes, and excludes non-contributing usage", () => {
  const database = createDatabase();
  try {
    const now = Date.UTC(2026, 8, 4, 12);
    seedTurn(database, now - 60_000);
    const repository = new WorkbenchStatsRepository(database);
    const base = { projectId: fixtureIdentityValues.ProjectId.project, range: "7d" as const };
    repository.recordClaimSnapshot({
      projectId: fixtureIdentityValues.ProjectId.project, threadId: "thread", harness: "codex", observedAt: now,
      roots: [{ rootId: "root", paths: ["src/file.ts"] }],
    });
    const full = repository.readDetailed({ ...base, tokenTypes: ["input", "cache", "output"] }, now);
    for (const category of ["input", "cache", "output"] as const) {
      const result = repository.readDetailed({ ...base, tokenTypes: [category] }, now);
      assert.equal(result.cost.totalUsd, full.cost.byTokenType[category]);
      assert.equal(result.cost.buckets.reduce((sum, bucket) => sum + bucket.totalUsd, 0), result.cost.totalUsd);
      assert.equal(result.summary.threadCount, 1);
      assert.equal(result.summary.turnCount, 1);
    }
    const cache = repository.readDetailed({ ...base, tokenTypes: ["cache"] }, now);
    assert.equal(cache.tokens.totals.all, 300);
    assert.equal(cache.tokens.totals.cacheWriteInput, 100);
    assert.equal(cache.summary.cacheHitPercent, 200 / 300 * 100);
    const empty = repository.readDetailed({ ...base, tokenTypes: [] }, now);
    assert.equal(empty.tokens.totals.all, 0);
    assert.equal(empty.cost.totalUsd, 0);
    assert.deepEqual(empty.summary, { cacheHitPercent: 0, threadCount: 0, turnCount: 0 });
    assert.deepEqual(empty.topThreads, []);
    assert.deepEqual(empty.models, []);
    assert.deepEqual(empty.usageFilters, full.usageFilters);
    assert.deepEqual(empty.claimHotspots, full.claimHotspots);
    new WorkbenchTranscriptRepository(database).settle([{
      kind: "turnUsageContext", model: "gpt-5.6-sol", observedAt: now, serviceTier: "fast",
      threadId: fixtureIdentityValues.WorkbenchThreadId["thread"], turnId: fixtureIdentityValues.WorkbenchTurnId["turn"],
    }, {
      cumulative: { inputTokens: 300_000, cachedInputTokens: 20_000, cacheWriteInputTokens: 10_000,
        outputTokens: 10_000, reasoningOutputTokens: 0, totalTokens: 310_000 },
      kind: "turnTokenUsage", observedAt: now, threadId: fixtureIdentityValues.WorkbenchThreadId["thread"], turnId: fixtureIdentityValues.WorkbenchTurnId["turn"], usageDataVersion: 2,
    }]);
    const longContext = repository.readDetailed({ ...base, tokenTypes: ["input", "cache", "output"] }, now);
    for (const category of ["input", "cache", "output"] as const) {
      assert.equal(repository.readDetailed({ ...base, tokenTypes: [category] }, now).cost.totalUsd, longContext.cost.byTokenType[category]);
    }
  } finally { database.close(); }
});

test("selection reranks all threads before limiting results and computes shares from selected totals", () => {
  const database = createDatabase();
  try {
    const now = Date.UTC(2026, 8, 4, 12);
    const transcript = new WorkbenchTranscriptRepository(database);
    for (let index = 0; index < 14; index += 1) {
      const id = `thread-${index}`;
      const input = index === 13 ? 0 : 10_000;
      const output = index === 13 ? 500 : 1;
      transcript.settle([{
        activityAt: now, createdAt: now, kind: "thread", projectId: fixtureIdentityValues.ProjectId["project"], projectRoot: "C:/project",
        threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(id), title: id, updatedAt: now,
      }, {
        createdAt: now, durationMs: 1, endedAt: now + 1, harnessId: "codex", kind: "turn",
        nativeLocation: "C:/project", nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse(id), nativeTurnId: fixtureIdentitySchemas.NativeTurnIdSchema.parse(id), startedAt: now,
        state: "completed", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(id), turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(id), turnIndex: 0,
      }, {
        cumulative: { inputTokens: input, outputTokens: output, cachedInputTokens: 0,
          cacheWriteInputTokens: 0, reasoningOutputTokens: 0, totalTokens: input + output },
        kind: "turnTokenUsage", observedAt: now, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(id), turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(id), usageDataVersion: 2,
      }]);
    }
    const repository = new WorkbenchStatsRepository(database);
    const base = { projectId: fixtureIdentityValues.ProjectId.project, range: "7d" as const };
    assert.equal(repository.read(base, now).topThreads.some((row) => row.threadId === "thread-13"), false);
    const selected = repository.readDetailed({ ...base, tokenTypes: ["output"] }, now);
    assert.equal(selected.topThreads[0]?.threadId, "thread-13");
    assert.equal(selected.topThreads[0]?.sharePercent, 500 / 513 * 100);
    assert.equal(selected.topThreads.length, 12);
    assert.equal(selected.summary.threadCount, 14);
    assert.equal(selected.tokens.totals.all, 513);
  } finally { database.close(); }
});

test("token reads derive turn usage from cumulative thread snapshots", () => {
  const database = createDatabase();
  try {
    const now = Date.UTC(2026, 8, 4, 12);
    const repository = new WorkbenchTranscriptRepository(database);
    repository.settle([{
      activityAt: now, createdAt: now, kind: "thread", projectId: fixtureIdentityValues.ProjectId["project"], projectRoot: "C:/project",
      threadId: fixtureIdentityValues.WorkbenchThreadId["thread"], title: "Cumulative stats", updatedAt: now,
    }, {
      createdAt: now - 2_000, durationMs: 1, endedAt: now - 1_999, harnessId: "codex", kind: "turn",
      nativeLocation: "C:/project", nativeThreadId: fixtureIdentityValues.NativeThreadId["thread"], nativeTurnId: fixtureIdentityValues.NativeTurnId["one"], startedAt: now - 2_000,
      state: "completed", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"], turnId: fixtureIdentityValues.WorkbenchTurnId["one"], turnIndex: 0,
    }, {
      cumulative: {
        cacheWriteInputTokens: 0, cachedInputTokens: 60, inputTokens: 100,
        outputTokens: 10, reasoningOutputTokens: 2, totalTokens: 110,
      },
      kind: "turnTokenUsage", observedAt: now - 1_999,
      threadId: fixtureIdentityValues.WorkbenchThreadId["thread"], turnId: fixtureIdentityValues.WorkbenchTurnId["one"], usageDataVersion: 2,
    }, {
      createdAt: now - 1_000, durationMs: 1, endedAt: now - 999, harnessId: "codex", kind: "turn",
      nativeLocation: "C:/project", nativeThreadId: fixtureIdentityValues.NativeThreadId["thread"], nativeTurnId: fixtureIdentityValues.NativeTurnId["two"], startedAt: now - 1_000,
      state: "completed", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"], turnId: fixtureIdentityValues.WorkbenchTurnId["two"], turnIndex: 1,
    }, {
      cumulative: {
        cacheWriteInputTokens: 0, cachedInputTokens: 180, inputTokens: 300,
        outputTokens: 30, reasoningOutputTokens: 6, totalTokens: 330,
      },
      kind: "turnTokenUsage", observedAt: now - 999,
      threadId: fixtureIdentityValues.WorkbenchThreadId["thread"], turnId: fixtureIdentityValues.WorkbenchTurnId["two"], usageDataVersion: 2,
    }]);

    assert.deepEqual(new WorkbenchStatsRepository(database).read({
      projectId: fixtureIdentityValues.ProjectId.project,
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
      nativeLocation: "C:/project", nativeThreadId: fixtureIdentityValues.NativeThreadId["thread"], nativeTurnId: fixtureIdentitySchemas.NativeTurnIdSchema.parse(id), startedAt,
      state: "completed", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"], turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(id), turnIndex,
    }, {
      kind: "turnUsageContext", model, observedAt: startedAt, serviceTier: "standard",
      threadId: fixtureIdentityValues.WorkbenchThreadId["thread"], turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(id),
    }, {
      cumulative: {
        cacheWriteInputTokens: 0,
        reasoningOutputTokens: 0,
        ...cumulative,
      },
      kind: "turnTokenUsage", observedAt: startedAt + 1,
      threadId: fixtureIdentityValues.WorkbenchThreadId["thread"], turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(id), usageDataVersion: 2,
    }];
    repository.settle([{
      activityAt: now, createdAt: now - 8 * 86_400_000, kind: "thread",
      projectId: fixtureIdentityValues.ProjectId["project"], projectRoot: "C:/project", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"],
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
      projectId: fixtureIdentityValues.ProjectId.project,
      range: "7d",
    }, now).tokens.totals, {
      all: 275,
      cachedInput: 140,
      cacheWriteInput: 0,
      input: 250,
      output: 25,
      uncachedInput: 110,
    });
    const cache = new WorkbenchStatsRepository(database).readDetailed({
      model: "gpt-5.4", projectId: fixtureIdentityValues.ProjectId.project, range: "7d", tokenTypes: [],
    }, now).cacheEfficiency;
    assert.ok(cache);
    assert.equal(cache.totals.inputTokens, 250);
    assert.equal(cache.totals.cachedInputTokens, 140);
    assert.ok(cache.totals.cacheHitPercent !== null && Math.abs(cache.totals.cacheHitPercent - 56) < 1e-10);
    assert.equal(cache.buckets.find((bucket) => bucket.startedAt === Date.UTC(2026, 8, 1))?.cacheHitPercent, 60);
    assert.equal(cache.buckets.find((bucket) => bucket.startedAt === Date.UTC(2026, 8, 2))?.cacheHitPercent, null);
    assert.equal(cache.buckets.find((bucket) => bucket.startedAt === Date.UTC(2026, 8, 3))?.cacheHitPercent, 40);
  } finally {
    database.close();
  }
});

test("token reads omit stale snapshots and first snapshots without a retained baseline", () => {
  const database = createDatabase();
  try {
    const now = Date.UTC(2026, 8, 4, 12);
    const usage = (threadId: string, turnId: string, turnIndex: number): WorkbenchTranscriptAtomicObservation[] => [{
      activityAt: now, createdAt: now, kind: "thread", projectId: fixtureIdentityValues.ProjectId["project"], projectRoot: "C:/project",
      threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId), title: threadId, updatedAt: now,
    }, {
      createdAt: now, durationMs: 1, endedAt: now + 1, harnessId: "codex", kind: "turn",
      nativeLocation: "C:/project", nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse(threadId), nativeTurnId: fixtureIdentitySchemas.NativeTurnIdSchema.parse(turnId), startedAt: now,
      state: "completed", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId), turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(turnId), turnIndex,
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
      threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId), turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(turnId), usageDataVersion: 2,
    }];
    new WorkbenchTranscriptRepository(database).settle([
      ...usage("ambiguous", "ambiguous-turn", 2),
      ...usage("stale", "stale-turn", 0),
    ]);
    database.prepare(`
      UPDATE thread_turn_usage SET usage_data_version = 1 WHERE turn_id = 'stale-turn'
    `).run();

    assert.equal(new WorkbenchStatsRepository(database).read({
      projectId: fixtureIdentityValues.ProjectId.project,
      range: "7d",
    }, now).tokens.totals.all, 0);
    assert.equal(new WorkbenchStatsRepository(database).readDetailed({
      projectId: fixtureIdentityValues.ProjectId.project, range: "7d",
    }, now).cacheEfficiency?.totals.cacheHitPercent, null);
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
        projectId: fixtureIdentityValues.ProjectId.project,
        roots: [{ paths: ["src/file.ts"], rootId: "root" }],
        threadId,
      });
    }
    assert.deepEqual(repository.read({ projectId: fixtureIdentityValues.ProjectId.project, range: "7d" }, now).claimHotspots, [{
      path: "src/file.ts",
      projectId: fixtureIdentityValues.ProjectId.project,
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
