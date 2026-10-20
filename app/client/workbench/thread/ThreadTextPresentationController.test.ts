/*
 * No production exports. Tests protect exact-field isolation, delta-shape-independent token pacing, canonical reconciliation, source reset, and disposal.
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
    /** Run frames for a span of presentation time. */
    play(durationMs: number) {
      for (let elapsed = 0; elapsed < durationMs; elapsed += 16) this.advance();
    },
    cancellations: () => cancellations,
    controller,
    drain() {
      while (scheduled) this.advance();
    },
    scheduled: () => scheduled !== null,
    wait(elapsedMs: number) {
      timestamp += elapsedMs;
    },
  };
}

const WORDS = "word ".repeat(100);

test("ordered appends notify only the exact source-qualified field", () => {
  const testHarness = harness();
  const jsonKey = key("json");
  const sqliteKey = key("sqlite");
  let jsonChanges = 0;
  let sqliteChanges = 0;
  testHarness.controller.subscribe(jsonKey, "a ", () => { jsonChanges += 1; });
  testHarness.controller.subscribe(sqliteKey, "a ", () => { sqliteChanges += 1; });

  testHarness.controller.acceptDelta({ canonicalText: "a b ", delta: "b ", key: jsonKey });
  testHarness.controller.acceptDelta({ canonicalText: "a b c", delta: "c", key: jsonKey });
  assert.equal(testHarness.controller.getSnapshot(jsonKey), "a ");
  testHarness.drain();

  assert.equal(testHarness.controller.getSnapshot(jsonKey), "a b c");
  assert.equal(testHarness.controller.getSnapshot(sqliteKey), "a ");
  assert.ok(jsonChanges > 0);
  assert.equal(sqliteChanges, 0);
});

test("a whole-paragraph delta reveals token by token at the owned pace", () => {
  const testHarness = harness();
  const field = key("json");
  testHarness.controller.subscribe(field, "", () => undefined);
  testHarness.controller.acceptDelta({ canonicalText: WORDS, delta: WORDS, key: field });

  testHarness.play(100);
  const early = testHarness.controller.getSnapshot(field) ?? "";
  assert.ok(early.length > 0 && early.length < WORDS.length / 4, `revealed ${early.length}`);
  assert.equal(early.length % "word ".length, 0, "reveal stops on token boundaries");
  testHarness.drain();
  assert.equal(testHarness.controller.getSnapshot(field), WORDS);
});

test("reveal pace ignores how the provider chunked the same text", () => {
  const whole = harness();
  const chunked = harness();
  const field = key("json");
  whole.controller.subscribe(field, "", () => undefined);
  chunked.controller.subscribe(field, "", () => undefined);
  whole.controller.acceptDelta({ canonicalText: WORDS, delta: WORDS, key: field });
  let canonicalText = "";
  for (const token of WORDS.match(/\S+\s*/g)!) {
    canonicalText += token;
    chunked.controller.acceptDelta({ canonicalText, delta: token, key: field });
  }

  for (const elapsed of [50, 200, 600]) {
    whole.play(elapsed);
    chunked.play(elapsed);
    assert.equal(whole.controller.getSnapshot(field), chunked.controller.getSnapshot(field));
  }
});

test("simultaneous fields each make bounded playback progress", () => {
  const testHarness = harness();
  const jsonKey = key("json");
  const sqliteKey = key("sqlite");
  testHarness.controller.subscribe(jsonKey, "", () => undefined);
  testHarness.controller.subscribe(sqliteKey, "", () => undefined);
  testHarness.controller.acceptDelta({ canonicalText: WORDS, delta: WORDS, key: jsonKey });
  testHarness.controller.acceptDelta({ canonicalText: WORDS, delta: WORDS, key: sqliteKey });

  testHarness.play(100);

  for (const field of [jsonKey, sqliteKey]) {
    const length = testHarness.controller.getSnapshot(field)?.length ?? 0;
    assert.ok(length > 0 && length < WORDS.length);
  }
});

test("large backlogs catch up within a bounded time without losing text", () => {
  const testHarness = harness();
  const field = key("json");
  const dump = "abcd ".repeat(4_000);
  testHarness.controller.subscribe(field, "", () => undefined);
  testHarness.controller.acceptDelta({ canonicalText: dump, delta: dump, key: field });

  testHarness.advance();
  const firstFrame = testHarness.controller.getSnapshot(field)?.length ?? 0;
  assert.ok(firstFrame < dump.length);
  testHarness.play(1_000);
  assert.ok((testHarness.controller.getSnapshot(field)?.length ?? 0) > dump.length / 2, "catch-up scales with backlog");
  testHarness.play(7_000);
  assert.equal(testHarness.controller.getSnapshot(field), dump);
});

