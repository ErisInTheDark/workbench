/*
 * No exports. Tests protect repeated initial end placement and permanent release on reader intent.
 */
import assert from "node:assert/strict";
import test from "node:test";
import ThreadInitialEndPlacementController from "./ThreadInitialEndPlacementController";

test("initial layout commits keep following the real end until reader intent", () => {
  const controller = new ThreadInitialEndPlacementController();

  assert.equal(controller.getScrollTop(false, 900), null);
  assert.equal(controller.getScrollTop(true, 900), 900);
  assert.equal(controller.getScrollTop(true, 6_400), 6_400);

  controller.release();
  assert.equal(controller.getScrollTop(true, 8_000), null);
});
