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
import { STATS_TOKEN_TYPES, WorkbenchStatsResponseSchema } from "workbench-shared/workbench/stats/workbench-stats-contract";
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
    const result = new WorkbenchStatsRepository(database).read({ projectIds: [fixtureIdentityValues.ProjectId.project], range: "7d", section: "usage" }, now);
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
    const result = repository.read({ projectIds: [fixtureIdentityValues.ProjectId.project], range: "7d", section: "usage" }, now);
    assert.deepEqual(result.tokens.totals, {
      all: 1_300,
      cachedInput: 200,
      cacheWriteInput: 100,
      input: 1_000,
      output: 300,
      uncachedInput: 700,
    });
    assert.deepEqual(result.cost.basis, {
      exactModelTokens: 1_300,
      projectInferredModelTokens: 0,
      threadInferredModelTokens: 0,
      unpricedTokens: 0,
    });
    assert.deepEqual(result.usageFilters, { models: ["gpt-5.4"], providers: ["codex"] });
    assert.equal(result.models[0]?.tokens, 1_300);
    assert.equal(result.topThreads[0]?.threadId, "thread");
    assert.equal(repository.read({ projectIds: [fixtureIdentityValues.ProjectId.project], provider: "copilot", range: "7d", section: "usage" }, now).tokens.totals.all, 0);
  } finally {
    database.close();
  }
});

test("selected output applies to totals, pricing basis, and usage drivers", () => {
  const database = createDatabase();
  try {
    const now = Date.UTC(2026, 8, 4, 12);
    seedTurn(database, now - 60_000);
    const request = { projectIds: [fixtureIdentityValues.ProjectId.project], range: "7d" as const, section: "usage" as const, tokenTypes: ["output" as const] };
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
    const base = { projectIds: [fixtureIdentityValues.ProjectId.project], range: "7d" as const, section: "usage" as const };
    const full = repository.read(base, now);
    assert.ok("cacheEfficiency" in full && full.cacheEfficiency, "Cache facts must be returned independently of category totals");
    assert.deepEqual(full.cacheEfficiency.totals, { inputTokens: 1_000, cachedInputTokens: 200, cacheHitPercent: 20 });
    assert.deepEqual(full.cacheEfficiency.buckets.at(-1), { ...full.cacheEfficiency.totals,
      startedAt: Date.UTC(2026, 8, 4) });
    assert.ok(full.cacheEfficiency.buckets.slice(0, -1).every((bucket) => bucket.cacheHitPercent === null));
    // 800 uncached tokens is far too small for its hit rate to rank.
    assert.deepEqual(full.cacheEfficiency.worstThreads, []);
    for (const tokenTypes of [[], ["cacheRead"], ["cacheWrite"], ["output"], ["input"]] as const) {
      assert.deepEqual(repository.read({ ...base, tokenTypes: [...tokenTypes] }, now).cacheEfficiency, full.cacheEfficiency);
    }
    for (const filter of [{ projectIds: [testProjectIds.other] }, { projectIds: [] }, { provider: "copilot" as const }, { model: "other" }]) {
      const result = repository.read({ ...base, ...filter }, now).cacheEfficiency;
      assert.ok(result);
      assert.deepEqual(result.totals, { inputTokens: 0, cachedInputTokens: 0, cacheHitPercent: null });
      assert.deepEqual(result.worstThreads, []);
    }
  } finally { database.close(); }
});

