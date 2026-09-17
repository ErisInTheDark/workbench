/*
 * No production exports. Tests protect exact-field isolation, smooth bounded replay, canonical reconciliation, source reset, and disposal.
 */
import assert from "node:assert/strict";
import test from "node:test";

import ThreadTextPresentationController, {
  type ThreadTextPresentationKey,
} from "./ThreadTextPresentationController";

function key(source: "json" | "sqlite", itemId = "item"): ThreadTextPresentationKey {
  return {
    field: "agentMessageText",
    index: null,
    itemId,
    source: { kind: source, sourceKey: "codex:thread" },
    threadId: "thread",
    turnId: "turn",
  };
}

function harness(options: { reducedMotion?: boolean } = {}) {
  let scheduled: ((timestamp: number) => void) | null = null;
  let cancellations = 0;
  let timestamp = 0;
  const controller = new ThreadTextPresentationController({
    now: () => timestamp,
    reducedMotion: () => options.reducedMotion ?? false,
    scheduleFrame: (callback) => {
      scheduled = callback;
      return () => {
        cancellations += 1;
        scheduled = null;
      };
    },
  });
  return {
    advance(elapsedMs = 16) {
      const callback = scheduled;
      scheduled = null;
      timestamp += elapsedMs;
      callback?.(timestamp);
    },
    cancellations: () => cancellations,
    controller,
    drain() {
      while (scheduled) this.advance();
    },
    scheduled: () => scheduled !== null,
  };
}

test("ordered appends notify only the exact source-qualified field", () => {
  const testHarness = harness();
  const jsonKey = key("json");
  const sqliteKey = key("sqlite");
  let jsonChanges = 0;
  let sqliteChanges = 0;
  testHarness.controller.subscribe(jsonKey, "a", () => { jsonChanges += 1; });
  testHarness.controller.subscribe(sqliteKey, "a", () => { sqliteChanges += 1; });

  testHarness.controller.acceptDelta({ canonicalText: "ab", delta: "b", key: jsonKey });
  testHarness.controller.acceptDelta({ canonicalText: "abc", delta: "c", key: jsonKey });
  assert.equal(testHarness.controller.getSnapshot(jsonKey), "a");
  testHarness.advance();

  assert.notEqual(testHarness.controller.getSnapshot(jsonKey), "a");
  assert.equal(testHarness.controller.getSnapshot(sqliteKey), "a");
  testHarness.drain();
  assert.equal(testHarness.controller.getSnapshot(jsonKey), "abc");
  assert.equal(testHarness.controller.getSnapshot(sqliteKey), "a");
  assert.ok(jsonChanges > 0);
  assert.equal(sqliteChanges, 0);
});

test("simultaneous fields each make bounded playback progress", () => {
  const testHarness = harness();
  const jsonKey = key("json");
  const sqliteKey = key("sqlite");
  const delta = "x".repeat(200);
  testHarness.controller.subscribe(jsonKey, "", () => undefined);
  testHarness.controller.subscribe(sqliteKey, "", () => undefined);
  testHarness.controller.acceptDelta({ canonicalText: delta, delta, key: jsonKey });
  testHarness.controller.acceptDelta({ canonicalText: delta, delta, key: sqliteKey });

  testHarness.advance();

  const jsonLength = testHarness.controller.getSnapshot(jsonKey)?.length ?? 0;
  const sqliteLength = testHarness.controller.getSnapshot(sqliteKey)?.length ?? 0;
  assert.ok(jsonLength > 0 && jsonLength < delta.length);
  assert.ok(sqliteLength > 0 && sqliteLength < delta.length);
});

test("large backlogs preserve partial reveal but complete within one visual window", () => {
  const testHarness = harness();
  const field = key("json");
  const delta = "x".repeat(20_000);
  testHarness.controller.subscribe(field, "", () => undefined);
  testHarness.controller.acceptDelta({ canonicalText: delta, delta, key: field });

  testHarness.advance();
  const firstFrame = testHarness.controller.getSnapshot(field)?.length ?? 0;
  assert.ok(firstFrame > 0 && firstFrame < delta.length);
  for (let frame = 0; frame < 11; frame += 1) testHarness.advance();
  assert.equal(testHarness.controller.getSnapshot(field), delta);
});

test("late frames advance along elapsed presentation time instead of accumulating frame debt", () => {
  const testHarness = harness();
  const field = key("json");
  const delta = "x".repeat(20_000);
  testHarness.controller.subscribe(field, "", () => undefined);
  testHarness.controller.acceptDelta({ canonicalText: delta, delta, key: field });

  testHarness.advance(70);
  assert.ok((testHarness.controller.getSnapshot(field)?.length ?? 0) < delta.length);
  testHarness.advance(70);
  testHarness.advance(70);
  assert.equal(testHarness.controller.getSnapshot(field), delta);
});

