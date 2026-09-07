/*
 * Keywords: claim CLI, cwd, path safety, reports.
 * No exports. Tests protect root ownership, historical paths, cancellation, and failure propagation.
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { AgentEndpointProjectResolution } from "../lib/workbench/project/agent-endpoint-project.ts";
import type { WorkbenchClaimStatsRequest } from "workbench-shared/workbench/stats/workbench-stats-claims-contract";
import WorkbenchClaimStatsController from "./WorkbenchClaimStatsController.ts";

const roots = ["primary", "secondary"].map((id) => ({ id, name: id, root: path.resolve(id), rootPath: path.resolve(id) }));
const resolution: AgentEndpointProjectResolution = {
  cwd: roots[1]!.root, root: roots[1]!,
  project: { id: "owned", kind: "workspace", root: roots[0]!.root, rootPath: roots[0]!.root, roots },
};
const signal = () => new AbortController().signal;

test("claim CLI derives project from cwd and accepts historical paths in the owning or qualified root", async () => {
  const reads: WorkbenchClaimStatsRequest[] = [];
  const controller = new WorkbenchClaimStatsController({
    resolveProjectFromCwd: async (cwd) => { assert.equal(cwd, resolution.cwd); return resolution; },
    read: async (request) => {
      reads.push(request);
      return { kind: "threads", page: 1, pages: 1, rows: [
        { threadId: "managed-id", title: "Useful title", harness: "codex", identity: "managed" },
      ] };
    },
  });
  for (const file of ["gone/file.ts", "primary:gone/file.ts"]) {
    const response = await controller.execute({ cwd: resolution.cwd, file, range: "all", page: 1 }, signal());
    assert.equal(response.status, 200);
    const output = await response.text();
    assert.ok(output.includes("managed-id") && output.includes("Useful title"));
  }
  assert.deepEqual(reads.map(({ projectId, file }) => ({ projectId, file })), [
    { projectId: "owned", file: { rootId: "secondary", path: "gone/file.ts" } },
    { projectId: "owned", file: { rootId: "primary", path: "gone/file.ts" } },
  ]);
});

test("unresolved claimants fail the scoped report without exposing native IDs", async () => {
  const controller = new WorkbenchClaimStatsController({
    resolveProjectFromCwd: async () => resolution,
    read: async () => ({ kind: "threads", page: 1, pages: 1, rows: [
      { threadId: "native-id", title: null, harness: "codex", identity: "provider" },
    ] }),
  });
  const response = await controller.execute({ cwd: resolution.cwd, file: "file", range: "all", page: 1 }, signal());
  assert.equal(response.status, 409);
  assert.equal((await response.text()).includes("native-id"), false);
});

test("invalid paths and cancellation never reach claim reads, and database failures propagate", async () => {
  let reads = 0;
  const controller = new WorkbenchClaimStatsController({
    resolveProjectFromCwd: async () => resolution,
    read: async () => { reads += 1; throw new Error("database failed"); },
  });
  const base = { cwd: resolution.cwd, range: "7d", page: 1 };
  assert.equal((await controller.execute({ ...base, file: "missing:x" }, signal())).status, 400);
  assert.equal((await controller.execute({ ...base, page: 0 }, signal())).status, 400);
  await assert.rejects(controller.execute({ ...base, file: "primary:../escape" }, signal()));
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(controller.execute(base, aborted.signal));
  assert.equal(reads, 0);
  await assert.rejects(controller.execute(base, signal()), /database failed/);
  assert.equal(reads, 1);
});
