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
const empty: HistoryPage = { coverage, rows: [], records: [], nextCursor: "next", older: false, newer: false, gaps: [], expired: [], search: null, turnNeighbours: null };
const noMaterialize = async () => {};
const access = {
  requireThreadProject: async () => {},
  resolveProjectId: async (cwd: string) => `project-of:${cwd}`,
};

function scopeHarness() {
  const projects: Array<string | null> = [];
  const controller = new WorkbenchTranscriptCommandController({
    ...access, materializeTurn: noMaterialize,
    read: async (read) => { projects.push(read.project); return empty; },
  });
  const search = async (extra: object) => await controller.execute({ ...query, threads: [], cwd: "C:/other", callerThreadId: "caller", ...extra }, new AbortController().signal);
  return { projects, search };
}

test("managed callers naming no threads read only their own project, from any folder", async () => {
  const { projects, search } = scopeHarness();
  assert.equal((await search({})).status, 200);
  assert.deepEqual(projects, ["project-of:C:/other"]);
});

test("named threads, all-projects and ordinary users are not narrowed to the caller's project", async () => {
  const { projects, search } = scopeHarness();
  for (const extra of [{ threads: ["wb-elsewhere"] }, { allProjects: true }, { callerThreadId: null }, { project: "chosen" }]) {
    assert.equal((await search(extra)).status, 200);
  }
  assert.deepEqual(projects, [null, null, null, "chosen"]);
});

test("a named thread Thread Recall would refuse is refused before reading", async () => {
  let reads = 0;
  const controller = new WorkbenchTranscriptCommandController({
    ...access, materializeTurn: noMaterialize,
    requireThreadProject: async () => { throw new Error("Project is not catalogued."); },
    read: async () => { reads++; return empty; },
  });
  const response = await controller.execute(input, new AbortController().signal);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /not catalogued/u);
  assert.equal(reads, 0);
});

test("continuation commands re-run without the injected project and keep all-projects", async () => {
  const { search } = scopeHarness();
  const scoped = await (await search({ json: false })).text();
  assert.match(scoped, /--cursor 'next'/u);
  assert.doesNotMatch(scoped, /--project/u);
  assert.match(await (await search({ json: false, allProjects: true })).text(), /--all-projects/u);
});

test("a search request reads history once and hands continuation to the caller instead of looping", async () => {
  let reads = 0;
  const signal = new AbortController();
  const controller = new WorkbenchTranscriptCommandController({ ...access, materializeTurn: noMaterialize, read: async () => {
    reads++;
    return empty;
  } });
  const response = await controller.execute(input, signal.signal);
  assert.equal(response.status, 200);
  const result = await response.json() as ReturnType<typeof transcriptPageOutput>;
  assert.equal(reads, 1);
  assert.equal(result.rows.length, 0);
  assert.match(result.nextCommand ?? "", /--cursor 'next'/u);

  const cancelled = new WorkbenchTranscriptCommandController({ ...access, materializeTurn: noMaterialize, read: async () => {
    signal.abort(new Error("cancelled")); return empty;
  } });
  await assert.rejects(cancelled.execute(input, signal.signal), /cancelled/u);
});

test("invalid queries and stale cursors propagate as bounded failures, not empty success", async () => {
  const controller = new WorkbenchTranscriptCommandController({
    ...access, materializeTurn: noMaterialize, read: async () => { throw new HistoryQueryError("stale cursor"); },
  });
  assert.equal((await controller.execute({ ...input, limit: -1 }, new AbortController().signal)).status, 400);
  const response = await controller.execute(input, new AbortController().signal);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /stale cursor/u);
});

test("a query error from another reload generation keeps its message", async () => {
  class OtherGenerationHistoryQueryError extends Error {
    override readonly name = "HistoryQueryError";
  }
  const controller = new WorkbenchTranscriptCommandController({
    ...access, materializeTurn: noMaterialize, read: async () => { throw new OtherGenerationHistoryQueryError("Unknown item"); },
  });
  const response = await controller.execute(input, new AbortController().signal);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Unknown item/u);
});

test("text rendering abbreviates matching caller directories without changing data or other paths", async () => {
  const fields = [
    { path: ["cwd"], value: "c:\\WORKBENCH\\" },
    { path: ["arguments", "cwd"], value: "C:/workbench/other" },
    { path: ["arguments", "file"], value: "C:/workbench" },
    { path: ["exitCode"], value: 0 },
    { path: ["success"], value: false },
  ];
  const controller = new WorkbenchTranscriptCommandController({ ...access, materializeTurn: noMaterialize, read: async () => ({
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
    ...access,
    materializeTurn: async (threadId, turnId) => { events.push(`materialize:${threadId}:${turnId}`); },
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