test("a late frame advances a bounded step instead of dumping the backlog", () => {
  const testHarness = harness();
  const field = key("json");
  testHarness.controller.subscribe(field, "", () => undefined);
  testHarness.controller.acceptDelta({ canonicalText: WORDS, delta: WORDS, key: field });

  testHarness.advance(5_000);
  assert.ok((testHarness.controller.getSnapshot(field)?.length ?? 0) < WORDS.length / 4);
});

test("long unbroken tokens reveal whole without stalling", () => {
  const testHarness = harness();
  const field = key("json");
  const text = `${"x".repeat(200)} tail`;
  testHarness.controller.subscribe(field, "", () => undefined);
  testHarness.controller.acceptDelta({ canonicalText: text, delta: text, key: field });

  testHarness.play(250);
  assert.equal(testHarness.controller.getSnapshot(field), text);
});

test("a whole-text restatement keeps revealing: unchanged text waits, longer text reveals only its tail", () => {
  const testHarness = harness();
  const field = key("json");
  testHarness.controller.subscribe(field, "", () => undefined);
  testHarness.controller.acceptDelta({ canonicalText: WORDS, delta: WORDS, key: field });
  testHarness.play(100);
  const revealed = () => testHarness.controller.getSnapshot(field)?.length;
  const before = revealed();

  // Providers close a streamed field by restating its whole text.
  testHarness.controller.acceptDelta({ canonicalText: WORDS, delta: WORDS, key: field });
  assert.equal(revealed(), before);
  testHarness.controller.acceptDelta({ canonicalText: `${WORDS}tail`, delta: `${WORDS}tail`, key: field });
  assert.equal(revealed(), before);
  testHarness.drain();
  assert.equal(testHarness.controller.getSnapshot(field), `${WORDS}tail`);
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

test("an unwatched mid-item delta keeps canonical text without scheduling replay", () => {
  const testHarness = harness();
  const sqliteKey = key("sqlite");
  testHarness.controller.acceptDelta({ canonicalText: "current", delta: "rent", key: sqliteKey });

  assert.equal(testHarness.controller.getSnapshot(sqliteKey), "current");
  assert.equal(testHarness.scheduled(), false);
  testHarness.controller.subscribe(sqliteKey, "cur", () => undefined);
  assert.equal(testHarness.controller.getSnapshot(sqliteKey), "current");
  assert.equal(testHarness.scheduled(), false);
});

test("an item's first text reveals from empty once promptly watched", () => {
  const testHarness = harness();
  const field = key("json");
  testHarness.controller.acceptDelta({ canonicalText: "hello ", delta: "hello ", key: field });
  testHarness.controller.acceptDelta({ canonicalText: "hello world", delta: "world", key: field });

  assert.equal(testHarness.controller.getSnapshot(field), "");
  assert.equal(testHarness.scheduled(), false);
  testHarness.controller.subscribe(field, "hello world", () => undefined);
  testHarness.drain();
  assert.equal(testHarness.controller.getSnapshot(field), "hello world");
});

test("text nobody watched in time shows whole when it is finally watched, and only later text reveals", () => {
  const testHarness = harness();
  const field = key("json");
  testHarness.controller.acceptDelta({ canonicalText: "hello world", delta: "hello world", key: field });
  // The message finished before anyone looked: no later delta ever arrives to settle it.
  testHarness.wait(2_000);
  testHarness.controller.subscribe(field, "hello world", () => undefined);
  assert.equal(testHarness.controller.getSnapshot(field), "hello world");
  assert.equal(testHarness.scheduled(), false);

  testHarness.controller.acceptDelta({ canonicalText: "hello world again", delta: " again", key: field });
  assert.equal(testHarness.controller.getSnapshot(field), "hello world");
  testHarness.drain();
  assert.equal(testHarness.controller.getSnapshot(field), "hello world again");
});

test("an item's first text settles to canonical when nobody watches it in time", () => {
  const testHarness = harness();
  const field = key("json");
  testHarness.controller.acceptDelta({ canonicalText: "hello ", delta: "hello ", key: field });
  testHarness.wait(2_000);
  testHarness.controller.acceptDelta({ canonicalText: "hello world", delta: "world", key: field });

  assert.equal(testHarness.controller.getSnapshot(field), "hello world");
  assert.equal(testHarness.scheduled(), false);
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
