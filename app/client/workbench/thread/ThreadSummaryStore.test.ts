/*
 * Exports:
 * - No production exports; tests protect lease batching into one retargeted observation and per-thread notification.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkspaceThreadSummary } from "workbench-shared/workbench/workspace/workspace-observation";
import ThreadSummaryStore from "./ThreadSummaryStore";

const tick = () => Promise.resolve();

function workspace() {
  const calls: string[] = [];
  let data: Record<string, WorkspaceThreadSummary | null> = {};
  let notify = () => {};
  const store = new ThreadSummaryStore({
    observe: (query, listener) => {
      calls.push(`observe ${query.threadIds.join(",")}`);
      notify = listener;
      return {
        getSnapshot: () => ({ phase: "current", failure: null, value: { data } as never }),
        retarget: next => { calls.push(`retarget ${next.threadIds.join(",")}`); },
        release: () => { calls.push("release"); },
        signal: new AbortController().signal,
        subscribe: () => () => {},
      };
    },
  });
  return { store, calls, publish(next: typeof data) { data = next; notify(); } };
}

const summary = (title: string) => ({ summary: { row: { title } } }) as unknown as WorkspaceThreadSummary;

test("leases in one task share one observation that retargets as they move and releases with the last", async () => {
  const w = workspace();
  const releaseA = w.store.subscribe("a", () => {});
  const releaseB = w.store.subscribe("b", () => {});
  const releaseAgain = w.store.subscribe("a", () => {});
  await tick();
  assert.deepEqual(w.calls, ["observe a,b"]);
  releaseA();
  await tick();
  assert.deepEqual(w.calls, ["observe a,b"], "a still has a lease");
  releaseB();
  await tick();
  assert.deepEqual(w.calls, ["observe a,b", "retarget a"]);
  releaseAgain();
  await tick();
  assert.deepEqual(w.calls, ["observe a,b", "retarget a", "release"]);
});

test("a published batch notifies only threads whose summary changed", async () => {
  const w = workspace();
  const notified: string[] = [];
  w.store.subscribe("a", () => notified.push("a"));
  w.store.subscribe("b", () => notified.push("b"));
  await tick();
  const first = summary("first");
  w.publish({ a: first });
  assert.deepEqual(notified, ["a"]);
  assert.equal(w.store.get("a"), first);
  w.publish({ a: first, b: null });
  assert.deepEqual(notified, ["a", "b"], "an unchanged summary keeps its listeners quiet");
});
