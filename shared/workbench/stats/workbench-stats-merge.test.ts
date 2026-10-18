/* No production exports. Protect cross-machine stats merging: bucket alignment, logical project grouping, per-account limit histories, root-agnostic claims, attached-daemon tool prices, and thread re-indexing. */
import assert from "node:assert/strict";
import test from "node:test";

import { EMPTY_WORKBENCH_STATS_SECTIONS as EMPTY } from "./workbench-stats-conformance.ts";
import { WORKBENCH_STATS_MAX_LIMIT_SAMPLES, type WorkbenchStatsSectionData } from "./workbench-stats-contract.ts";
import { mergeStatsSections, type StatsMergeContext, type StatsMergeSource } from "./workbench-stats-merge.ts";

// "here" and "there" hold the same repository under different physical ids and root names.
const context: StatsMergeContext = {
  logicalProject: (daemonId, projectId) => projectId === "wb" || projectId === "workbench" ? "logical-wb" : null,
  isWorkspace: () => false,
};
const source = <Data>(daemonId: string, data: Data, attached = false): StatsMergeSource<Data> => ({ attached, daemonId, data, hostname: daemonId });
const merge = <Name extends keyof typeof EMPTY>(sources: StatsMergeSource<WorkbenchStatsSectionData<Name>>[]) =>
  mergeStatsSections(sources as StatsMergeSource[], context) as WorkbenchStatsSectionData<Name>;

const tokens = (all: number) => ({ all, cachedInput: 0, cacheWriteInput: 0, input: all, output: 0, uncachedInput: all });
const share = (tokens: number) => ({ costUsd: tokens / 1000, threadCount: 1, tokens, unpricedTokens: 0 });
const usage = (startedAt: number[], perBucket: number, projectId: string, thread: string): WorkbenchStatsSectionData<"usage"> => ({
  ...EMPTY.usage,
  tokens: { buckets: startedAt.map((at) => ({ ...tokens(perBucket), startedAt: at })), totals: tokens(perBucket * startedAt.length) },
  projects: [{ ...share(perBucket * startedAt.length), daemonId: null, logicalProjectId: null, projectId }],
  topThreads: [{
    costUsd: 0, harness: "codex", daemonId: null, modelShares: [], models: [], projectId, providers: ["codex"],
    sharePercent: 100, threadId: thread, title: thread, tokens: perBucket * startedAt.length, unpricedTokens: 0,
  }],
});

test("usage sums aligned buckets, groups one repository's machines as one project, and re-ranks threads by their merged share", () => {
  const merged = merge<"usage">([source("here", usage([1, 2], 10, "workbench", "a"), true), source("there", usage([2, 3], 30, "wb", "b"))]);
  // The attached daemon frames the window; the other daemon's bucket 3 has no slot.
  assert.deepEqual(merged.tokens.buckets.map(({ all, startedAt }) => [startedAt, all]), [[1, 10], [2, 40]]);
  assert.equal(merged.tokens.totals.all, 80);
  assert.deepEqual(merged.projects.map(({ logicalProjectId, tokens: total }) => [logicalProjectId, total]), [["logical-wb", 80]]);
  assert.deepEqual(merged.topThreads.map(({ daemonId, sharePercent, threadId }) => [threadId, daemonId, sharePercent]), [["b", "there", 75], ["a", "here", 25]]);
});

const limit = (key: string | null, ...observedAt: number[]) => ({
  account: key ? { key, label: null } : null, harness: "codex", limitId: "codex", limitName: null,
  samples: observedAt.map((at) => ({ observedAt: at, primary: null, secondary: null, tertiary: null })),
});
const times = (merged: WorkbenchStatsSectionData<"limits">) => merged.rateLimits.map(({ account, samples }) => [account?.key ?? null, samples.map(({ observedAt }) => observedAt)]);

test("one account seen from two machines is one history; different accounts never replace each other", () => {
  const merged = merge<"limits">([
    source("here", { ...EMPTY.limits, rateLimits: [limit("personal", 1, 5), limit("work", 2)] }, true),
    source("there", { ...EMPTY.limits, rateLimits: [limit("personal", 3, 5, 9)] }),
  ]);
  assert.deepEqual(times(merged), [["personal", [1, 3, 5, 9]], ["work", [2]]]);
});

test("limits with no known account stay with the machine that read them", () => {
  const merged = merge<"limits">([
    source("here", { ...EMPTY.limits, rateLimits: [limit(null, 5)] }, true),
    source("there", { ...EMPTY.limits, rateLimits: [limit(null, 9)] }),
  ]);
  assert.deepEqual(times(merged), [[null, [5]], [null, [9]]]);
});

test("a merged history thins evenly to the most one limit may carry, keeping its newest reading", () => {
  const many = (offset: number) => Array.from({ length: WORKBENCH_STATS_MAX_LIMIT_SAMPLES }, (_, index) => index * 2 + offset);
  const merged = merge<"limits">([
    source("here", { ...EMPTY.limits, rateLimits: [limit("personal", ...many(0))] }, true),
    source("there", { ...EMPTY.limits, rateLimits: [limit("personal", ...many(1))] }),
  ]);
  const samples = merged.rateLimits[0]!.samples;
  assert.ok(samples.length <= WORKBENCH_STATS_MAX_LIMIT_SAMPLES);
  assert.ok(samples.length > WORKBENCH_STATS_MAX_LIMIT_SAMPLES * 0.9);
  assert.equal(samples.at(-1)!.observedAt, WORKBENCH_STATS_MAX_LIMIT_SAMPLES * 2 - 1);
});

