/* No exports. Protect stats compatibility negotiation and failure propagation. */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchDaemonClient, { WorkbenchDaemonRequestError } from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import WorkbenchStatsClient from "./WorkbenchStatsClient.ts";
import { WorkbenchStatsResponseSchema } from "workbench-shared/workbench/stats/workbench-stats-contract";

const stats = {
  ...WorkbenchStatsResponseSchema.parse({
    bucketUnit: "day", claimHotspots: [], cost: { buckets: [], pricedTokens: 0, totalUsd: 0, unpricedTokens: 0 },
    failures: [], generatedAt: 1, pricingCatalogDate: "2026-09-05", projectId: null, rateLimits: [],
    range: "7d", recordingStartedAt: null, startedAt: 0,
    tokens: { buckets: [], totals: { all: 0, cachedInput: 0, input: 0, output: 0 } },
  }),
};

test("only method-not-found enables older reads, and reconnect retries cache efficiency", async () => {
  const calls: Array<{ method: string; params: object }> = [];
  const daemon = new WorkbenchDaemonClient({
    request: async <TResponse>(method: string, params: object) => {
      calls.push({ method, params });
      if (method !== "stats/read") throw new WorkbenchDaemonRequestError("Unavailable", -32601);
      return stats as TResponse;
    },
  });
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
    const client = new WorkbenchStatsClient(new WorkbenchDaemonClient({ request: async <TResponse>(method: string, params: object) => {
      calls.push({ method, params });
      if (method !== supported) throw new WorkbenchDaemonRequestError("Unavailable", -32601);
      return { ...stats, cost: { ...stats.cost, byTokenType: { input: 0, cache: 0, output: 0 } } } as TResponse;
    } }));
    const query = { projectId: null, range: "7d" as const, tokenTypes: ["cache" as const] };
    await client.read(query);
    await client.read(query);
    assert.deepEqual(calls.map(({ method }) => method), [...methods.slice(0, index + 1), supported]);
    for (const { params } of calls) assert.deepEqual(params, query);
  }
});

test("invalid data and server failures are never disguised as legacy compatibility", async () => {
  let calls = 0;
  const client = new WorkbenchStatsClient(new WorkbenchDaemonClient({ request: async () => {
    calls++;
    throw new WorkbenchDaemonRequestError("Read failed", -32000);
  } }));
  await assert.rejects(client.read({ projectId: null, range: "7d" }), /Read failed/u);
  assert.equal(calls, 1);
});
