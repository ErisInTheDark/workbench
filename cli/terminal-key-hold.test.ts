/*
 * No production exports. Protects terminal key decoding and hold-to-confirm decisions on kitty and autorepeat terminals.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { decodeTerminalInput, TerminalKeyHold } from "./terminal-key-hold.ts";

test("decodes legacy keys, a lone Escape, kitty events and the kitty query reply", () => {
  assert.deepEqual(decodeTerminalInput("rr"), { events: [{ key: "r", type: "press" }, { key: "r", type: "press" }], kittySupported: false });
  assert.deepEqual(decodeTerminalInput("\u001b").events, [{ key: "Escape", type: "press" }]);
  // Arrow keys are escape sequences, never an Escape press.
  assert.deepEqual(decodeTerminalInput("\u001b[A").events, []);
  assert.deepEqual(decodeTerminalInput("\u001b[114u\u001b[114;1:2u\u001b[114;1:3u").events, [
    { key: "r", type: "press" }, { key: "r", type: "repeat" }, { key: "r", type: "release" },
  ]);
  assert.deepEqual(decodeTerminalInput("\u001b[27u").events, [{ key: "Escape", type: "press" }]);
  assert.deepEqual(decodeTerminalInput("\u001b[99;5u").events, [{ key: "\u0003", type: "press" }]);
  assert.equal(decodeTerminalInput("\u001b[?1u").kittySupported, true);
});

test("kitty: releasing at full progress fires, earlier cancels, and Escape cancels even at full progress", () => {
  const early = new TerminalKeyHold("r", 1_000, 0, true);
  assert.equal(early.accept({ key: "r", type: "repeat" }, 400), "holding");
  assert.equal(early.tick(5_000), "holding");
  assert.equal(early.accept({ key: "r", type: "release" }, 600), "cancel");

  const full = new TerminalKeyHold("r", 1_000, 0, true);
  assert.equal(full.progress(1_400), 1);
  assert.equal(full.accept({ key: "r", type: "release" }, 1_400), "fire");

  const escaped = new TerminalKeyHold("r", 1_000, 0, true);
  assert.equal(escaped.progress(1_500), 1);
  assert.equal(escaped.accept({ key: "Escape", type: "press" }, 1_500), "cancel");
});

test("autorepeat: a tap with no repeat cancels once the first-repeat window passes", () => {
  const tap = new TerminalKeyHold("u", 1_000, 0, false);
  assert.equal(tap.tick(500), "holding");
  assert.equal(tap.tick(701), "cancel");
});

test("autorepeat: repeats keep a hold alive past the duration, and a repeat gap releases it", () => {
  const hold = new TerminalKeyHold("r", 1_000, 0, false);
  // OS repeat delay, then a 30ms repeat rate.
  let now = 500;
  hold.accept({ key: "r", type: "press" }, now);
  while (now < 1_300) {
    now += 30;
    assert.equal(hold.accept({ key: "r", type: "press" }, now), "holding");
    assert.equal(hold.tick(now + 10), "holding");
  }
  assert.equal(hold.progress(now), 1);
  assert.equal(hold.tick(now + 60), "holding");
  assert.equal(hold.tick(now + 81), "fire");
});

test("autorepeat: releasing before the duration cancels", () => {
  const hold = new TerminalKeyHold("r", 2_000, 0, false);
  let now = 500;
  hold.accept({ key: "r", type: "press" }, now);
  for (; now < 900; now += 30) hold.accept({ key: "r", type: "press" }, now + 30);
  assert.equal(hold.tick(now + 200), "cancel");
});

test("other keys neither extend nor end a hold", () => {
  const hold = new TerminalKeyHold("r", 1_000, 0, true);
  assert.equal(hold.accept({ key: "x", type: "press" }, 100), "holding");
  assert.equal(hold.accept({ key: "x", type: "release" }, 200), "holding");
  assert.equal(hold.accept({ key: "r", type: "release" }, 1_100), "fire");
});
