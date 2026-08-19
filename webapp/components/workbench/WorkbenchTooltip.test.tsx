/*
 * Exports:
 * - No production exports; regression wards protect tooltip wrapper markup, positioning clamps, and pointer-safe interaction. Keywords: tooltip, portal, hover, viewport.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  getWorkbenchTooltipPosition,
  isPointWithinWorkbenchTooltipArea,
} from "./workbench-tooltip-geometry";
import WorkbenchTooltip from "./WorkbenchTooltip";

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
    <WorkbenchTooltip content={<span>Details</span>}>
      <button type="button">Open</button>
    </WorkbenchTooltip>,
  );
  assert.equal(html, "<button type=\"button\">Open</button>");
});

test("tooltip position centers beside its trigger and clamps to viewport gutters", () => {
  const centered = getWorkbenchTooltipPosition({
    tooltipHeight: 100,
    triggerRect,
    viewportHeight: 500,
    viewportWidth: 900,
  });
  assert.deepEqual(centered, { left: 308, maxHeight: 476, maxWidth: 580, top: 70 });

  const topClamped = getWorkbenchTooltipPosition({
    tooltipHeight: 180,
    triggerRect: { ...triggerRect, bottom: 40, top: 0 },
    viewportHeight: 300,
    viewportWidth: 900,
  });
  assert.equal(topClamped.top, 12);

  const bottomClamped = getWorkbenchTooltipPosition({
    tooltipHeight: 180,
    triggerRect: { ...triggerRect, bottom: 300, top: 260 },
    viewportHeight: 300,
    viewportWidth: 900,
  });
  assert.equal(bottomClamped.top, 108);
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
  assert.equal(isPointWithinWorkbenchTooltipArea(306, 120, triggerRect, tooltipRect, 12, false), true);
  assert.equal(isPointWithinWorkbenchTooltipArea(420, 120, triggerRect, tooltipRect, 12, false), false);
  assert.equal(isPointWithinWorkbenchTooltipArea(420, 120, triggerRect, tooltipRect, 12, true), true);
  assert.equal(isPointWithinWorkbenchTooltipArea(540, 120, triggerRect, tooltipRect, 12, true), false);
});
