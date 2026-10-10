/*
 * Exports:
 * - No production exports; regression wards protect tooltip wrapper markup, positioning clamps, and pointer-safe interaction. Keywords: tooltip, portal, hover, viewport.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  getTooltipPosition,
  isTooltipPointerSupported,
  isPointWithinTooltipArea,
} from "./tooltip-geometry";
import Tooltip from "./Tooltip";

const triggerRect = {
  bottom: 140,
  height: 40,
  left: 100,
  right: 300,
  top: 100,
  width: 200,
};

test("tooltip clones its trigger without adding wrapper markup", () => {
  const html = renderToStaticMarkup(
    <Tooltip content={<span>Details</span>}>
      <button type="button">Open</button>
    </Tooltip>,
  );
  assert.equal(html, "<button type=\"button\">Open</button>");
});

test("hover tooltips activate only for mouse pointers", () => {
  assert.equal(isTooltipPointerSupported("mouse"), true);
  assert.equal(isTooltipPointerSupported("touch"), false);
  assert.equal(isTooltipPointerSupported("pen"), false);
});

test("tooltip position centers beside its trigger and clamps to viewport gutters", () => {
  const centered = getTooltipPosition({
    tooltipHeight: 100,
    triggerRect,
    viewportHeight: 500,
    viewportWidth: 900,
  });
  assert.deepEqual(centered, { left: 308, maxHeight: 476, maxWidth: 580, top: 70 });

  const topClamped = getTooltipPosition({
    tooltipHeight: 180,
    triggerRect: { ...triggerRect, bottom: 40, top: 0 },
    viewportHeight: 300,
    viewportWidth: 900,
  });
  assert.equal(topClamped.top, 12);

  const bottomClamped = getTooltipPosition({
    tooltipHeight: 180,
    triggerRect: { ...triggerRect, bottom: 300, top: 260 },
    viewportHeight: 300,
    viewportWidth: 900,
  });
  assert.equal(bottomClamped.top, 108);
});

test("top placement centres above its trigger, clamps inside the viewport, and drops below only when roomier", () => {
  const above = { placement: "top" as const, tooltipHeight: 60, tooltipWidth: 100, viewportHeight: 500, viewportWidth: 900 };
  assert.deepEqual(getTooltipPosition({ ...above, triggerRect }), { left: 150, maxHeight: 80, maxWidth: 876, top: 32 });
  const nearEdge = { ...triggerRect, left: 850, right: 890 };
  assert.equal(getTooltipPosition({ ...above, triggerRect: nearEdge }).left, 788, "the right gutter holds a tooltip near the edge");
  const nearTop = { ...triggerRect, top: 20, bottom: 60 };
  const below = getTooltipPosition({ ...above, triggerRect: nearTop });
  assert.deepEqual([below.top, below.maxHeight], [68, 420], "too little room above opens below");
});

test("pointer proximity includes the tooltip surface only for interactive tooltips", () => {
  const tooltipRect = {
    bottom: 220,
    height: 140,
    left: 308,
    right: 508,
    top: 80,
    width: 200,
  };
  assert.equal(isPointWithinTooltipArea(306, 120, triggerRect, tooltipRect, 12, false), true);
  assert.equal(isPointWithinTooltipArea(420, 120, triggerRect, tooltipRect, 12, false), false);
  assert.equal(isPointWithinTooltipArea(420, 120, triggerRect, tooltipRect, 12, true), true);
  assert.equal(isPointWithinTooltipArea(540, 120, triggerRect, tooltipRect, 12, true), false);
});
