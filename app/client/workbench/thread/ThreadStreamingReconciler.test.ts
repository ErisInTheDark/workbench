/*
 * No production exports. Tests protect streaming reconciliation semantics.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import ThreadStreamingReconciler from "./ThreadStreamingReconciler.ts";

function message(id: string, text: string): Extract<ThreadItem, { type: "agentMessage" }> {
  return { delivery: null, id, memoryCitation: null, phase: "commentary", questions: null, text, type: "agentMessage" };
}

function reasoning(id: string, content: string[], summary: string[] = []): ThreadItem {
  return { content, id, summary, type: "reasoning" };
}

const keepIncoming = (incoming: ThreadItem) => incoming;

test("canonical identity wins in either order and replacement retains caller-merged content", () => {
  const live = message("live", "streamed longer text");
  const canonical = message("canonical", "streamed");
  for (const items of [[live, canonical], [canonical, live]]) {
    const reconciler = new ThreadStreamingReconciler();
    reconciler.addClientCreatedItemKey("turn:live");
    const merged = { ...canonical, text: live.text };
    const result = reconciler.pruneDuplicateItems("turn", items, (incoming, existing) => {
      assert.equal(incoming, canonical);
      assert.equal(existing, live);
      return merged;
    });
    assert.deepEqual(result, [items[0] === live ? merged : canonical]);
    assert.equal(reconciler.hasClientCreatedItemKey("turn:live"), false);
  }
});

test("reasoning dedupe respects canonical IDs, client provenance, and joined content/summary prefixes", () => {
  const canonical = reasoning("canonical", ["thinking"], ["next"]);
  const other = reasoning("other", ["thinking\nnext steps"]);
  const reconciler = new ThreadStreamingReconciler();
  const distinct = [canonical, other];
  assert.equal(reconciler.pruneDuplicateItems("turn", distinct, keepIncoming), distinct);

  reconciler.addClientCreatedItemKey("turn:other");
  assert.deepEqual(reconciler.pruneDuplicateItems("turn", distinct, keepIncoming), [canonical]);
  assert.equal(reconciler.hasClientCreatedItemForTurn("turn"), false);

  const sameId = [canonical, reasoning("canonical", ["thinking\nnext steps"])];
  assert.deepEqual(reconciler.pruneDuplicateItems("turn", sameId, keepIncoming), [sameId[1]]);
});

test("state changes require the same complete tag and opposite provenance", () => {
  const canonical = message("canonical", '<set-state mode="Inspect" />');
  const live = message("live", '  <set-state   mode="Inspect" />  ');
  const different = message("different", '<set-state mode="Implement" />');
  const incomplete = message("incomplete", '<set-state mode="Inspect"');
  const reconciler = new ThreadStreamingReconciler();
  const canonicalPair = [canonical, live];
  assert.equal(reconciler.pruneDuplicateItems("turn", canonicalPair, keepIncoming), canonicalPair);
  reconciler.addClientCreatedItemKey("turn:live");
  reconciler.addClientCreatedItemKey("turn:second-live");
  const clientPair = [live, message("second-live", canonical.text)];
  assert.equal(reconciler.pruneDuplicateItems("turn", clientPair, keepIncoming), clientPair);
  assert.deepEqual(reconciler.pruneDuplicateItems("turn", [live, different, incomplete, canonical], keepIncoming), [
    canonical, different, incomplete,
  ]);
  assert.equal(reconciler.isStructurallyMatchingItem(canonical, live), true);
  assert.equal(reconciler.isStructurallyMatchingItem(canonical, incomplete), false);
});

test("first compatible position survives replacements, empty candidates, and unrelated kinds", () => {
  const reconciler = new ThreadStreamingReconciler();
  const first = message("first", "alpha one");
  const second = message("second", "alpha two");
  const search: ThreadItem = { id: "search", query: "alpha", type: "webSearch", action: null, results: null };
  const prefix = message("prefix", "alpha");
  const empty = message("empty", " \n");
  const beta = message("beta", "beta");
  const longerBeta = message("longer-beta", "beta grows");
  const items = [first, search, second, prefix, empty, beta, longerBeta];
  assert.deepEqual(reconciler.pruneDuplicateItems("turn", items, keepIncoming), [
    first, search, second, longerBeta,
  ]);
  const unchanged = [first, search, second, message("gamma", "gamma")];
  assert.equal(reconciler.pruneDuplicateItems("turn", unchanged, keepIncoming), unchanged);
});

test("settlement is optional and affects later same-key candidates within the current pass", () => {
  for (const settleStreamingKeys of [true, false]) {
    const reconciler = new ThreadStreamingReconciler();
    reconciler.addClientCreatedItemKey("turn:live");
    const items = [
      reasoning("canonical", ["same"]),
      reasoning("live", ["same"]),
      reasoning("live", ["same"]),
    ];
    const result = reconciler.pruneDuplicateItems("turn", items, keepIncoming, { settleStreamingKeys });
    assert.deepEqual(result, settleStreamingKeys ? [items[0], items[2]] : [items[0]]);
    assert.equal(reconciler.hasClientCreatedItemKey("turn:live"), !settleStreamingKeys);
    reconciler.clearClientCreatedItemKeys();
    assert.equal(reconciler.hasClientCreatedItemForTurn("turn"), false);
  }
});

test("structural matching preserves whitespace prefixes, empty reasoning, and kind boundaries", () => {
  const reconciler = new ThreadStreamingReconciler();
  assert.equal(reconciler.isStructurallyMatchingItem(message("a", "one \n two"), message("b", "one two three")), true);
  assert.equal(reconciler.isStructurallyMatchingItem(reasoning("a", [" "], ["\n"]), reasoning("b", [], [])), true);
  assert.equal(reconciler.isStructurallyMatchingItem(message("a", ""), message("b", "later")), true);
  assert.equal(reconciler.isStructurallyMatchingItem(message("a", "one"), message("b", "two")), false);
  assert.equal(reconciler.isStructurallyMatchingItem(message("a", "same"), {
    id: "b", query: "same", type: "webSearch", action: null, results: null,
  }), false);
});
