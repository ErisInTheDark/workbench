/*
 * No production exports. Tests the workflow ledger keeps only successful Workbench filings and switches, in transcript order across turns.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchTranscriptAtomicObservation } from "./workbench-transcript-types.ts";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema.ts";
import WorkbenchTranscriptRepository from "./WorkbenchTranscriptRepository.ts";
import WorkbenchWorkflowLedgerRepository from "./WorkbenchWorkflowLedgerRepository.ts";

type FixtureItem = Extract<WorkbenchTranscriptAtomicObservation, { kind: "item" }>["item"];

function seedThread(database: Database.Database, threadId: string) {
  database.prepare("INSERT OR IGNORE INTO workbench_projects(id) VALUES (?)").run(testProjectIds.project);
  database.prepare("INSERT OR IGNORE INTO workbench_harnesses(id) VALUES ('codex')").run();
  database.prepare(`INSERT INTO workbench_threads
    (id, project_id, project_root, title, transcript_content_version, created_at, updated_at, activity_at)
    VALUES (?, ?, 'C:/project', 'thread', 1, 1, 1, 1)`).run(threadId, testProjectIds.project);
}

function settleTurn(database: Database.Database, threadId: string, turnIndex: number, items: FixtureItem[]) {
  const turnId = `${threadId}-${turnIndex}`;
  database.prepare(`INSERT INTO thread_turns
    (id, thread_id, turn_index, harness_id, native_location, native_thread_id, state, created_at)
    VALUES (?, ?, ?, 'codex', 'C:/project', ?, 'completed', ?)`).run(turnId, threadId, turnIndex, threadId, turnIndex + 1);
  database.prepare("INSERT INTO thread_turn_materializations(turn_id, thread_id, materialized_at) VALUES (?, ?, ?)").run(turnId, threadId, turnIndex + 1);
  new WorkbenchTranscriptRepository(database).settle(items.map((item): WorkbenchTranscriptAtomicObservation => ({
    kind: "item", lifecycle: "completed", observedAt: turnIndex + 1, item,
    threadId: WorkbenchThreadIdSchema.parse(threadId), turnId: WorkbenchTurnIdSchema.parse(turnId),
  })));
}

function call(id: string, tool: string, args: object, options: { failed?: boolean; server?: string } = {}): FixtureItem {
  return {
    type: "mcpToolCall", id, server: options.server ?? "wb", tool, arguments: args,
    status: options.failed ? "failed" : "completed",
    result: options.failed ? null : { content: [{ type: "text", text: "ok" }], structuredContent: null, _meta: null },
    error: options.failed ? { message: "Not entered." } : null,
    durationMs: 1, appContext: null, pluginId: null, readOnlyHint: false,
  };
}

test("the ledger keeps successful Workbench proofs and mode switches in order across turns", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database);
    seedThread(database, "thread");
    seedThread(database, "other");
    settleTurn(database, "thread", 0, [
      call("plan", "proof_of_work", { proofs: { "plan.result": "done" } }),
      call("rejected", "mode_set", { mode: "Brief" }, { failed: true }),
      call("foreign", "mode_set", { mode: "Brief" }, { server: "someone" }),
      call("done", "task_completed", {}),
    ]);
    settleTurn(database, "thread", 1, [call("brief", "mode_set", { mode: "Brief" }), call("late", "proof_of_work", { notApplicable: ["plan.verify"] })]);
    settleTurn(database, "other", 0, [call("elsewhere", "mode_set", { mode: "Review" })]);

    assert.deepEqual(new WorkbenchWorkflowLedgerRepository(database).read("thread"), [
      { kind: "proof", proof: { proofs: { "plan.result": "done" } } },
      { kind: "mode", mode: "Brief" },
      { kind: "proof", proof: { notApplicable: ["plan.verify"] } },
    ]);
  } finally { database.close(); }
});
