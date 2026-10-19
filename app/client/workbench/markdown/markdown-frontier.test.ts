/*
 * No production exports. Regression wards protect which streamed frontier tokens stay hidden until their meaning is locked in.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { findHeldInlineFrontierStart, isHeldFrontierLine } from "./markdown-frontier";

function held(text: string) {
  const start = findHeldInlineFrontierStart(text);
  return start === null ? null : text.slice(start);
}

test("partial tags that could still become known tags stay hidden", () => {
  for (const tail of ["<", "<ic", '<icon color="re', "</ico", "<b", "<set-st", "<!-", '<notice title="a b']) {
    assert.equal(held(`before ${tail}`), tail, tail);
  }
  assert.equal(held("a <zebra "), null);
  assert.equal(held('<icon type="x"> '), null);
});

test("links and file mentions stay hidden until they close", () => {
  for (const tail of ["[some label", "[label]", "[label](https://exa", "#", "#[app/client/Fo"]) {
    assert.equal(held(`see ${tail}`), tail, tail);
  }
  assert.equal(held("see [label] then "), null);
  assert.equal(held("see #[app/a.ts] "), null);
});

test("the trailing word waits for whitespace so paths and urls never flip into links", () => {
  assert.equal(held("open app/client/Fo"), "app/client/Fo");
  assert.equal(held("visit https://exa"), "https://exa");
  assert.equal(held("**bol"), "**bol");
  assert.equal(held("done.\n"), null);
  assert.equal(held("done "), null);
});

test("final lines that render nothing yet hold their whole block", () => {
  for (const line of ["#", "## ", "-", "--", "1.", "12", ">", "- word", "```t", "- ```ts", '<notice title="x" col', "<plan>"]) {
    assert.equal(isHeldFrontierLine(line), true, line);
  }
  for (const line of ["## Title ", "- two words", "| a | b", "plain text"]) {
    assert.equal(isHeldFrontierLine(line), false, line);
  }
});
