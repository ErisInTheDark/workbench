/*
 * Exports:
 * - No production exports; Node tests cover BrowseMD command identity, help, and partial failures.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkbenchBrowseResultSink } from "./browse-result-events.ts";
import WorkbenchBrowseRequestHandler from "./WorkbenchBrowseRequestHandler.ts";

const results: WorkbenchBrowseResultSink = {
  captureOrigin: async () => null,
  deliverScreenshot: async () => ({ acceptedAt: Date.now(), kind: "injected", turnId: "turn" }),
  record: () => undefined,
  waitForIdle: async () => undefined,
};

function createHandler() {
  const cwd = process.cwd();
  const runtime = {
    resolveExecutionContext: async () => ({
      cwd,
      owningRootPath: cwd,
      projectId: null,
      projectRootPath: null,
      workspaceRoots: [{ id: "workbench", name: "workbench", rootPath: cwd }],
      workspaceRootPaths: [cwd],
    }),
  } as never;
  return new WorkbenchBrowseRequestHandler(
    results,
    runtime,
    { profileStore: {}, registry: {} } as never,
  );
}

test("keeps command-array identity and prior help output when a later command fails", async () => {
  const handler = createHandler();
  const response = await handler.handle(Buffer.from(JSON.stringify({
    commands: ["help viewport", "not-a-command"],
    cwd: process.cwd(),
    threadId: "thread-1",
  })), new AbortController().signal, async (task) => await task());
  const payload = await response.json() as {
    error: string;
    ok: boolean;
    stdout: string;
  };

  assert.equal(payload.ok, false);
  assert.match(payload.stdout, /viewport <width> <height>/u);
  assert.match(payload.error, /BrowseMD command 2, line 1/u);
  assert.match(payload.error, /Unsupported BrowseMD command/u);
});
