/*
 * No production exports. Wards protect capability admission, exact catalog scope, bounded pagination, selected-thread reads, and sanitized source responses. Keywords: migration, readonly, lazy, test.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import WorkbenchLegacyMigrationSourceController, { LegacyMigrationSnapshotError, readLegacyMigrationSourceConfig } from "./WorkbenchLegacyMigrationSourceController";
import type { JsonRpcRequest } from "./bridge-types";

const cwd = "C:/allowed/project";
const snapshotContext = { bindingState: "bound", correlationId: "threadImportJobs:42", cwd, harness: "codex", operation: "threadSnapshot", projectId: "project", providerThreadId: "selected", sourceKind: "legacy", workbenchThreadId: "workbench-uuid" };

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

test("runtime config admits the exact web/workbench project and capability", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "primary-legacy-source-config-"));
  const runtime = path.join(root, ".workbench", "runtime");
  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(runtime, "legacy-migration-source.json"), JSON.stringify({ allowedProjectIds: ["web/workbench"], capability: "primary-source-capability" }));
  const config = readLegacyMigrationSourceConfig(root);
  assert.equal(config.capability, "primary-source-capability");
  assert.deepEqual([...config.allowedProjectIds], ["web/workbench"]);
});

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
  const result = await source.execute(snapshotContext);
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

test("excluded selected scope is typed terminal with safe context and zero provider dispatch", async () => {
  let dispatches = 0;
  const source = new WorkbenchLegacyMigrationSourceController({
    allowedProjectIds: new Set(["web/workbench"]), capability: "enabled",
    requestHarness: async () => { dispatches += 1; return { id: null, result: {} }; },
    resolveProjectFromCwd: async () => ({ cwd, project: { id: "excluded/project" } }),
  });
  await assert.rejects(source.execute({ ...snapshotContext, projectId: "excluded/project" }), (error) => error instanceof LegacyMigrationSnapshotError
    && error.causeCode === "scopeNotAllowlisted"
    && error.terminal
    && error.context.providerThreadId === "selected"
    && error.context.workbenchThreadId === "workbench-uuid"
    && error.context.correlationId === "threadImportJobs:42");
  assert.equal(dispatches, 0);
});

test("admitted unloaded Codex session resumes once then rereads once", async () => {
  const requests: JsonRpcRequest[] = [];
  let reads = 0;
  const source = new WorkbenchLegacyMigrationSourceController({
    allowedProjectIds: new Set(["project"]), capability: "enabled",
    requestHarness: async (_harness, request) => {
      requests.push(request);
      if (request.method === "thread/resume") return { id: request.id ?? null, result: { thread: { cwd, id: "selected", turns: [] } } };
      reads += 1;
      return reads === 1
        ? { error: { code: -32600, message: "thread not loaded: selected" }, id: request.id ?? null }
        : { id: request.id ?? null, result: { thread: { cwd, id: "selected", turns: [] } } };
    },
    resolveProjectFromCwd: async () => ({ cwd, project: { id: "project" } }),
  });
  await source.execute(snapshotContext);
  assert.deepEqual(requests.map((request) => request.method), ["thread/read", "thread/resume", "thread/read"]);
  assert.deepEqual(requests[1]?.params, { cwd, projectId: "project", threadId: "selected" });
});

test("active thread exclusion and single-flight admission happen before extra provider dispatch", async () => {
  const requests: JsonRpcRequest[] = [];
  const source = controller(requests);
  await assert.rejects(source.execute({ ...snapshotContext, providerThreadId: "019f6334-e16e-79c0-9638-0669cf8b7db2" }), /active Workbench thread/u);
  assert.equal(requests.length, 0);

  let release!: () => void;
  const blocking = new WorkbenchLegacyMigrationSourceController({
    allowedProjectIds: new Set(["project"]),
    capability: "enabled",
    requestHarness: async () => await new Promise((resolve) => { release = () => resolve({ id: null, result: { thread: { cwd, id: "one", turns: [] } } }); }),
    resolveProjectFromCwd: async () => ({ cwd, project: { id: "project" } }),
  });
  const first = blocking.execute({ ...snapshotContext, providerThreadId: "one" });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(blocking.execute({ cwd, harness: "codex", operation: "catalogPage", projectId: "project" }), /already active/u);
  release();
  await first;
});