test("claims on one repository merge by path across machines with different root ids, linking to the attached copy", () => {
  const hotspot = (projectId: string, rootId: string, threadCount: number) => ({
    daemonId: null, logicalProjectId: null, path: "src/a.ts", projectId, rootId, threadCount,
    threads: [{ daemonId: null, harness: null, threadId: null, title: null, tokens: threadCount }],
  });
  const merged = merge<"claims">([
    source("there", { ...EMPTY.claims, claimHotspots: [hotspot("wb", "wb", 3)] }),
    source("here", { ...EMPTY.claims, claimHotspots: [hotspot("workbench", "workbench", 2)] }, true),
  ]);
  assert.equal(merged.claimHotspots.length, 1);
  assert.deepEqual(
    [merged.claimHotspots[0]!.daemonId, merged.claimHotspots[0]!.rootId, merged.claimHotspots[0]!.threadCount, merged.claimHotspots[0]!.threads.length],
    ["here", "workbench", 5, 2],
  );
});

test("tools price every tool from the attached catalogue and keep each period's callers pointing at the right threads", () => {
  const tools = (calls: number, spec: number, thread: string): WorkbenchStatsSectionData<"tools"> => ({
    ...EMPTY.tools,
    tools: {
      bucketStarts: [1], catalogue: { docsTokens: 0, specTokens: spec, tools: 1 }, threadCount: 1,
      threads: [{ daemonId: null, harness: "codex", projectId: "p", threadId: thread, title: thread }],
      workbench: [{ buckets: [calls], bucketThreads: [[{ calls, thread: 0 }]], calls, docsTokens: 0, failed: 0, specTokens: spec, threads: 1, tool: "rg" }],
    },
  });
  const merged = merge<"tools">([source("there", tools(5, 999, "far")), source("here", tools(2, 100, "near"), true)]).tools;
  const rg = merged.workbench[0]!;
  assert.deepEqual([rg.calls, rg.threads, rg.specTokens, merged.threadCount, merged.catalogue?.specTokens], [7, 2, 100, 2, 100]);
  assert.deepEqual(rg.bucketThreads[0]!.map(({ calls, thread }) => [calls, merged.threads[thread]!.threadId, merged.threads[thread]!.daemonId]), [
    [5, "far", "there"], [2, "near", "here"],
  ]);
});

test("feedback merges open reports by importance and resolved ones by latest resolution, naming the daemon each id belongs to", () => {
  const item = (id: number, importance: number, resolvedAt: number | null = null) => ({
    category: "bug" as const, channel: "wb" as const, createdAt: 1, daemonId: null, harness: null, id, importance,
    model: null, owned: false, projectId: "p", reasoningEffort: null, report: "r", resolvedAt, scored: true, threadId: null,
    title: "Stats action fails",
  });
  const feedback = (items: ReturnType<typeof item>[], resolved: ReturnType<typeof item>[] = []) => ({
    ...EMPTY.feedback,
    feedback: {
      counts: [{ category: "bug" as const, count: items.length }],
      items,
      ownership: [],
      resolved,
      total: items.length,
      workbenchProjectId: null,
    },
  });
  const merged = merge<"feedback">([
    source("here", feedback([item(1, 0.2)], [item(2, 0.9, 10)]), true),
    source("there", feedback([item(1, 0.9)], [item(2, 0.1, 20)])),
  ]).feedback;
  assert.deepEqual(merged.items.map(({ daemonId, id }) => [daemonId, id]), [["there", 1], ["here", 1]]);
  assert.deepEqual(merged.resolved.map(({ daemonId, id }) => [daemonId, id]), [["there", 2], ["here", 2]]);
  assert.deepEqual([merged.total, merged.counts], [2, [{ category: "bug", count: 2 }]]);
});

test("feedback ownership follows source daemon and id across machines", () => {
  const item = (title: string) => ({
    category: "bug" as const, channel: "wb" as const, createdAt: 1, daemonId: null, harness: null, id: 7, importance: 0.5,
    model: null, owned: false, projectId: "p", reasoningEffort: null, report: "r", resolvedAt: null, scored: true, threadId: null, title,
  });
  const feedback = (row: ReturnType<typeof item>, ownership: Array<{ daemonId: string; id: number }> = []) => ({
    ...EMPTY.feedback,
    feedback: { counts: [{ category: "bug" as const, count: 1 }], items: [row], ownership, resolved: [], total: 1, workbenchProjectId: null },
  });
  const merged = merge<"feedback">([
    source("here", feedback(item("Here"))),
    source("there", feedback(item("There"), [{ daemonId: "here", id: 7 }])),
  ]).feedback;
  assert.deepEqual(merged.items.map(({ daemonId, owned }) => [daemonId, owned]), [["here", true], ["there", false]]);
});
