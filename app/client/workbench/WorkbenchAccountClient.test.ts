/*
 * Exports:
 * - No production exports; Node tests protect provider model caching and watched rate-limit observations.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkbenchHarness, WorkbenchModelOption } from "workbench-shared/types";
import type {
  WorkbenchAccountLimits,
  WorkbenchRateLimitSnapshot,
} from "workbench-shared/workbench/provider/provider-account";
import WorkbenchAccountClient, { type WorkbenchAccountClientOptions } from "./WorkbenchAccountClient.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function model(id: string): WorkbenchModelOption {
  return {
    additionalSpeedTiers: [],
    billingMultiplier: null,
    defaultReasoningEffort: null,
    description: "",
    displayName: id,
    hidden: false,
    id,
    inputModalities: ["text"],
    isDefault: false,
    maxContextWindowTokens: null,
    policyState: null,
    supportedReasoningEfforts: [],
    supportsFastMode: false,
    supportsPersonality: false,
    supportsReasoningEffort: false,
    supportsVision: false,
  };
}

function rateLimits(limitName: string): WorkbenchAccountLimits {
  const snapshot: WorkbenchRateLimitSnapshot = {
    credits: null,
    individualLimit: null,
    limitId: "codex",
    limitName,
    planType: null,
    primary: null,
    rateLimitReachedType: null,
    secondary: null,
    spendControlReached: null,
  };
  return {
    preferredLimitId: null,
    rateLimits: snapshot,
    rateLimitsByLimitId: { codex: snapshot },
  };
}

const unusedLimits: WorkbenchAccountClientOptions["observeRateLimits"] = () => {
  throw new Error("Unexpected rate-limit observation.");
};

test("model reads reuse the owned cache until force refresh", async () => {
  const reads: WorkbenchModelOption[][] = [[model("first")], [model("second")]];
  let readCount = 0;
  const client = new WorkbenchAccountClient({
    listModels: async () => reads[readCount++]!,
    observeRateLimits: unusedLimits,
  });

  assert.equal((await client.listModels("codex"))[0]?.id, "first");
  assert.equal((await client.listModels("codex"))[0]?.id, "first");
  assert.equal(readCount, 1);
  assert.equal((await client.listModels("codex", { forceRefresh: true }))[0]?.id, "second");
  assert.equal(client.getSnapshot().modelsByHarness.get("codex")?.[0]?.id, "second");
});

test("model demand coalesces and a retired source response cannot replace the new cache", async () => {
  const old = deferred<WorkbenchModelOption[]>();
  let reads = 0;
  const client = new WorkbenchAccountClient({
    listModels: async () => ++reads === 1 ? old.promise : [model("new source")],
    observeRateLimits: unusedLimits,
  });
  try {
    const first = client.listModels("codex");
    const shared = client.listModels("codex");
    assert.equal(reads, 1);
    client.reset();
    const current = await client.listModels("codex");
    old.resolve([model("old source")]);
    assert.deepEqual(await first, current);
    assert.deepEqual(await shared, current);
    assert.deepEqual(client.getModels("codex"), current);
    assert.equal(reads, 2);
  } finally { client.dispose(); }
});

test("provider model invalidation retires an empty in-flight read without touching other providers", async () => {
  const old = deferred<WorkbenchModelOption[]>();
  let opencodeReads = 0;
  let codexReads = 0;
  const client = new WorkbenchAccountClient({
    listModels: async harness => harness === "opencode"
      ? ++opencodeReads === 1 ? old.promise : [model("ready")]
      : (++codexReads, [model("codex")]),
    observeRateLimits: unusedLimits,
  });
  try {
    await client.listModels("codex");
    const first = client.listModels("opencode");
    client.invalidateModels("opencode");
    assert.deepEqual(await client.listModels("opencode"), [model("ready")]);
    old.resolve([]);
    await first;
    assert.deepEqual(client.getModels("opencode"), [model("ready")]);
    assert.deepEqual(await client.listModels("codex"), [model("codex")]);
    assert.equal(codexReads, 1);
  } finally { client.dispose(); }
});

test("an invalidated model read without a replacement reports expected supersession", async () => {
  const pending = deferred<WorkbenchModelOption[]>();
  const client = new WorkbenchAccountClient({
    listModels: () => pending.promise,
    observeRateLimits: unusedLimits,
  });
  try {
    const old = client.listModels("opencode");
    client.invalidateModels("opencode");
    pending.resolve([]);
    await assert.rejects(old, { name: "WorkbenchModelReadSupersededError" });
  } finally { client.dispose(); }
});

test("watched providers hold one daemon observation each, keep the last limits through failures, and release on reset", () => {
  const observations: Array<{ harness: WorkbenchHarness; changed: () => void; released: boolean;
    fact: { failure: string | null; limits: WorkbenchAccountLimits | null } }> = [];
  const errors: string[] = [];
  let publishes = 0;
  const client = new WorkbenchAccountClient({
    listModels: async () => [],
    reportError: message => errors.push(message),
    observeRateLimits: (harness, changed) => {
      const observation = { harness, changed, released: false, fact: { failure: null, limits: null } as { failure: string | null; limits: WorkbenchAccountLimits | null } };
      observations.push(observation);
      return { getSnapshot: () => observation.fact, release: () => { observation.released = true; } };
    },
  });
  client.subscribe(() => { publishes += 1; });
  client.watchRateLimits("codex");
  client.watchRateLimits("codex");
  client.watchRateLimits("opencode");
  assert.equal(observations.length, 2, "watching again reuses the provider's observation");
  const [codex, opencode] = observations as [typeof observations[number], typeof observations[number]];

  codex.fact = { failure: null, limits: rateLimits("pushed") };
  codex.changed();
  assert.equal(client.getRateLimits("codex")?.limitName, "pushed");
  assert.equal(client.getRateLimits("opencode"), null, "providers are independent");
  assert.equal(publishes, 1);

  codex.fact = { failure: "temporarily unavailable", limits: rateLimits("pushed") };
  codex.changed();
  codex.changed();
  assert.equal(client.getRateLimits("codex")?.limitName, "pushed");
  assert.deepEqual(errors, ["Unable to refresh codex account limits: temporarily unavailable"], "a failure reports once");

  client.reset();
  assert.ok(codex.released && opencode.released);
  assert.equal(client.getRateLimits("codex"), null);
  codex.fact = { failure: null, limits: rateLimits("stale") };
  codex.changed();
  assert.equal(client.getRateLimits("codex"), null, "a retired observation cannot write after reset");

  client.watchRateLimits("codex");
  assert.equal(observations.length, 3);
  client.dispose();
  assert.ok(observations[2]!.released);
});
