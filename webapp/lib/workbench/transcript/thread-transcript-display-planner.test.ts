/*
 * No production exports. Tests protect canonical index order, adjacent-only grouping, empty-turn placement, segment ownership, and malformed-presentation refusal. Keywords: transcript, display, parity.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadItem } from "../../codex/generated/app-server/v2/ThreadItem";
import { planCanonicalTranscriptDisplay } from "./thread-transcript-display-planner";

function item(id: string): ThreadItem {
  return { type: "plan", id, text: id };
}

test("canonical display preserves global order and gives repeated turn segments stable ownership", () => {
  const plan = planCanonicalTranscriptDisplay({
    turns: [
      { turnId: "a", turnIndex: 0 },
      { turnId: "b", turnIndex: 1 },
    ],
    items: [
      { itemId: "a-2", itemIndex: 2, payload: item("a-2"), turnId: "a" },
      { itemId: "a-0", itemIndex: 0, payload: item("a-0"), turnId: "a" },
      { itemId: "b-1", itemIndex: 1, payload: item("b-1"), turnId: "b" },
    ],
    virtualTail: [{ payload: item("tail"), turnId: "a" }],
  });

  assert.deepEqual(plan.orderedItems.map(({ itemId }) => itemId), ["a-0", "b-1", "a-2"]);
  assert.deepEqual(plan.segments.map((segment) => ({
    first: segment.isFirstForTurn,
    id: segment.id,
    itemIds: segment.items.map(({ id }) => id),
    kind: segment.kind,
    last: segment.isLastForTurn,
    terminal: segment.ownsCanonicalTerminal,
    turnId: segment.turnId,
  })), [
    { first: true, id: "a:display:0", itemIds: ["a-0"], kind: "canonical", last: false, terminal: false, turnId: "a" },
    { first: true, id: "b:display:0", itemIds: ["b-1"], kind: "canonical", last: true, terminal: true, turnId: "b" },
    { first: false, id: "a:display:1", itemIds: ["a-2"], kind: "canonical", last: false, terminal: true, turnId: "a" },
    { first: false, id: "a:display:2", itemIds: ["tail"], kind: "virtual", last: true, terminal: false, turnId: "a" },
  ]);
});

test("canonical display places empty turns by turnIndex and before virtual tail", () => {
  const plan = planCanonicalTranscriptDisplay({
    turns: [
      { turnId: "empty-first", turnIndex: 0 },
      { turnId: "populated", turnIndex: 1 },
      { turnId: "empty-last", turnIndex: 2 },
    ],
    items: [{ itemId: "item", itemIndex: 0, payload: item("item"), turnId: "populated" }],
    virtualTail: [{ payload: item("tail"), turnId: "empty-first" }],
  });

  assert.deepEqual(plan.segments.map(({ items, kind, ownsCanonicalTerminal, turnId }) => ({
    itemIds: items.map(({ id }) => id),
    kind,
    ownsCanonicalTerminal,
    turnId,
  })), [
    { itemIds: [], kind: "canonical", ownsCanonicalTerminal: true, turnId: "empty-first" },
    { itemIds: ["item"], kind: "canonical", ownsCanonicalTerminal: true, turnId: "populated" },
    { itemIds: [], kind: "canonical", ownsCanonicalTerminal: true, turnId: "empty-last" },
    { itemIds: ["tail"], kind: "virtual", ownsCanonicalTerminal: false, turnId: "empty-first" },
  ]);
});

test("canonical display refuses duplicate identity, missing ancestry, and payload mismatch", () => {
  const turns = [{ turnId: "turn", turnIndex: 0 }];
  assert.throws(() => planCanonicalTranscriptDisplay({
    turns,
    items: [
      { itemId: "one", itemIndex: 0, payload: item("one"), turnId: "turn" },
      { itemId: "two", itemIndex: 0, payload: item("two"), turnId: "turn" },
    ],
  }), /repeats item index 0/u);
  assert.throws(() => planCanonicalTranscriptDisplay({
    turns,
    items: [{ itemId: "one", itemIndex: 0, payload: item("one"), turnId: "missing" }],
  }), /references missing turn missing/u);
  assert.throws(() => planCanonicalTranscriptDisplay({
    turns,
    items: [{ itemId: "one", itemIndex: 0, payload: item("other"), turnId: "turn" }],
  }), /payload id is other/u);
  assert.throws(() => planCanonicalTranscriptDisplay({
    turns,
    items: [{ itemId: "one", itemIndex: 0, payload: item("one"), turnId: "turn" }],
    virtualTail: [{ payload: item("one"), turnId: "turn" }],
  }), /repeats visible item id one/u);
});
