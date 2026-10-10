/* No production exports. Protect live/retained wb tool counts, period/project scope, native exclusion, and bucket callers. */
import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { statsPeriodShape } from "workbench-shared/workbench/stats/workbench-stats-contract";
import * as identity from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema.ts";
import WorkbenchTranscriptRepository from "../transcript/WorkbenchTranscriptRepository.ts";
import type { WorkbenchTranscriptAtomicObservation } from "../transcript/workbench-transcript-types.ts";
import WorkbenchToolStatsRepository from "./WorkbenchToolStatsRepository.ts";

const day = 86_400_000;
const now = Date.UTC(2026, 8, 4, 12);
const today = Date.UTC(2026, 8, 4);

type Item = Extract<WorkbenchTranscriptAtomicObservation, { kind: "item" }>["item"];

function seedThread(transcript: WorkbenchTranscriptRepository, id: string, projectId: identity.ProjectId, items: Array<{ at: number; item: Item }>) {
  const threadId = identity.WorkbenchThreadIdSchema.parse(id);
  const turnId = identity.WorkbenchTurnIdSchema.parse(id);
  transcript.settle([{
    activityAt: now, createdAt: now - 7 * day, kind: "thread", projectId, projectRoot: "C:/project", threadId, title: id, updatedAt: now,
  }, {
    createdAt: now - 7 * day, durationMs: 1, endedAt: now, harnessId: "codex", kind: "turn", nativeLocation: "C:/project",
    nativeThreadId: identity.NativeThreadIdSchema.parse(id), nativeTurnId: identity.NativeTurnIdSchema.parse(id),
    startedAt: now - 7 * day, state: "completed", threadId, turnId, turnIndex: 0,
  }, ...items.map(({ at, item }): WorkbenchTranscriptAtomicObservation => ({
    kind: "item", lifecycle: "completed", observedAt: at, threadId, turnId, item,
  }))]);
}

const mcp = (id: string, server: string, tool: string, status: "completed" | "failed" = "completed"): Item => ({
  type: "mcpToolCall", id, server, tool, arguments: {}, status, result: null,
  error: status === "failed" ? { message: "failed" } : null, durationMs: 1, appContext: null, pluginId: null, readOnlyHint: null,
});
const native = (id: string, tool: string): Item => ({
  type: "dynamicToolCall", id, namespace: "claude", tool, arguments: {}, status: "completed", contentItems: null, success: true, durationMs: 1,
});

test("tool calls count per tool inside the period and project scope, merging Codex's two wb servers", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database);
    const transcript = new WorkbenchTranscriptRepository(database);
    seedThread(transcript, "main", testProjectIds.project, [
      { at: today - 2 * day + 1, item: mcp("a", "wb", "rg") },
      { at: today + 1, item: mcp("b", "wb", "rg", "failed") },
      { at: today + 2, item: mcp("c", "wbex", "git_arc_propose") },
      { at: today + 3, item: mcp("d", "wb", "git_arc_propose") },
      { at: today + 4, item: native("e", "Read") },
      { at: today - 30 * day, item: mcp("f", "wb", "rg") },
    ]);
    seedThread(transcript, "other", testProjectIds.other, [{ at: today + 1, item: mcp("g", "wb", "rg") }]);
    const repository = new WorkbenchToolStatsRepository(database);

    const scoped = repository.read([testProjectIds.project], statsPeriodShape("7d", null, now), now);
    assert.equal(scoped.bucketStarts.length, 7);
    assert.deepEqual(scoped.workbench.map(({ buckets, calls, failed, threads, tool }) => ({ tool, calls, failed, threads, recent: buckets.slice(-3) })), [
      { tool: "git_arc_propose", calls: 2, failed: 0, threads: 1, recent: [0, 0, 2] },
      { tool: "rg", calls: 2, failed: 1, threads: 1, recent: [1, 0, 1] },
    ]);
    assert.equal(scoped.workbench.some(({ tool }) => tool === "Read"), false, "provider-native tools are not wb tools");

    const everywhere = repository.read(null, statsPeriodShape("7d", null, now), now);
    assert.deepEqual(everywhere.workbench.find(({ tool }) => tool === "rg")?.threads, 2);

    const rg = scoped.workbench.find(({ tool }) => tool === "rg")!;
    assert.deepEqual(rg.bucketThreads.at(-1)?.map(({ calls, thread }) => [calls, scoped.threads[thread]?.threadId]), [[1, "main"]]);
    assert.equal(scoped.threadCount, 1);
    assert.equal(everywhere.threadCount, 2);
    assert.deepEqual(scoped.threads.map(({ harness, title }) => [harness, title]), [["codex", "main"]]);

    const todayOnly =repository.read([testProjectIds.project], statsPeriodShape("7d", { from: today, to: today }, now), now);
    assert.deepEqual(todayOnly.bucketStarts, [today]);
    assert.deepEqual(todayOnly.workbench.find(({ tool }) => tool === "rg")?.buckets, [1]);
  } finally { database.close(); }
});

test("expired daily aggregates merge with live calls without changing project or thread semantics", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database);
    const transcript = new WorkbenchTranscriptRepository(database);
    seedThread(transcript, "main", testProjectIds.project, [
      { at: today + 1, item: mcp("live", "wb", "rg", "failed") },
    ]);
    database.prepare(`
      INSERT INTO thread_tool_daily_aggregates
        (project_id, thread_id, day, tool_name, call_count, failure_count)
      VALUES (?, 'main', ?, 'rg', 2, 0)
    `).run(testProjectIds.project, Math.floor((today - day) / day));

    const result = new WorkbenchToolStatsRepository(database)
      .read([testProjectIds.project], statsPeriodShape("7d", null, now), now);
    assert.deepEqual(result.workbench.map(({ calls, failed, threads, tool }) => ({
      calls, failed, threads, tool,
    })), [{ calls: 3, failed: 1, threads: 1, tool: "rg" }]);
    assert.equal(result.threadCount, 1);
    assert.deepEqual(result.workbench[0]?.buckets.slice(-2), [2, 1]);
    assert.deepEqual(result.workbench[0]?.bucketThreads.slice(-2).map(bucket => bucket.map(({ calls }) => calls)), [[2], [1]]);
  } finally {
    database.close();
  }
});
