/*
 * No exports. Tests protect touch and momentum settling that gates thread prepends during iOS flings.
 */
import assert from "node:assert/strict";
import test from "node:test";
import ThreadScrollSettleController from "./ThreadScrollSettleController";

function fixture() {
  const pending = new Set<() => void>();
  let settledNotices = 0;
  const controller = new ThreadScrollSettleController({
    schedule: (callback) => {
      pending.add(callback);
      return () => { pending.delete(callback); };
    },
  });
  controller.subscribe(() => { settledNotices += 1; });
  return {
    controller,
    get notices() { return settledNotices; },
    idle() {
      const callbacks = [...pending];
      pending.clear();
      callbacks.forEach(callback => callback());
    },
  };
}

test("touch and the momentum after it stay unsettled until scrolling goes quiet", () => {
  const f = fixture();
  assert.equal(f.controller.settled, true);

  f.controller.touchStarted();
  assert.equal(f.controller.settled, false);
  f.idle();
  assert.equal(f.controller.settled, false, "a held finger never settles by idling");

  f.controller.touchEnded();
  f.controller.scrolled();
  assert.equal(f.controller.settled, false);
  f.idle();
  assert.equal(f.controller.settled, true);
  assert.equal(f.notices, 1);
});

test("native scrollend settles momentum early and a new touch cancels the pending settle", () => {
  const f = fixture();
  f.controller.touchStarted();
  f.controller.touchEnded();
  f.controller.scrollEnded();
  assert.equal(f.controller.settled, true);
  assert.equal(f.notices, 1);

  f.controller.touchStarted();
  f.controller.touchEnded();
  f.controller.touchStarted();
  f.idle();
  assert.equal(f.controller.settled, false);
  assert.equal(f.notices, 1);
});

test("scroll without touch, such as wheel or programmatic restoration, is already settled", () => {
  const f = fixture();
  f.controller.scrolled();
  f.controller.scrollEnded();
  assert.equal(f.controller.settled, true);
  assert.equal(f.notices, 0);
});
