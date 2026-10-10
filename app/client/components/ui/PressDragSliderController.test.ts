/* Tests: press-drag preview, single commit, cancellation and bounded keyboard changes. */
import assert from "node:assert/strict";
import test from "node:test";
import PressDragSliderController from "./PressDragSliderController";

test("preview subscribers see drag changes before commit and cancellation clears them", () => {
  const slider = new PressDragSliderController();
  const previews: Array<number | null> = [];
  const unsubscribe = slider.subscribePreview(value => previews.push(value));
  const range = { value: 50, min: 0, max: 100, step: 10 };
  assert.equal(slider.getPreview(), null);
  slider.begin(range, 200, 100);
  slider.move(180);
  slider.move(179);
  assert.deepEqual(previews, [50, 70]);
  assert.equal(slider.getPreview(), 70);
  assert.equal(slider.commit(), 70);
  assert.deepEqual(previews, [50, 70, null]);
  slider.begin(range, 200, 100);
  slider.setPreview(30);
  slider.cancel();
  assert.deepEqual(previews.slice(3), [50, 30, null]);
  unsubscribe();
  slider.begin(range, 200, 100);
  assert.equal(previews.length, 6);
});

test("absolute tracks preserve a stationary press and map drag positions to both bounds", () => {
  const slider = new PressDragSliderController();
  const range = { value: 1.08, min: 0.84, max: 1.72, step: 0.08 };
  slider.begin(range, 25, 144, 100);
  assert.equal(slider.move(25), range.value);
  assert.equal(slider.move(100), range.max);
  assert.equal(slider.move(244), range.min);
  assert.equal(slider.move(25), range.max);
  assert.equal(slider.move(244), range.min);
  assert.equal(slider.commit(), range.min);
  assert.equal(slider.move(100), null);
});

function touchFixture() {
  let now = 0;
  const tasks: Array<{ at: number; run: () => void; cancelled: boolean }> = [];
  const slider = new PressDragSliderController((run, delay) => {
    const task = { at: now + delay, run, cancelled: false };
    tasks.push(task);
    return () => { task.cancelled = true; };
  });
  return {
    slider,
    advance(time: number) {
      now += time;
      for (const task of tasks.splice(0)) {
        if (task.at > now) tasks.push(task);
        else if (!task.cancelled) task.run();
      }
    },
  };
}

test("touch holds tolerate jitter and activate only after half a second", () => {
  const { slider, advance } = touchFixture();
  slider.holdTouch(20, 200, y => slider.begin({ value: 50, min: 0, max: 100, step: 1 }, y, 100));
  slider.moveTouch(23, 202);
  slider.cancelTouchHoldAfterMovement(3);
  advance(499);
  assert.equal(slider.isActive, false);
  advance(1);
  assert.equal(slider.isActive, true);
  assert.equal(slider.moveTouch(23, 192), 60);
  assert.equal(slider.commit(), 60);
});

test("scroll intent, release and cancellation cannot activate a stale touch hold", () => {
  for (const abort of [
    (slider: PressDragSliderController) => slider.moveTouch(29, 200),
    (slider: PressDragSliderController) => slider.cancelTouchHoldAfterMovement(9),
    (slider: PressDragSliderController) => slider.commit(),
    (slider: PressDragSliderController) => slider.cancel(),
  ]) {
    const { slider, advance } = touchFixture();
    let activations = 0;
    slider.holdTouch(20, 200, () => { activations++; });
    slider.cancelTouchHoldAfterMovement(3);
    abort(slider);
    advance(500);
    assert.equal(activations, 0);
    assert.equal(slider.commit(), null);
  }
});

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
