/* Tests: anchored popovers remain inside available viewport space. */
import assert from "node:assert/strict";
import test from "node:test";
import { positionWorkbenchPopover } from "./workbench-popover-geometry";

test("end alignment follows the ribbon edge while preserving viewport containment", () => {
  const desired = { width: 440, height: 560, align: "end" as const };
  const viewport = { width: 1400, height: 1000 };
  for (const ribbon of [
    { left: 600, top: 900, width: 300, height: 40 },
    { left: 760, top: 900, width: 140, height: 40 },
  ]) {
    const box = positionWorkbenchPopover(ribbon, viewport, desired);
    assert.equal(box.left + box.width, ribbon.left + ribbon.width);
  }
  const clamped = positionWorkbenchPopover({ left: 0, top: 900, width: 100, height: 40 }, viewport, desired);
  assert.ok(clamped.left >= 12);
  assert.ok(clamped.left + clamped.width <= viewport.width - 12);
});

test("popover fits a small viewport and remains above its trigger when space permits", () => {
  for (const viewport of [{ width: 320, height: 300 }, { width: 1400, height: 1000 }]) {
    const box = positionWorkbenchPopover({ left: 280, top: viewport.height - 50, width: 80, height: 30 }, viewport, { width: 440, height: 560 });
    assert.ok(box.left >= 12);
    assert.ok(box.top >= 12);
    assert.ok(box.left + box.width <= viewport.width - 12);
    assert.ok(box.top + box.height <= viewport.height - 12);
    if (viewport.height === 1000) assert.ok(box.top + box.height < viewport.height - 50);
  }
});

test("keyboard and zoom offsets constrain the popup to the visual viewport", () => {
  const box = positionWorkbenchPopover({ left: 900, top: 800, width: 80, height: 30 }, { width: 320, height: 260, left: 600, top: 500 }, { width: 440, height: 560 });
  assert.ok(box.left >= 612 && box.left + box.width <= 908);
  assert.ok(box.top >= 512 && box.top + box.height <= 748);
});