test("frame starvation with many tiny deltas retains animated playback", () => {
  const testHarness = harness();
  const field = key("json");
  testHarness.controller.subscribe(field, "", () => undefined);
  let canonicalText = "";
  for (let index = 0; index < 1_000; index += 1) {
    canonicalText += "x";
    testHarness.controller.acceptDelta({ canonicalText, delta: "x", key: field });
  }

  assert.equal(testHarness.controller.getSnapshot(field), "");
  testHarness.advance();
  const firstFrame = testHarness.controller.getSnapshot(field) ?? "";
  assert.ok(firstFrame.length > 0);
  assert.ok(firstFrame.length < canonicalText.length);
  testHarness.drain();
  assert.equal(testHarness.controller.getSnapshot(field), canonicalText);
});

test("large backlogs catch up in bounded frame work without losing text", () => {
  const testHarness = harness();
  const field = key("json");
  testHarness.controller.subscribe(field, "", () => undefined);
  const delta = "x".repeat(20_000);
  testHarness.controller.acceptDelta({ canonicalText: delta, delta, key: field });

  testHarness.advance();
  const firstLength = testHarness.controller.getSnapshot(field)?.length ?? 0;
  assert.ok(firstLength > 0);
  assert.ok(firstLength < delta.length);
  testHarness.drain();
  assert.equal(testHarness.controller.getSnapshot(field), delta);
});

test("canonical mismatch and reduced motion fail closed to canonical text", () => {
  const mismatchHarness = harness();
  const field = key("json");
  mismatchHarness.controller.subscribe(field, "seed", () => undefined);
  mismatchHarness.controller.acceptDelta({ canonicalText: "replacement", delta: "x", key: field });
  assert.equal(mismatchHarness.controller.getSnapshot(field), "replacement");
  assert.equal(mismatchHarness.scheduled(), false);

  const reducedHarness = harness({ reducedMotion: true });
  reducedHarness.controller.subscribe(field, "seed", () => undefined);
  reducedHarness.controller.acceptDelta({ canonicalText: "seed plus", delta: " plus", key: field });
  assert.equal(reducedHarness.controller.getSnapshot(field), "seed plus");
  assert.equal(reducedHarness.scheduled(), false);
});

test("an inactive source retains current canonical text without scheduling replay", () => {
  const testHarness = harness();
  const sqliteKey = key("sqlite");
  testHarness.controller.acceptDelta({ canonicalText: "current", delta: "current", key: sqliteKey });

  assert.equal(testHarness.controller.getSnapshot(sqliteKey), "current");
  assert.equal(testHarness.scheduled(), false);
  testHarness.controller.subscribe(sqliteKey, "cur", () => undefined);
  assert.equal(testHarness.controller.getSnapshot(sqliteKey), "current");
});

test("completion drains an exact narrative backlog and snaps missing text or commands", () => {
  const testHarness = harness();
  const narrative = key("json", "narrative");
  const incompleteNarrative = key("json", "incomplete-narrative");
  const command: ThreadTextPresentationKey = {
    ...key("json", "command"),
    field: "commandExecutionOutput",
  };
  testHarness.controller.subscribe(narrative, "", () => undefined);
  testHarness.controller.subscribe(incompleteNarrative, "", () => undefined);
  testHarness.controller.subscribe(command, "", () => undefined);
  testHarness.controller.acceptDelta({ canonicalText: "narrative", delta: "narrative", key: narrative });
  testHarness.controller.acceptDelta({
    canonicalText: "partial",
    delta: "partial",
    key: incompleteNarrative,
  });
  testHarness.controller.acceptDelta({ canonicalText: "command", delta: "command", key: command });
  testHarness.controller.complete(narrative, "narrative");
  testHarness.controller.complete(incompleteNarrative, "partial completion");
  testHarness.controller.complete(command, "command", { snap: true });

  assert.equal(testHarness.controller.getSnapshot(narrative), "");
  assert.equal(testHarness.controller.getSnapshot(incompleteNarrative), "partial completion");
  assert.equal(testHarness.controller.getSnapshot(command), "command");
  testHarness.drain();
  assert.equal(testHarness.controller.getSnapshot(narrative), "narrative");
});

test("source reset and disposal cancel owned work and wake subscribed leaves", () => {
  const testHarness = harness();
  const field = key("json");
  let changes = 0;
  testHarness.controller.subscribe(field, "", () => { changes += 1; });
  testHarness.controller.acceptDelta({ canonicalText: "pending", delta: "pending", key: field });
  testHarness.controller.resetSource(field.source);
  assert.equal(testHarness.controller.getSnapshot(field), null);
  assert.equal(changes, 1);
  assert.equal(testHarness.cancellations(), 1);

  testHarness.controller.subscribe(field, "", () => { changes += 1; });
  testHarness.controller.acceptDelta({ canonicalText: "again", delta: "again", key: field });
  testHarness.controller.dispose();
  assert.equal(testHarness.cancellations(), 2);
  assert.equal(testHarness.controller.getSnapshot(field), null);
});
