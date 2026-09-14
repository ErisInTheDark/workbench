/* No exports. Keywords: stats, protocol compatibility, error propagation, regression tests. */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchDaemonClient, { WorkbenchDaemonRequestError } from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import WorkbenchStatsClient from "./WorkbenchStatsClient.ts";
import type { WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";

test("only method-not-found enables older reads, and reconnect retries cache efficiency", async () => {
  const calls: Array<{ method: string; params: object }> = [];
  const stats = { version: 2 } as WorkbenchStatsResponse;
  const daemon: Pick<WorkbenchDaemonClient, "request"> = {
    request: async (method, params) => {
      calls.push({ method, params });
      if (method !== "stats/read") throw new WorkbenchDaemonRequestError("Unavailable", -32601);
      return stats as never;
    },
  };
  const client = new WorkbenchStatsClient(daemon);
  const query = { projectId: null, range: "7d" as const, tokenTypes: ["output" as const] };
  await client.read(query);
  await client.read(query);
  assert.deepEqual(calls.map(({ method }) => method), ["stats/read/efficiency/v2", "stats/read/efficiency", "stats/read/detailed", "stats/read", "stats/read"]);
  assert.deepEqual(calls[3]?.params, { projectId: null, range: "7d" });
  client.reconnected();
  await client.read(query);
  assert.equal(calls[5]?.method, "stats/read/efficiency/v2");
});

test("older servers keep category selection and current servers need one read", async () => {
  const methods = ["stats/read/efficiency/v2", "stats/read/efficiency", "stats/read/detailed"];
  for (const [index, supported] of methods.entries()) {
    const calls: Array<{ method: string; params: object }> = [];
    const client = new WorkbenchStatsClient({ request: async (method, params) => {
      calls.push({ method, params });
      if (method !== supported) throw new WorkbenchDaemonRequestError("Unavailable", -32601);
      return { version: 2 } as never;
    } });
    const query = { projectId: null, range: "7d" as const, tokenTypes: ["cache" as const] };
    await client.read(query);
    await client.read(query);
    assert.deepEqual(calls.map(({ method }) => method), [...methods.slice(0, index + 1), supported]);
    for (const { params } of calls) assert.deepEqual(params, query);
  }
});

test("invalid data and server failures are never disguised as legacy compatibility", async () => {
  let calls = 0;
  const client = new WorkbenchStatsClient({ request: async () => {
    calls++;
    throw new WorkbenchDaemonRequestError("Read failed", -32000);
  } });
  await assert.rejects(client.read({ projectId: null, range: "7d" }), /Read failed/u);
  assert.equal(calls, 1);
});
