/*
 * No production exports. Wards protect capability admission, exact catalog scope, bounded pagination, selected-thread reads, and sanitized source responses. Keywords: migration, readonly, lazy, test.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
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
  assert.deepEqual(requests[0]?.params, { cwd, includeTurns: true, threadId: "selected" });
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

test("unloaded Codex snapshots remain static reads and never resume the thread", async () => {
  const requests: JsonRpcRequest[] = [];
  const source = new WorkbenchLegacyMigrationSourceController({
    allowedProjectIds: new Set(["project"]), capability: "enabled",
    requestHarness: async (_harness, request) => {
      requests.push(request);
      return { error: { code: -32600, message: "thread not loaded: selected" }, id: request.id ?? null };
    },
    resolveProjectFromCwd: async () => ({ cwd, project: { id: "project" } }),
  });
  await assert.rejects(source.execute(snapshotContext), (error) => (
    error instanceof LegacyMigrationSnapshotError
    && error.causeCode === "providerReadFailed"
    && error.terminal === false
  ));
  assert.deepEqual(requests.map((request) => request.method), ["thread/read"]);
  assert.deepEqual(requests[0]?.params, { cwd, includeTurns: true, threadId: "selected" });
});

test("read failure serializes a sanitized provider code and message", async () => {
  const source = new WorkbenchLegacyMigrationSourceController({
    allowedProjectIds: new Set(["project"]), capability: "enabled",
    requestHarness: async (_harness, request) => ({
      error: { code: -32001, data: { secret: "not-safe" }, message: `database unavailable at C:\\Users\\private\\state.db api_key=not-safe` },
      id: request.id ?? null,
    }),
    resolveProjectFromCwd: async () => ({ cwd, project: { id: "project" } }),
  });
  const request = Readable.from([JSON.stringify(snapshotContext)]) as http.IncomingMessage;
  request.method = "POST";
  request.headers = { "x-workbench-migration-capability": "enabled" };
  let status = 0;
  let body = "";
  const response = {
    end: (value: string) => { body = value; },
    writeHead: (value: number) => { status = value; },
  } as unknown as http.ServerResponse;
  await source.handleHttpRequest(request, response);
  assert.equal(status, 400);
  const result = JSON.parse(body) as { cause: string; context: { providerReason: { code: number; message: string } }; error: string };
  assert.equal(result.cause, "providerReadFailed");
  assert.deepEqual(result.context.providerReason, { code: -32001, message: "database unavailable at [path] api_key=[redacted]" });
  assert.match(result.error, /providerReasonCode=-32001 providerReason=database unavailable at \[path\] api_key=\[redacted\]/u);
  assert.doesNotMatch(body, /not-safe|C:\\Users|state\.db/u);
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
