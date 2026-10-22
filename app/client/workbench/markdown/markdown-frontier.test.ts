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

test("a trailing word waits only while it could still become a url or path link", () => {
  for (const tail of ["app/client/Fo", "C:", ".", "h", "htt", "https:", "https://exa", "www.ex"]) {
    assert.equal(held(`open ${tail}`), tail, tail);
  }
  // Plain words, emphasis and inline code never change shape as they grow, so the last word shows as it streams.
  for (const text of ["it is compl", "**bol", "`co", "Done", "done.\n", "done "]) {
    assert.equal(held(text), null, text);
  }
});

test("final lines that render nothing yet, or could still become a block marker, hold their whole block", () => {
  for (const line of ["#", "## ", "-", "--", "1.", "12", ">", "```t", "- ```ts", '<notice title="x" col', "<plan>"]) {
    assert.equal(isHeldFrontierLine(line), true, line);
  }
  for (const line of ["## Title ", "- word", "- two words", "| a | b", "plain text", "Done"]) {
    assert.equal(isHeldFrontierLine(line), false, line);
  }
});
