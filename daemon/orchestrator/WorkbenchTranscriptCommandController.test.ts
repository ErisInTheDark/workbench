/*
 * Keywords: transcript, command, cancellation, pagination, CLI.
 * Exports: none. Tests protect access, scan ownership and actionable results.
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
      createdAt: 1, fields: [{ name: "text", text: "needle", offset: 0, length: 6 }], counts: {},
    }] };
  } });
  const response = await controller.execute(input, signal.signal);
  assert.equal(response.status, 200);
  const result = await response.json() as ReturnType<typeof transcriptPageOutput>;
  assert.equal(result.rows.length, 1);
  assert.equal(result.scanned, 201);
  assert.match(result.rows[0].showCommand, /--thread 'wb-id' --item 'item'/u);
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
