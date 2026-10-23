/*
 * Exports: none. Tests protect access, one history read per request, rendering and continuation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import WorkbenchTranscriptCommandController from "./WorkbenchTranscriptCommandController";
import { HistoryQueryError, HistoryQuerySchema, type HistoryPage } from "../database/history/history-query-contract";
import type { transcriptPageOutput } from "./transcript-command-markdown";

const coverage = { threads: 1, turns: 2, materializedTurns: 1, expiredTurns: 0, items: 201 };
const query = HistoryQuerySchema.parse({ action: "search", query: "needle", threads: ["wb-id"], json: true });
const input = { ...query, cwd: "C:/workbench", callerThreadId: "caller" };
const empty: HistoryPage = { coverage, rows: [], records: [], nextCursor: "next", older: false, newer: false, gaps: [], expired: [], search: null };
const noMaterialize = async () => {};

test("transcript command blocks managed outside-root callers before database reads but permits ordinary users", async () => {
  let reads = 0;
  const controller = new WorkbenchTranscriptCommandController({
    materializeTurn: noMaterialize, projectRoot: "C:/workbench", read: async () => { reads++; return { ...empty, nextCursor: null }; },
  });
  assert.equal((await controller.execute({ ...input, cwd: "C:/other" }, new AbortController().signal)).status, 403);
  assert.equal(reads, 0);
  assert.equal((await controller.execute({ ...input, cwd: "C:/other", callerThreadId: null }, new AbortController().signal)).status, 200);
  assert.equal(reads, 1);
});

test("a search request reads history once and hands continuation to the caller instead of looping", async () => {
  let reads = 0;
  const signal = new AbortController();
  const controller = new WorkbenchTranscriptCommandController({ materializeTurn: noMaterialize, projectRoot: "C:/workbench", read: async () => {
    reads++;
    return empty;
  } });
  const response = await controller.execute(input, signal.signal);
  assert.equal(response.status, 200);
  const result = await response.json() as ReturnType<typeof transcriptPageOutput>;
  assert.equal(reads, 1);
  assert.equal(result.rows.length, 0);
  assert.match(result.nextCommand ?? "", /--cursor 'next'/u);

  const cancelled = new WorkbenchTranscriptCommandController({ materializeTurn: noMaterialize, projectRoot: "C:/workbench", read: async () => {
    signal.abort(new Error("cancelled")); return empty;
  } });
  await assert.rejects(cancelled.execute(input, signal.signal), /cancelled/u);
});

test("invalid queries and stale cursors propagate as bounded failures, not empty success", async () => {
  const controller = new WorkbenchTranscriptCommandController({
    materializeTurn: noMaterialize, projectRoot: "C:/workbench", read: async () => { throw new HistoryQueryError("stale cursor"); },
  });
  assert.equal((await controller.execute({ ...input, limit: -1 }, new AbortController().signal)).status, 400);
  const response = await controller.execute(input, new AbortController().signal);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /stale cursor/u);
});

test("text rendering abbreviates matching caller directories without changing data or other paths", async () => {
  const fields = [
    { path: ["cwd"], value: "c:\\WORKBENCH\\" },
    { path: ["arguments", "cwd"], value: "C:/workbench/other" },
    { path: ["arguments", "file"], value: "C:/workbench" },
    { path: ["exitCode"], value: 0 },
    { path: ["success"], value: false },
  ];
  const controller = new WorkbenchTranscriptCommandController({ materializeTurn: noMaterialize, projectRoot: "C:/workbench", read: async () => ({
    ...empty, nextCursor: null,
    rows: [{
      id: "item", kind: "commandExecution", threadId: "wb-id", turnId: "turn", projectId: "project",
      title: "title", createdAt: 1, counts: {}, fields,
    }],
  }) });
  for (const action of ["read", "show"]) {
    const request = { ...input, action, query: null, json: false, ...(action === "show" ? { item: "item" } : {}) };
    const response = await controller.execute(request, new AbortController().signal);
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /cwd: \./u);
    assert.ok(text.includes("C:/workbench/other"));
    assert.ok(text.includes("file: C:/workbench"));
    assert.ok(!text.includes("c:\\WORKBENCH\\"));
    const dataResponse = await controller.execute({ ...request, json: true }, new AbortController().signal);
    const data = await dataResponse.json() as ReturnType<typeof transcriptPageOutput>;
    assert.deepEqual(data.rows[0]?.fields, fields);
  }
});

test("explicit provider recovery materializes the demanded turn before reading SQLite", async () => {
  const events: string[] = [];
  const controller = new WorkbenchTranscriptCommandController({
    materializeTurn: async (threadId, turnId) => { events.push(`materialize:${threadId}:${turnId}`); },
    projectRoot: "C:/workbench",
    read: async () => {
      events.push("read");
      return { ...empty, nextCursor: null };
    },
  });
  const response = await controller.execute({
    ...input,
    action: "read",
    provider: true,
    query: null,
    turn: "turn-id",
  }, new AbortController().signal);
  assert.equal(response.status, 200);
  assert.deepEqual(events, ["materialize:wb-id:turn-id", "read"]);
});
