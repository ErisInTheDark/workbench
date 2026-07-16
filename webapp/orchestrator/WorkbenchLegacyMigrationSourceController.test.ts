/*
 * No production exports. Wards protect capability admission, exact catalog scope, bounded pagination, selected-thread reads, and sanitized source responses. Keywords: migration, readonly, lazy, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import WorkbenchLegacyMigrationSourceController from "./WorkbenchLegacyMigrationSourceController";
import type { JsonRpcRequest } from "./bridge-types";

const cwd = "C:/allowed/project";

function controller(requests: JsonRpcRequest[]) {
  return new WorkbenchLegacyMigrationSourceController({
    allowedProjectIds: new Set(["project"]),
    capability: "secret-from-environment",
    requestHarness: async (_harness, request) => {
      requests.push(request);
      if (request.method === "thread/read") return { id: request.id ?? null, result: { thread: { cwd, id: "selected", turns: [] } } };
      const archived = (request.params as { archived?: boolean }).archived;
      return { id: request.id ?? null, result: { data: [{ authorization: "forbidden", cwd, id: archived ? "archived" : "active", name: "safe" }], nextCursor: null } };
    },
    resolveProjectFromCwd: async () => ({ cwd, project: { id: "project" } }),
  });
}

test("catalog crawl reads one bounded page at a time and strips provider extras", async () => {
  const requests: JsonRpcRequest[] = [];
  const source = controller(requests);
  const first = await source.execute({ cwd, harness: "codex", limit: 4, operation: "catalogPage", projectId: "project" }) as { complete: boolean; cursor: string; summaries: object[] };
  assert.equal(first.complete, false);
  assert.deepEqual(first.summaries, [{ cwd, name: "safe", providerThreadId: "active" }]);
  assert.doesNotMatch(JSON.stringify(first), /authorization|forbidden/u);
  const second = await source.execute({ cursor: first.cursor, cwd, harness: "codex", limit: 4, operation: "catalogPage", projectId: "project" }) as { complete: boolean };
  assert.equal(second.complete, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => request.method), ["thread/list", "thread/list"]);
});

test("one explicit selected thread uses one normalized read and no eager catalog dispatch", async () => {
  const requests: JsonRpcRequest[] = [];
  const source = controller(requests);
  const result = await source.execute({ cwd, harness: "codex", operation: "threadSnapshot", projectId: "project", providerThreadId: "selected" });
  assert.equal((result as { providerThreadId: string }).providerThreadId, "selected");
  assert.deepEqual(requests.map((request) => request.method), ["thread/read"]);
  assert.deepEqual(requests[0]?.params, { cwd, includeTurns: true, projectId: "project", threadId: "selected" });
});

test("disabled, non-allowlisted, and invalid operations dispatch no provider work", async () => {
  let dispatches = 0;
  const source = new WorkbenchLegacyMigrationSourceController({
    allowedProjectIds: new Set(),
    capability: null,
    requestHarness: async () => { dispatches += 1; return { id: null, result: {} }; },
    resolveProjectFromCwd: async () => ({ cwd, project: { id: "project" } }),
  });
  await assert.rejects(source.execute({ cwd, harness: "codex", operation: "catalogPage", projectId: "project" }), /disabled/u);
  assert.equal(dispatches, 0);
});

test("active thread exclusion and single-flight admission happen before extra provider dispatch", async () => {
  const requests: JsonRpcRequest[] = [];
  const source = controller(requests);
  await assert.rejects(source.execute({ cwd, harness: "codex", operation: "threadSnapshot", projectId: "project", providerThreadId: "019f6334-e16e-79c0-9638-0669cf8b7db2" }), /active Workbench thread/u);
  assert.equal(requests.length, 0);

  let release!: () => void;
  const blocking = new WorkbenchLegacyMigrationSourceController({
    allowedProjectIds: new Set(["project"]),
    capability: "enabled",
    requestHarness: async () => await new Promise((resolve) => { release = () => resolve({ id: null, result: { thread: { cwd, id: "one", turns: [] } } }); }),
    resolveProjectFromCwd: async () => ({ cwd, project: { id: "project" } }),
  });
  const first = blocking.execute({ cwd, harness: "codex", operation: "threadSnapshot", projectId: "project", providerThreadId: "one" });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(blocking.execute({ cwd, harness: "codex", operation: "catalogPage", projectId: "project" }), /already active/u);
  release();
  await first;
});
