/* No production exports. Protect history read coalescing: a burst costs one read plus one trailing read covering every request. */
import assert from "node:assert/strict";
import { test } from "node:test";
import ThreadHistoryReads from "./ThreadHistoryReads.ts";

function deferredRead() {
  const calls: Array<string[] | null> = [];
  const releases: Array<() => void> = [];
  const read = (turnIds: string[] | null) => {
    calls.push(turnIds);
    return new Promise<void>(resolve => releases.push(resolve));
  };
  return { calls, read, release: (index: number) => releases[index]!() };
}

test("a burst during a read folds into one trailing read with every requested turn", async () => {
  const reads = new ThreadHistoryReads();
  const { calls, read, release } = deferredRead();
  const first = reads.request("thread", ["a"], read);
  const burst = [reads.request("thread", ["b"], read), reads.request("thread", ["c", "b"], read)];
  assert.deepEqual(calls, [["a"]]);
  release(0);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [["a"], ["b", "c"]]);
  release(1);
  await Promise.all([first, ...burst]);
  assert.equal(calls.length, 2);
});

test("a whole-thread request widens the trailing read, and other keys read independently", async () => {
  const reads = new ThreadHistoryReads();
  const { calls, read, release } = deferredRead();
  const first = reads.request("thread", ["a"], read);
  const whole = reads.request("thread", null, read);
  const scoped = reads.request("thread", ["b"], read);
  const other = reads.request("other", ["z"], read);
  assert.deepEqual(calls, [["a"], ["z"]]);
  release(0);
  release(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls[2], null);
  release(2);
  await Promise.all([first, whole, scoped, other]);
  assert.equal(calls.length, 3);
});

test("a failed read reaches its waiters and frees the key", async () => {
  const reads = new ThreadHistoryReads();
  await assert.rejects(reads.request("thread", null, async () => { throw new Error("offline"); }), /offline/u);
  let read = false;
  await reads.request("thread", null, async () => { read = true; });
  assert.equal(read, true);
});
