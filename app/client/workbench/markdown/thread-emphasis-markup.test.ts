/*
 * No production exports. Regression wards protect best-effort resolution of agent-authored icon markers and colour tags.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { readThreadColorTag, readThreadIconMarker } from "./thread-emphasis-markup";

function resolve(markdown: string) {
  const marker = readThreadIconMarker(markdown, 0);
  return marker && { color: marker.color, iconType: marker.iconType, label: marker.label, rest: markdown.slice(marker.end) };
}

test("well-formed markers resolve in either attribute order", () => {
  assert.deepEqual(resolve('<icon color="green" type="check" /> done'), { color: "green", iconType: "check", label: null, rest: " done" });
  assert.deepEqual(resolve('<icon type="alert" color="blue"/>'), { color: "blue", iconType: "alert", label: null, rest: "" });
  assert.deepEqual(resolve('<icon type="x">blocked</icon> after'), { color: null, iconType: "x", label: "blocked", rest: " after" });
});

test("malformed markers resolve to the icon the agent meant", () => {
  assert.deepEqual(resolve('<icon color="alert" type="alert"> warning text'), { color: "yellow", iconType: "alert", label: null, rest: " warning text" });
  assert.deepEqual(resolve('<icon color="check">'), { color: "green", iconType: "check", label: null, rest: "" });
  assert.deepEqual(resolve("<icon check>"), { color: null, iconType: "check", label: null, rest: "" });
  assert.deepEqual(resolve("<ICON Green Check/>"), { color: "green", iconType: "check", label: null, rest: "" });
  assert.deepEqual(resolve("<icon type='cross' colour=crimson />"), { color: "red", iconType: "x", label: null, rest: "" });
  assert.deepEqual(resolve('<icon color="orange" type="warning">careful</icon>'), { color: "yellow", iconType: "alert", label: "careful", rest: "" });
});

test("an unclosed paired opener stays a bare marker instead of claiming later text", () => {
  assert.deepEqual(resolve('<icon type="check">one <icon type="x">two</icon>'), { color: null, iconType: "check", label: null, rest: 'one <icon type="x">two</icon>' });
});

test("markers without a recognisable icon stay literal", () => {
  for (const markdown of ['<icon color="red" type="red" />', "<icon>", "<icon green>", "<iconic check>", '<icon type="check"\n/>']) {
    assert.equal(readThreadIconMarker(markdown, 0), null, markdown);
  }
});

function resolveColor(markdown: string, partial = false) {
  const tag = readThreadColorTag(markdown, 0, partial);
  return tag && { closed: tag.closed, color: tag.color, content: tag.content, rest: markdown.slice(tag.end) };
}

test("colour tags resolve palette names, aliases and hex the way agents write them", () => {
  assert.deepEqual(resolveColor('<color color="green">ok</color> after'), { closed: true, color: "green", content: "ok", rest: " after" });
  assert.deepEqual(resolveColor("<COLOUR colour='orange'>careful</Colour>"), { closed: true, color: "yellow", content: "careful", rest: "" });
  assert.deepEqual(resolveColor("<color crimson>bad</color>"), { closed: true, color: "red", content: "bad", rest: "" });
  assert.deepEqual(resolveColor('<color color="#FF8800">hex</color>'), { closed: true, color: "#ff8800", content: "hex", rest: "" });
  assert.deepEqual(resolveColor('<color color="#abc">short</color>'), { closed: true, color: "#abc", content: "short", rest: "" });
});

test("an unreadable colour still consumes the tag so its text shows plain", () => {
  for (const markdown of ['<color color="chartreuse">x</color>', '<color color="#12345">x</color>', "<color>x</color>"]) {
    assert.deepEqual(resolveColor(markdown), { closed: true, color: null, content: "x", rest: "" }, markdown);
  }
});

test("nested colour tags pair with their own closers", () => {
  assert.deepEqual(resolveColor('<color red>a <color blue>b</color> c</color> d'), {
    closed: true, color: "red", content: 'a <color blue>b</color> c', rest: " d",
  });
});

test("an unclosed colour tag stays literal once settled but colours streamed text up to the frontier", () => {
  assert.equal(readThreadColorTag('<color color="red">never closed', 0, false), null);
  assert.deepEqual(resolveColor('<color color="red">still streaming', true), { closed: false, color: "red", content: "still streaming", rest: "" });
  assert.equal(readThreadColorTag("<colorful>x</colorful>", 0, false), null);
});
