import assert from "node:assert/strict";
import test from "node:test";

import { shouldPinStickyComposer, type StickyComposerPinGeometry } from "./sticky-composer-pin";

const PIN_LINE = 600;
const HEIGHT = 100;
const GROWTH = 20;

function geometry (naturalTop: number, height: number, stuck: boolean): StickyComposerPinGeometry {
  return {
    docked: false, stuck, collapsed: false, naturalTop,
    shellHeight: height, pinnedHeight: height, pinLine: PIN_LINE, viewportBottom: PIN_LINE + 12,
  };
}

/** Grow the shell (a hover expanding a field), then shrink it back, re-deciding after each resize like the surface does. */
function growThenShrink (naturalTop: number, stuck: boolean) {
  const states = [stuck];
  for (const height of [HEIGHT + GROWTH, HEIGHT]) {
    stuck = shouldPinStickyComposer(geometry(naturalTop, height, stuck));
    states.push(stuck);
  }
  return states;
}

test("a resize and its undo at a fixed scroll position cannot flip the pin back and forth", () => {
  for (let naturalTop = PIN_LINE - HEIGHT - 60; naturalTop <= PIN_LINE - HEIGHT + 60; naturalTop++) {
    for (const stuck of [false, true]) {
      // Flipping on growth then back on shrink is the loop: the flip moves the field off the cursor, which undoes the growth.
      const [start, grown, shrunk] = growThenShrink(naturalTop, stuck);
      assert.ok(grown === start || shrunk === grown, `naturalTop ${naturalTop} starting ${start ? "pinned" : "natural"} flips back`);
    }
  }
});

test("a natural shell pins once its slot reaches past the pin line", () => {
  assert.equal(shouldPinStickyComposer(geometry(PIN_LINE - HEIGHT, HEIGHT, false)), false);
  assert.equal(shouldPinStickyComposer(geometry(PIN_LINE - HEIGHT + 1, HEIGHT, false)), true);
});

test("a pinned shell unpins once its slot rises far enough above its pinned position", () => {
  assert.equal(shouldPinStickyComposer(geometry(PIN_LINE - HEIGHT - 1, HEIGHT, true)), true);
  assert.equal(shouldPinStickyComposer(geometry(PIN_LINE - HEIGHT - 60, HEIGHT, true)), false);
});

test("a docked shell never pins", () => {
  assert.equal(shouldPinStickyComposer({ ...geometry(PIN_LINE, HEIGHT, true), docked: true }), false);
});

test("a collapsed bar returns only once its slot leaves the viewport", () => {
  const collapsed = { ...geometry(PIN_LINE, HEIGHT, false), collapsed: true };
  assert.equal(shouldPinStickyComposer(collapsed), false);
  assert.equal(shouldPinStickyComposer({ ...collapsed, naturalTop: collapsed.viewportBottom }), true);
});
