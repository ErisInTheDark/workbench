/*
 * No production exports. Regression wards protect best-effort resolution of agent-authored icon markers.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { readThreadIconMarker } from "./thread-icon-marker";

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
