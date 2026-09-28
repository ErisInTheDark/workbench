/*
 * Exports:
 * - No production exports; Node tests protect provider model caching and rate-limit lifecycle ownership.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkbenchHarness, WorkbenchModelOption } from "workbench-shared/types";
import type {
  WorkbenchAccountLimits,
  WorkbenchRateLimitSnapshot,
} from "workbench-shared/workbench/provider/provider-account";
import WorkbenchAccountClient from "./WorkbenchAccountClient.ts";
import { WorkbenchRpcRequestInterruptedError } from "workbench-shared/workbench/WorkbenchRpcSocketClient";

test("retired account reads ignore owned interruption but still report unexpected failure", async () => {
  for (const interruption of [true, false]) {
    const pending = Promise.withResolvers<WorkbenchAccountLimits>();
    const errors: string[] = [];
    const client = new WorkbenchAccountClient({
      listModels: async () => [], readRateLimits: () => pending.promise,
      reportError: message => { errors.push(message); },
    });
    const reading = client.refresh("codex");
    client.dispose();
    pending.reject(interruption ? new WorkbenchRpcRequestInterruptedError("disposed", true)
      : new Error("unexpected storage failure"));
    await reading;
    assert.equal(errors.length, interruption ? 0 : 1);
  }
});

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

test("model reads reuse the owned cache until force refresh", async () => {
  const reads: WorkbenchModelOption[][] = [[model("first")], [model("second")]];
  let readCount = 0;
  const client = new WorkbenchAccountClient({
    listModels: async () => reads[readCount++]!,
    readRateLimits: async () => rateLimits("unused"),
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
    readRateLimits: async () => rateLimits("unused"),
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
    readRateLimits: async () => rateLimits("unused"),
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
    readRateLimits: async () => rateLimits("unused"),
  });
  try {
    const old = client.listModels("opencode");
    client.invalidateModels("opencode");
    pending.resolve([]);
    await assert.rejects(old, { name: "WorkbenchModelReadSupersededError" });
  } finally { client.dispose(); }
});

test("automatic rate-limit reads coalesce and throttle while explicit reads remain fresh", async () => {
  let now = 1_000;
  const reads = [deferred<WorkbenchAccountLimits>(), deferred<WorkbenchAccountLimits>()];
  let readCount = 0;
  const client = new WorkbenchAccountClient({
    listModels: async () => [],
    now: () => now,
    readRateLimits: async () => reads[readCount++]!.promise,
  });

  const first = client.refreshIfStale("codex");
  const coalesced = client.refreshIfStale("codex");
  assert.equal(readCount, 1);
  reads[0]!.resolve(rateLimits("cached"));
  await Promise.all([first, coalesced]);

  now += 1_000;
  await client.refreshIfStale("codex");
  assert.equal(readCount, 1);
  const explicit = client.refresh("codex");
  assert.equal(readCount, 2);
  assert.equal(client.getRateLimits("codex")?.limitName, "cached");
  reads[1]!.resolve(rateLimits("explicit"));
  await explicit;
  assert.equal(client.getRateLimits("codex")?.limitName, "explicit");
});

test("notification refreshes replace the published rate-limit snapshot", async () => {
  const responses = [rateLimits("read"), rateLimits("notification")];
  let readCount = 0;
  let publishes = 0;
  const client = new WorkbenchAccountClient({
    listModels: async () => [],
    readRateLimits: async () => responses[readCount++]!,
  });
  client.subscribe(() => {
    publishes += 1;
  });

  await client.refresh("codex");
  const readSnapshot = client.getSnapshot();
  await client.refresh("codex", "notification");

  assert.equal(readSnapshot.rateLimitsByHarness.get("codex")?.limitName, "read");
  assert.equal(client.getSnapshot().rateLimitsByHarness.get("codex")?.limitName, "notification");
  assert.equal(publishes, 2);
});

test("independent harness refreshes cannot invalidate each other", async () => {
  const reads = new Map<WorkbenchHarness, ReturnType<typeof deferred<WorkbenchAccountLimits>>>([
    ["codex", deferred<WorkbenchAccountLimits>()],
    ["opencode", deferred<WorkbenchAccountLimits>()],
  ]);
  const client = new WorkbenchAccountClient({
    listModels: async () => [],
    readRateLimits: async harness => reads.get(harness)!.promise,
  });

  const codexRefresh = client.refresh("codex");
  const opencodeRefresh = client.refresh("opencode");
  reads.get("opencode")!.resolve(rateLimits("opencode"));
  await opencodeRefresh;
  reads.get("codex")!.resolve(rateLimits("codex"));
  await codexRefresh;

  assert.equal(client.getRateLimits("codex")?.limitName, "codex");
  assert.equal(client.getRateLimits("opencode")?.limitName, "opencode");
});

test("failed rate-limit refreshes retain the last known snapshot without publication", async () => {
  let shouldFail = false;
  let publishes = 0;
  const errors: string[] = [];
  const client = new WorkbenchAccountClient({
    listModels: async () => [],
    reportError: message => errors.push(message),
    readRateLimits: async () => {
      if (shouldFail) throw new Error("temporarily unavailable");
      return rateLimits("cached");
    },
  });
  client.subscribe(() => {
    publishes += 1;
  });

  await client.refresh("codex");
  shouldFail = true;
  await client.refresh("codex");

  assert.equal(client.getRateLimits("codex")?.limitName, "cached");
  assert.equal(publishes, 1);
  assert.deepEqual(errors, ["Unable to refresh codex account limits: temporarily unavailable"]);
});

test("reset rejects a late rate-limit result from the previous project context", async () => {
  const pending = deferred<WorkbenchAccountLimits>();
  const client = new WorkbenchAccountClient({
    listModels: async () => [],
    readRateLimits: async () => pending.promise,
  });

  const refresh = client.refresh("codex");
  client.reset();
  pending.resolve(rateLimits("stale"));
  await refresh;

  assert.equal(client.getRateLimits("codex"), null);
  assert.equal(client.getSnapshot().rateLimitsByHarness.size, 0);
});
