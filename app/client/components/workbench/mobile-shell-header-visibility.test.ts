/*
 * No production exports. Tests protect gesture-owned header visibility and top recovery.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceMobileShellHeaderVisibility,
  type MobileShellHeaderVisibility,
} from "./mobile-shell-header-visibility";

const initial: MobileShellHeaderVisibility = {
  visible: true,
  direction: null,
  travelPx: 0,
  lastScroll: null,
  gestureSinceLastScroll: false,
  touchPhase: "none",
};

test("upward intent reveals a hidden header without a scroll-position delta", () => {
  const hidden = { ...initial, visible: false };
  const after = advanceMobileShellHeaderVisibility(hidden, {
    kind: "gesture", direction: "up", travelPx: 12,
  });
  assert.equal(after.visible, true);
});

test("downward and upward gestures keep their distinct travel thresholds", () => {
  const partway = advanceMobileShellHeaderVisibility(initial, {
    kind: "gesture", direction: "down", travelPx: 20,
  });
  assert.equal(partway.visible, true);
  const hidden = advanceMobileShellHeaderVisibility(partway, {
    kind: "gesture", direction: "down", travelPx: 4,
  });
  assert.equal(hidden.visible, false);
  const stillHidden = advanceMobileShellHeaderVisibility(hidden, {
    kind: "gesture", direction: "up", travelPx: 7,
  });
  assert.equal(stillHidden.visible, false);
  assert.equal(advanceMobileShellHeaderVisibility(stillHidden, {
    kind: "gesture", direction: "up", travelPx: 1,
  }).visible, true);
});

test("changing gesture direction discards travel in the previous direction", () => {
  const down = advanceMobileShellHeaderVisibility(initial, {
    kind: "gesture", direction: "down", travelPx: 20,
  });
  const up = advanceMobileShellHeaderVisibility(down, {
    kind: "gesture", direction: "up", travelPx: 2,
  });
  assert.equal(advanceMobileShellHeaderVisibility(up, {
    kind: "gesture", direction: "down", travelPx: 4,
  }).visible, true);
});

test("reaching the real top always restores the header on long content", () => {
  const hidden = { ...initial, visible: false };
  assert.equal(advanceMobileShellHeaderVisibility(hidden, {
    kind: "scroll", scrollTop: 0, scrollHeight: 2_000, clientHeight: 600,
  }).visible, true);
});

test("a gesture can hide before scroll position updates, then only the actual top restores it", () => {
  const hidden = advanceMobileShellHeaderVisibility(initial, {
    kind: "gesture", direction: "down", travelPx: 24,
  });
  assert.equal(hidden.visible, false);
  assert.equal(advanceMobileShellHeaderVisibility(hidden, {
    kind: "scroll", scrollTop: 40, scrollHeight: 2_000, clientHeight: 600,
  }).visible, false);
  assert.equal(advanceMobileShellHeaderVisibility(hidden, {
    kind: "scroll", scrollTop: 0, scrollHeight: 2_000, clientHeight: 600,
  }).visible, true);
});

test("reversing movement during momentum works without another gesture event", () => {
  let state = advanceMobileShellHeaderVisibility({ ...initial, visible: false }, {
    kind: "scroll", scrollTop: 500, scrollHeight: 2_000, clientHeight: 600,
  });
  state = advanceMobileShellHeaderVisibility(state, {
    kind: "scroll", scrollTop: 490, scrollHeight: 2_000, clientHeight: 600,
  });
  assert.equal(state.visible, true);
  state = advanceMobileShellHeaderVisibility(state, {
    kind: "scroll", scrollTop: 515, scrollHeight: 2_000, clientHeight: 600,
  });
  assert.equal(state.visible, false);
});

test("a reported gesture and its scroll movement count only once", () => {
  let state = advanceMobileShellHeaderVisibility(initial, {
    kind: "scroll", scrollTop: 500, scrollHeight: 2_000, clientHeight: 600,
  });
  state = advanceMobileShellHeaderVisibility(state, {
    kind: "gesture", direction: "down", travelPx: 20,
  });
  state = advanceMobileShellHeaderVisibility(state, {
    kind: "scroll", scrollTop: 520, scrollHeight: 2_000, clientHeight: 600,
  });
  assert.equal(state.visible, true);
  assert.equal(advanceMobileShellHeaderVisibility(state, {
    kind: "gesture", direction: "down", travelPx: 4,
  }).visible, false);
});

test("history prepend position restoration does not pretend to be user movement", () => {
  let state = advanceMobileShellHeaderVisibility(initial, {
    kind: "scroll", scrollTop: 500, scrollHeight: 2_000, clientHeight: 600,
  });
  state = advanceMobileShellHeaderVisibility(state, {
    kind: "scroll", scrollTop: 900, scrollHeight: 2_400, clientHeight: 600,
  });
  assert.equal(state.visible, true);
  assert.equal(advanceMobileShellHeaderVisibility(state, {
    kind: "scroll", scrollTop: 925, scrollHeight: 2_400, clientHeight: 600,
  }).visible, false);
});

test("old momentum cannot undo a reported touch reversal, but movement resumes after release", () => {
  let state = advanceMobileShellHeaderVisibility({ ...initial, visible: false }, {
    kind: "scroll", scrollTop: 500, scrollHeight: 2_000, clientHeight: 600,
  });
  state = advanceMobileShellHeaderVisibility(state, { kind: "touch", active: true });
  state = advanceMobileShellHeaderVisibility(state, {
    kind: "gesture", direction: "up", travelPx: 12,
  });
  state = advanceMobileShellHeaderVisibility(state, {
    kind: "scroll", scrollTop: 530, scrollHeight: 2_000, clientHeight: 600,
  });
  state = advanceMobileShellHeaderVisibility(state, {
    kind: "scroll", scrollTop: 560, scrollHeight: 2_000, clientHeight: 600,
  });
  assert.equal(state.visible, true);
  state = advanceMobileShellHeaderVisibility(state, { kind: "touch", active: false });
  assert.equal(advanceMobileShellHeaderVisibility(state, {
    kind: "scroll", scrollTop: 585, scrollHeight: 2_000, clientHeight: 600,
  }).visible, false);
});

test("scroll movement remains usable when a touch starts but movement events are withheld", () => {
  let state = advanceMobileShellHeaderVisibility(initial, {
    kind: "scroll", scrollTop: 500, scrollHeight: 2_000, clientHeight: 600,
  });
  state = advanceMobileShellHeaderVisibility(state, { kind: "touch", active: true });
  assert.equal(advanceMobileShellHeaderVisibility(state, {
    kind: "scroll", scrollTop: 525, scrollHeight: 2_000, clientHeight: 600,
  }).visible, false);
});
