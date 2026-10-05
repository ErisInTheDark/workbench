/* Exports: none. Protect acknowledgement/completion ordering, native correlation and abort cleanup. */
import assert from "node:assert/strict";
import { test } from "node:test";
import ProviderCompactionCompletionController from "./ProviderCompactionCompletionController";

test("a request acknowledgement alone cannot release compaction, nor can an unrelated turn", async () => {
  const owner = new ProviderCompactionCompletionController();
  let finished = false;
  const ack = Promise.withResolvers<void>();
  const work = owner.run("thread", new AbortController().signal, async () => { ack.resolve(); })
    .then(() => { finished = true; });
  await ack.promise;
  owner.started("thread", "compact-turn");
  owner.completed("thread", "old-turn");
  owner.settled("thread", "old-turn");
  await Promise.resolve();
  assert.equal(finished, false);
  owner.completed("thread", "compact-turn");
  await Promise.resolve();
  assert.equal(finished, false);
  owner.settled("thread", "compact-turn");
  await work;
  assert.equal(finished, true);
});

test("native completion before acknowledgement still waits for both, and cleans up for reuse", async () => {
  const owner = new ProviderCompactionCompletionController();
  const ack = Promise.withResolvers<void>();
  let finished = false;
  const work = owner.run("thread", new AbortController().signal, () => ack.promise).then(() => { finished = true; });
  owner.started("thread", "turn");
  owner.completed("thread", "turn");
  owner.settled("thread", "turn");
  await Promise.resolve();
  assert.equal(finished, false);
  ack.resolve();
  await work;
  const next = owner.run("thread", new AbortController().signal, async () => {});
  owner.started("thread", "next");
  owner.completed("thread", "next");
  owner.settled("thread", "next");
  await next;
});

test("failure, request rejection and retirement reject waiting work without retaining its thread", async () => {
  const owner = new ProviderCompactionCompletionController();
  const signal = new AbortController();
  const failed = owner.run("thread", signal.signal, async () => {});
  const rejected = assert.rejects(failed, /native failure/);
  owner.failed("thread", new Error("native failure"));
  await rejected;
  await assert.rejects(owner.run("thread", signal.signal, async () => { throw new Error("request failed"); }), /request failed/);
  const cancelled = owner.run("thread", signal.signal, async () => {});
  const cancellation = assert.rejects(cancelled, /retired/);
  signal.abort(new Error("retired"));
  await cancellation;
});
