/* No production exports. Tests protect shared GET/search behavior, validation, and cancellation for direct and Next Thread Recall adapters. */
import assert from "node:assert/strict";
import test from "node:test";

import type { WorkbenchThreadContextBundle } from "workbench-shared/types";
import WorkbenchThreadRecallController from "./WorkbenchThreadRecallController";

function bundle(): WorkbenchThreadContextBundle {
  return {
    browseResultEntries: [],
    questionnaireEntries: [],
    steerEntries: [],
    thread: {
      agentNickname: null,
      agentPath: null,
      agentRole: null,
      createdAt: 1,
      cwd: "C:/workspace",
      forkedFromId: null,
      harness: "codex",
      id: "thread-one",
      isDraft: false,
      model: "test-model",
      name: "Recall test",
      path: null,
      preview: "Recall",
      reasoningEffort: null,
      serviceTier: null,
      source: "appServer",
      status: "idle",
      tokenUsage: null,
      turnHistory: [],
      turns: [],
      updatedAt: 1,
    },
  };
}

test("serves the same bounded Markdown owner for history and search", async () => {
  const controller = new WorkbenchThreadRecallController({ readBundle: async () => bundle() });
  const signal = new AbortController().signal;
  const history = await controller.execute({
    method: "GET",
    searchParams: new URLSearchParams([["kind", "user-message"]]),
    threadId: "thread-one",
  }, signal);
  const search = await controller.execute({
    body: { action: "search", query: "missing" },
    method: "POST",
    searchParams: new URLSearchParams(),
    threadId: "thread-one",
  }, signal);

  assert.equal(history.status, 200);
  assert.equal(history.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.ok((await history.text()).length > 0);
  assert.equal(search.status, 200);
  assert.equal(search.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.ok((await search.text()).length > 0);
});

test("rejects invalid requests and preserves caller cancellation", async () => {
  let bundleReadCount = 0;
  const controller = new WorkbenchThreadRecallController({
    readBundle: async () => {
      bundleReadCount += 1;
      return bundle();
    },
  });
  const invalid = await controller.execute({
    body: { action: "search", query: "" },
    method: "POST",
    searchParams: new URLSearchParams(),
    threadId: "thread-one",
  }, new AbortController().signal);
  assert.equal(invalid.status, 400);
  assert.equal(bundleReadCount, 0);

  const cancellation = new AbortController();
  cancellation.abort(new Error("cancelled"));
  await assert.rejects(controller.execute({
    method: "GET",
    searchParams: new URLSearchParams(),
    threadId: "thread-one",
  }, cancellation.signal), /cancelled/u);
});