test("cache leaderboard ranks threads with 500K+ uncached input by percentage, then input volume, before limiting", () => {
  const database = createDatabase();
  try {
    const now = Date.UTC(2026, 8, 4, 12);
    const transcript = new WorkbenchTranscriptRepository(database);
    let totalInput = 0;
    let totalCached = 0;
    for (let index = 0; index < 16; index++) {
      const id = `cache-${index}`;
      const input = index === 15 ? 0 : index === 14 ? 499_999 : 1_000_000 + index;
      const cached = index >= 13 ? 0 : 400_000;
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
    const result = new WorkbenchStatsRepository(database).read({ projectIds: null, range: "7d", section: "usage" }, now);
    assert.ok(result.cacheEfficiency);
    assert.equal(result.cacheEfficiency.totals.cacheHitPercent, totalCached / totalInput * 100);
    assert.equal(result.cacheEfficiency.worstThreads.length, 12);
    // cache-14 misses everything but stays below the uncached floor.
    assert.deepEqual(result.cacheEfficiency.worstThreads.slice(0, 3).map((row) => row.threadId), ["cache-13", "cache-12", "cache-11"]);
    assert.ok(result.cacheEfficiency.worstThreads.every((row) => row.inputTokens - row.cachedInputTokens >= 500_000));
    assert.equal(result.topThreads.some((row) => row.threadId === "cache-14"), false);
    assert.ok([...result.topThreads, ...result.cacheEfficiency.worstThreads].every((row) => row.harness === "codex"),
      "ranked threads name their provider so the UI can open and describe them");
  } finally { database.close(); }
});

test("category selection reconciles costs, includes cache writes, and excludes non-contributing usage", () => {
  const database = createDatabase();
  try {
    const now = Date.UTC(2026, 8, 4, 12);
    seedTurn(database, now - 60_000);
    const repository = new WorkbenchStatsRepository(database);
    const base = { projectIds: [fixtureIdentityValues.ProjectId.project], range: "7d" as const, section: "usage" as const };
    repository.recordClaimSnapshot({
      projectId: fixtureIdentityValues.ProjectId.project, threadId: "thread", harness: "codex", observedAt: now,
      roots: [{ rootId: "root", paths: ["src/file.ts"] }],
    });
    const full = repository.read(base, now);
    for (const category of STATS_TOKEN_TYPES) {
      const result = repository.read({ ...base, tokenTypes: [category] }, now);
      assert.equal(result.cost.totalUsd, full.cost.byTokenType[category]);
      assert.equal(result.cost.buckets.reduce((sum, bucket) => sum + bucket.totalUsd, 0), result.cost.totalUsd);
      assert.equal(result.summary.threadCount, 1);
      assert.equal(result.summary.turnCount, 1);
    }
    const writes = repository.read({ ...base, tokenTypes: ["cacheWrite"] }, now);
    assert.equal(writes.tokens.totals.all, 100);
    assert.equal(writes.tokens.totals.cachedInput, 0, "cache reads are their own category");
    const legacy = repository.read({ ...base, tokenTypes: ["cache"] as never }, now);
    assert.equal(legacy.tokens.totals.all, 300, "the legacy combined category still reads both halves");
    const empty = repository.read({ ...base, tokenTypes: [] }, now);
    assert.equal(empty.tokens.totals.all, 0);
    assert.equal(empty.cost.totalUsd, 0);
    assert.deepEqual({ ...empty.summary, buckets: empty.summary.buckets.filter(({ turnCount }) => turnCount) }, { buckets: [], threadCount: 0, turnCount: 0 });
    assert.deepEqual(empty.topThreads, []);
    assert.deepEqual(empty.models, []);
    assert.deepEqual(empty.usageFilters, full.usageFilters);
    const claims = { ...base, section: "claims" as const };
    assert.deepEqual(repository.read({ ...claims, tokenTypes: [] }, now).claimHotspots, repository.read(claims, now).claimHotspots);
    new WorkbenchTranscriptRepository(database).settle([{
      kind: "turnUsageContext", model: "gpt-5.6-sol", observedAt: now, serviceTier: "fast",
      threadId: fixtureIdentityValues.WorkbenchThreadId["thread"], turnId: fixtureIdentityValues.WorkbenchTurnId["turn"],
    }, {
      cumulative: { inputTokens: 300_000, cachedInputTokens: 20_000, cacheWriteInputTokens: 10_000,
        outputTokens: 10_000, reasoningOutputTokens: 0, totalTokens: 310_000 },
      kind: "turnTokenUsage", observedAt: now, threadId: fixtureIdentityValues.WorkbenchThreadId["thread"], turnId: fixtureIdentityValues.WorkbenchTurnId["turn"], usageDataVersion: 2,
    }]);
    const longContext = repository.read(base, now);
    for (const category of STATS_TOKEN_TYPES) {
      assert.equal(repository.read({ ...base, tokenTypes: [category] }, now).cost.totalUsd, longContext.cost.byTokenType[category]);
    }
  } finally { database.close(); }
});

test("a selected period narrows usage, comparison and claims to its days while plan limits keep the whole range", () => {
  const database = createDatabase();
  try {
    const day = 86_400_000;
    const now = Date.UTC(2026, 8, 4, 12);
    const today = Date.UTC(2026, 8, 4);
    seedTurn(database, now - 60_000);
    const repository = new WorkbenchStatsRepository(database);
    repository.recordClaimSnapshot({
      projectId: fixtureIdentityValues.ProjectId.project, threadId: "thread", harness: "codex", observedAt: now,
      roots: [{ rootId: "root", paths: ["src/file.ts"] }],
    });
    repository.recordRateLimits({ harness: "codex", observedAt: today - 5 * day, snapshots: [{
      limitId: "codex", limitName: null, primary: { durationMinutes: 300, resetsAt: null, usedPercent: 10 }, secondary: null, tertiary: null,
    }] });
    const base = { projectIds: [fixtureIdentityValues.ProjectId.project], range: "7d" as const, section: "usage" as const };
    const full = repository.read(base, now);
    const earlierPeriod = { from: today - 3 * day, to: today - day };
    const earlier = repository.read({ ...base, period: earlierPeriod }, now);
    assert.equal(earlier.startedAt, today - 3 * day);
    assert.equal(earlier.tokens.buckets.length, 3);
    assert.equal(earlier.tokens.totals.all, 0, "today's turn is outside the period");
    assert.deepEqual(repository.read({ ...base, period: earlierPeriod, section: "claims" }, now).claimHotspots, []);
    const limits = { ...base, section: "limits" as const };
    assert.deepEqual(repository.read({ ...limits, period: earlierPeriod }, now).rateLimits, repository.read(limits, now).rateLimits, "plan limits ignore the period");
    const latest = repository.read({ ...base, period: { from: today, to: today } }, now);
    assert.equal(latest.tokens.totals.all, full.tokens.totals.all);
    assert.equal(repository.read({ ...base, period: { from: today, to: today }, section: "claims" }, now).claimHotspots.length, 1);
    const stale = repository.read({ ...base, period: { from: today - 30 * day, to: today - 20 * day } }, now);
    assert.deepEqual([stale.tokens.buckets.length, stale.tokens.totals.all], [0, 0], "a period the window moved past selects nothing");
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
    const base = { projectIds: [fixtureIdentityValues.ProjectId.project], range: "7d" as const, section: "usage" as const };
    assert.equal(repository.read(base, now).topThreads.some((row) => row.threadId === "thread-13"), false);
    const selected = repository.read({ ...base, tokenTypes: ["output"] }, now);
    assert.equal(selected.topThreads[0]?.threadId, "thread-13");
    assert.equal(selected.topThreads[0]?.sharePercent, 500 / 513 * 100);
    assert.equal(selected.topThreads.length, 12);
    assert.equal(selected.summary.threadCount, 14);
    assert.equal(selected.tokens.totals.all, 513);
  } finally { database.close(); }
});

test("token reads derive turn usage from cumulative thread snapshots and split each thread by model", () => {
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
      kind: "turnUsageContext", model: "gpt-5.4", observedAt: now - 1_999, serviceTier: null,
      threadId: fixtureIdentityValues.WorkbenchThreadId["thread"], turnId: fixtureIdentityValues.WorkbenchTurnId["one"],
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
    }, {
      kind: "turnUsageContext", model: "gpt-5.6-sol", observedAt: now - 999, serviceTier: null,
      threadId: fixtureIdentityValues.WorkbenchThreadId["thread"], turnId: fixtureIdentityValues.WorkbenchTurnId["two"],
    }]);

    const result = new WorkbenchStatsRepository(database).read({
      projectIds: [fixtureIdentityValues.ProjectId.project],
      range: "7d",
      section: "usage",
    }, now);
    assert.deepEqual(result.tokens.totals, {
      all: 330,
      cachedInput: 180,
      cacheWriteInput: 0,
      input: 300,
      output: 30,
      uncachedInput: 120,
    });
    const [thread] = result.topThreads;
    assert.ok(thread);
    assert.deepEqual(thread.modelShares.map(({ model, tokens }) => ({ model, tokens })), [
      { model: "gpt-5.6-sol", tokens: 220 }, { model: "gpt-5.4", tokens: 110 },
    ]);
    assert.equal(thread.modelShares.reduce((sum, share) => sum + share.costUsd, 0).toFixed(8), thread.costUsd.toFixed(8));
    assert.deepEqual(result.summary.buckets.at(-1), { startedAt: Date.UTC(2026, 8, 4), threadCount: 1, turnCount: 2 });
    assert.ok(result.summary.buckets.slice(0, -1).every(({ threadCount, turnCount }) => threadCount === 0 && turnCount === 0));
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
      projectIds: [fixtureIdentityValues.ProjectId.project],
      range: "7d",
      section: "usage",
    }, now).tokens.totals, {
      all: 275,
      cachedInput: 140,
      cacheWriteInput: 0,
      input: 250,
      output: 25,
      uncachedInput: 110,
    });
    const cache = new WorkbenchStatsRepository(database).read({
      model: "gpt-5.4", projectIds: [fixtureIdentityValues.ProjectId.project], range: "7d", section: "usage", tokenTypes: [],
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

    const result = new WorkbenchStatsRepository(database).read({
      projectIds: [fixtureIdentityValues.ProjectId.project], range: "7d", section: "usage",
    }, now);
    assert.equal(result.tokens.totals.all, 0);
    assert.equal(result.cacheEfficiency.totals.cacheHitPercent, null);
  } finally {
    database.close();
  }
});

