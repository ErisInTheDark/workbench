/*
 * Exports: none. Tests protect access, scan ownership, rendering and continuation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import WorkbenchTranscriptCommandController from "./WorkbenchTranscriptCommandController";
import { TranscriptQuerySchema, TranscriptQueryError, type TranscriptQueryPage } from "./database/transcript/transcript-query-contract";
import type { transcriptPageOutput } from "./transcript-command-markdown";

const coverage = { threads: 1, turns: 2, materializedTurns: 1, items: 201 };
const query = TranscriptQuerySchema.parse({ action: "search", queries: ["needle"], threads: ["wb-id"], json: true });
const input = { ...query, cwd: "C:/workbench", callerThreadId: "caller" };
const empty: TranscriptQueryPage = { coverage, rows: [], scanned: 200, nextCursor: "next" };

test("transcript command blocks managed outside-root callers before database reads but permits ordinary users", async () => {
  let reads = 0;
  const controller = new WorkbenchTranscriptCommandController({ projectRoot: "C:/workbench", read: async () => { reads++; return { ...empty, nextCursor: null }; } });
  assert.equal((await controller.execute({ ...input, cwd: "C:/other" }, new AbortController().signal)).status, 403);
  assert.equal(reads, 0);
  assert.equal((await controller.execute({ ...input, cwd: "C:/other", callerThreadId: null }, new AbortController().signal)).status, 200);
  assert.equal(reads, 1);
});

test("search fills a result page across empty batches without ignoring cancellation", async () => {
  let reads = 0;
  const signal = new AbortController();
  const controller = new WorkbenchTranscriptCommandController({ projectRoot: "C:/workbench", read: async request => {
    reads++;
    if (reads === 1) return empty;
    assert.equal(request.cursor, "next");
    return { ...empty, nextCursor: null, scanned: 1, rows: [{
      kind: "assistant-message", id: "item", threadId: "wb-id", turnId: "turn", projectId: "project", title: "title",
      createdAt: 1, fields: [{ path: ["text"], value: "needle" }], counts: {},
    }] };
  } });
  const response = await controller.execute(input, signal.signal);
  assert.equal(response.status, 200);
  const result = await response.json() as ReturnType<typeof transcriptPageOutput>;
  assert.equal(result.rows.length, 1);
  assert.equal(result.scanned, 201);
  assert.deepEqual(result.rows[0]?.fields, [{ path: ["text"], value: "needle" }]);
  assert.equal(result.nextCommand, null);
  assert.equal(reads, 2);

  reads = 0;
  const cancelled = new WorkbenchTranscriptCommandController({ projectRoot: "C:/workbench", read: async () => {
    reads++; signal.abort(new Error("cancelled")); return empty;
  } });
  await assert.rejects(cancelled.execute(input, signal.signal), /cancelled/u);
  assert.equal(reads, 1);
});

test("invalid queries and stale cursors propagate as bounded failures, not empty success", async () => {
  const controller = new WorkbenchTranscriptCommandController({ projectRoot: "C:/workbench", read: async () => { throw new TranscriptQueryError("stale cursor"); } });
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
  const controller = new WorkbenchTranscriptCommandController({ projectRoot: "C:/workbench", read: async () => ({
    coverage, nextCursor: null, scanned: 1,
    rows: [{
      id: "item", kind: "commandExecution", threadId: "wb-id", turnId: "turn", projectId: "project",
      title: "title", createdAt: 1, counts: {}, fields,
    }],
  }) });
  for (const action of ["read", "show"]) {
    const request = { ...input, action, queries: [], json: false, ...(action === "show" ? { item: "item" } : {}) };
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
