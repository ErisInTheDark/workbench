/* Tests: press-drag preview, single commit, cancellation and bounded keyboard changes. */
import assert from "node:assert/strict";
import test from "node:test";
import PressDragSliderController from "./PressDragSliderController";

test("drag previews without committing and releases exactly once", () => {
  const slider = new PressDragSliderController();
  slider.begin({ value: 50, min: 0, max: 100, step: 10 }, 200, 100);
  assert.equal(slider.move(175), 80);
  assert.equal(slider.commit(), 80);
  assert.equal(slider.commit(), null);
});

test("cancellation discards preview and a new gesture starts from its own value", () => {
  const slider = new PressDragSliderController();
  slider.begin({ value: 50, min: 0, max: 100, step: 10 }, 200, 100);
  slider.move(0);
  slider.cancel();
  assert.equal(slider.commit(), null);
  slider.begin({ value: 20, min: 0, max: 100, step: 10 }, 200, 100);
  assert.equal(slider.commit(), 20);
});

test("native range previews use the same bounded single-commit gesture", () => {
  const slider = new PressDragSliderController();
  const range = { value: 272000, min: 272000, max: 872000, step: 1000 };
  assert.equal(slider.setPreview(500000), null);
  slider.begin(range, 0, 1);
  assert.equal(slider.setPreview(500400), 500000);
  assert.equal(slider.commit(), 500000);
  assert.equal(slider.commit(), null);
  slider.begin(range, 0, 1);
  assert.equal(slider.setPreview(900000), range.max);
  slider.cancel();
  assert.equal(slider.commit(), null);
});

test("pointer and keyboard honour bounds and nonzero step origins", () => {
  const slider = new PressDragSliderController();
  const range = { value: 128000, min: 128000, max: 1000000, step: 1000 };
  slider.begin(range, 200, 100);
  assert.equal(slider.move(10000), range.min);
  assert.equal(slider.move(-10000), range.max);
  slider.cancel();
  assert.equal(slider.keyboard(range, "ArrowDown"), range.min);
  assert.equal(slider.keyboard(range, "PageUp"), 138000);
  assert.equal(slider.keyboard(range, "End"), range.max);
  assert.equal(slider.keyboard(range, "Tab"), null);
});