test("claim traffic counts distinct threads instead of observations or occupied time, and names its claimants", () => {
  const database = createDatabase();
  try {
    const repository = new WorkbenchStatsRepository(database);
    const now = Date.UTC(2026, 8, 4, 12);
    seedTurn(database, now - 60_000);
    for (const [threadId, observedAt] of [["two", now - 60_000], ["two", now], ["thread", now]] as const) {
      repository.recordClaimSnapshot({
        harness: "codex",
        observedAt,
        projectId: fixtureIdentityValues.ProjectId.project,
        roots: [{ paths: ["src/file.ts"], rootId: "root" }],
        threadId,
      });
    }
    assert.deepEqual(repository.read({ projectIds: [fixtureIdentityValues.ProjectId.project], range: "7d", section: "claims" }, now).claimHotspots, [{
      path: "src/file.ts",
      projectId: fixtureIdentityValues.ProjectId.project,
      rootId: "root",
      threadCount: 2,
      // Claimants rank by lifetime tokens; provider-only claimants have no openable thread, title, or usage.
      threads: [
        { harness: "codex", threadId: "thread", title: "Stats thread", tokens: 9_999 },
        { harness: "codex", threadId: null, title: null, tokens: 0 },
      ],
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
    const samples = repository.read({ projectIds: null, range: "7d", section: "limits" }, now).rateLimits[0]?.samples;
    assert.equal(samples?.[0]?.secondary?.usedPercent, 12);
    const sample = samples?.at(-1);
    assert.equal(sample?.primary?.usedPercent, 42);
    assert.equal(sample?.secondary, null);
  } finally {
    database.close();
  }
});

test("rate limits preserve a tertiary account window", () => {
  const database = createDatabase();
  try {
    const repository = new WorkbenchStatsRepository(database);
    const now = Date.UTC(2026, 8, 4, 12);
    repository.recordRateLimits({
      harness: "opencode",
      observedAt: now,
      snapshots: [{
        limitId: "opencode-go",
        limitName: "OpenCode Go",
        primary: { durationMinutes: 300, resetsAt: now, usedPercent: 12 },
        secondary: { durationMinutes: 10_080, resetsAt: now, usedPercent: 34 },
        tertiary: { durationMinutes: 43_200, resetsAt: now, usedPercent: 56 },
      }],
    });
    const sample = repository.read({ projectIds: null, range: "7d", section: "limits" }, now).rateLimits[0]?.samples[0];
    assert.equal(sample?.tertiary?.usedPercent, 56);
  } finally {
    database.close();
  }
});

function seedUsage(database: Database.Database, options: {
  id: string; projectId: fixtureIdentitySchemas.ProjectId; at: number; model: string | null;
  harness?: "codex" | "claude" | "opencode"; input: number; output: number;
}) {
  const threadId = fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(options.id);
  const turnId = fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(options.id);
  new WorkbenchTranscriptRepository(database).settle([{
    activityAt: options.at, createdAt: options.at, kind: "thread", projectId: options.projectId, projectRoot: "C:/project",
    threadId, title: options.id, updatedAt: options.at,
  }, {
    createdAt: options.at, durationMs: 1, endedAt: options.at + 1, harnessId: options.harness ?? "codex", kind: "turn",
    nativeLocation: "C:/project", nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse(options.id),
    nativeTurnId: fixtureIdentitySchemas.NativeTurnIdSchema.parse(options.id), startedAt: options.at,
    state: "completed", threadId, turnId, turnIndex: 0,
  }, ...(options.model ? [{
    kind: "turnUsageContext" as const, model: options.model, observedAt: options.at, serviceTier: null, threadId, turnId,
  }] : []), {
    cumulative: { inputTokens: options.input, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: options.output,
      reasoningOutputTokens: 0, totalTokens: options.input + options.output },
    kind: "turnTokenUsage", observedAt: options.at, threadId, turnId, usageDataVersion: 2,
  }]);
}

test("project scope reads exactly the selected projects and breaks usage down by project and provider", () => {
  const database = createDatabase();
  try {
    const now = Date.UTC(2026, 8, 4, 12);
    // Inputs stay under the 272K long-context tier so rates are the standard ones.
    seedUsage(database, { id: "a", projectId: testProjectIds.project, at: now, model: "gpt-5.4", input: 200_000, output: 0 });
    seedUsage(database, { id: "b", projectId: testProjectIds.other, at: now, model: "claude-opus-5-5", harness: "claude", input: 0, output: 1_000_000 });
    seedUsage(database, { id: "c", projectId: testProjectIds.foreign, at: now, model: "gpt-5.4", input: 250_000, output: 0 });
    const repository = new WorkbenchStatsRepository(database);
    const scoped = repository.read({ projectIds: [testProjectIds.project, testProjectIds.other], range: "7d", section: "usage" }, now);
    assert.equal(scoped.tokens.totals.all, 1_200_000);
    assert.equal(scoped.cost.totalUsd, 20.5);
    assert.deepEqual(new Map(scoped.projects.map(({ projectId, costUsd }) => [projectId, costUsd])), new Map([
      [testProjectIds.project, 0.5],
      [testProjectIds.other, 20],
    ]));
    assert.deepEqual(new Set(scoped.providers.map(({ provider }) => provider)), new Set(["codex", "claude"]));
    assert.equal(repository.read({ projectIds: null, range: "7d", section: "usage" }, now).tokens.totals.all, 1_450_000);
    assert.equal(repository.read({ projectIds: [], range: "7d", section: "usage" }, now).tokens.totals.all, 0);
  } finally { database.close(); }
});

test("the previous window compares the same length immediately before the range", () => {
  const database = createDatabase();
  try {
    const now = Date.UTC(2026, 8, 20, 12);
    const day = 86_400_000;
    seedUsage(database, { id: "current", projectId: testProjectIds.project, at: now - day, model: "gpt-5.4", input: 100_000, output: 0 });
    seedUsage(database, { id: "previous", projectId: testProjectIds.project, at: now - 10 * day, model: "gpt-5.4", input: 200_000, output: 0 });
    seedUsage(database, { id: "ancient", projectId: testProjectIds.project, at: now - 20 * day, model: "gpt-5.4", input: 250_000, output: 0 });
    const result = new WorkbenchStatsRepository(database).read({ projectIds: null, range: "7d", section: "usage" }, now);
    assert.equal(result.tokens.totals.all, 100_000);
    assert.deepEqual(result.previous, { costUsd: 0.5, threadCount: 1, tokens: 200_000, turnCount: 1 });
  } finally { database.close(); }
});

test("unpriced models keep their tokens but never contribute or borrow cost", () => {
  const database = createDatabase();
  try {
    const now = Date.UTC(2026, 8, 4, 12);
    seedUsage(database, { id: "priced", projectId: testProjectIds.project, at: now, model: "gpt-5.4", input: 200_000, output: 0 });
    seedUsage(database, { id: "mystery", projectId: testProjectIds.project, at: now, model: "mystery-model", input: 3_000_000, output: 0 });
    seedUsage(database, { id: "unknown", projectId: testProjectIds.project, at: now, model: null, input: 7, output: 0 });
    // Earlier releases persisted provider-default guesses; reads must not trust them.
    database.prepare(`
      INSERT INTO thread_usage_model_attributions (turn_id, model, source, policy_version, updated_at)
      VALUES ('unknown', 'gpt-5.4', 'provider', 1, 1)
    `).run();
    const result = new WorkbenchStatsRepository(database).read({ projectIds: null, range: "7d", section: "usage" }, now);
    assert.equal(result.tokens.totals.all, 3_200_007);
    assert.equal(result.cost.totalUsd, 0.5);
    assert.equal(result.cost.basis.unpricedTokens, 3_000_007);
    assert.deepEqual(result.cost.unpricedModels, [
      { model: "mystery-model", provider: "codex", tokens: 3_000_000 },
      { model: null, provider: "codex", tokens: 7 },
    ]);
    assert.equal(result.models.find(({ model }) => model === "mystery-model")?.costUsd, 0);
  } finally { database.close(); }
});

test("claimed roots report only roots with claims in the window and their earliest claim day", () => {
  const database = createDatabase();
  try {
    const repository = new WorkbenchStatsRepository(database);
    const now = Date.UTC(2026, 8, 20, 12);
    const day = 86_400_000;
    for (const [rootId, observedAt] of [["a", now - 3 * day], ["a", now - day], ["b", now - 30 * day]] as const) {
      repository.recordClaimSnapshot({
        harness: "codex", observedAt, projectId: testProjectIds.project, roots: [{ paths: ["src/file.ts"], rootId }], threadId: "thread",
      });
    }
    assert.deepEqual(repository.claimedRoots([testProjectIds.project], "7d", now), [
      { projectId: testProjectIds.project, rootId: "a", earliestClaimedDay: Date.UTC(2026, 8, 17) },
    ]);
    assert.equal(repository.claimedRoots(null, "all", now).length, 2);
    assert.deepEqual(repository.claimedRoots([testProjectIds.other], "all", now), []);
  } finally { database.close(); }
});

test("rate-limit reads retain range history and the newest sample within the response bound", () => {
  const database = createDatabase();
  try {
    const now = Date.UTC(2026, 8, 4, 12);
    const start = Date.UTC(2026, 7, 29);
    const count = 2_100;
    const step = Math.floor((now - start) / count);
    const insert = database.prepare(`
      INSERT INTO account_rate_limit_samples (harness_id, limit_id, limit_name, observed_at)
      VALUES (?, ?, NULL, ?)
    `);
    const window = database.prepare(`
      INSERT INTO account_rate_limit_windows (sample_id, window_kind, used_basis_points, duration_minutes, resets_at)
      VALUES (?, 'primary', ?, 300, NULL)
    `);
    database.transaction(() => {
      for (const [harness, limitId] of [["codex", "codex"], ["opencode", "opencode"]] as const) {
        for (let index = -1; index < count; index += 1) {
          const observedAt = index < 0 ? start - 1_000 : start + index * step;
          const id = Number(insert.run(harness, limitId, observedAt).lastInsertRowid);
          window.run(id, index < 0 ? 0 : index % 10_000);
        }
      }
    })();
    const result = new WorkbenchStatsRepository(database).read({ projectIds: null, range: "7d", section: "limits" }, now);
    assert.equal(WorkbenchStatsResponseSchema.safeParse(result).success, true);
    assert.equal(result.rateLimits.length, 2);
    for (const limit of result.rateLimits) {
      assert.ok(limit.samples.length <= 2_000);
      assert.equal(limit.samples[0]?.observedAt, start - 1_000);
      assert.ok(limit.samples.some(({ observedAt }) => observedAt >= start && observedAt < start + 600_000));
      assert.ok(limit.samples.some(({ observedAt }) => observedAt > start + (now - start) / 2));
      assert.equal(limit.samples.at(-1)?.observedAt, start + (count - 1) * step);
    }
  } finally { database.close(); }
});
