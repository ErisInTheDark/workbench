/* No exports. Protect measured visibility and shared observer disposal. */
import assert from "node:assert/strict";
import test from "node:test";
import ThreadViewportVisibilityController from "./ThreadViewportVisibilityController";

test("offscreen placeholders retain measured height until visible content is measured again", () => {
  let intersection: (entries: readonly { target: Element; isIntersecting: boolean; boundingClientRect: { height: number } }[]) => void = () => {};
  let resize: (entries: readonly { target: Element }[]) => void = () => {};
  let height = 120;
  const target = { getBoundingClientRect: () => ({ height }) } as HTMLElement;
  const states: Array<{ visible: boolean; height: number }> = [];
  let disconnected = 0;
  let unobserved = 0;
  const observer = () => ({
    observe: () => {}, unobserve: () => { unobserved++; }, disconnect: () => { disconnected++; },
  });
  const owner = new ThreadViewportVisibilityController({
    intersection: callback => { intersection = callback; return observer(); },
    resize: callback => { resize = callback; return observer(); },
  });
  const stop = owner.observe(target, state => states.push(state));
  intersection([{ target, isIntersecting: false, boundingClientRect: { height: 120 } }]);
  height = 0;
  resize([{ target }]);
  assert.deepEqual(states.at(-1), { visible: false, height: 120 });
  intersection([{ target, isIntersecting: true, boundingClientRect: { height: 120 } }]);
  height = 80;
  resize([{ target }]);
  assert.deepEqual(states.at(-1), { visible: true, height: 80 });
  stop();
  const count = states.length;
  intersection([{ target, isIntersecting: false, boundingClientRect: { height: 80 } }]);
  assert.equal(states.length, count);
  assert.equal(unobserved, 2);
  owner.dispose();
  assert.equal(disconnected, 2);
});

test("unmeasured content is not hidden using a fabricated height", () => {
  let intersection: (entries: readonly { target: Element; isIntersecting: boolean; boundingClientRect: { height: number } }[]) => void = () => {};
  const target = { getBoundingClientRect: () => ({ height: 0 }) } as HTMLElement;
  const states: Array<{ visible: boolean; height: number }> = [];
  const observer = { observe: () => {}, unobserve: () => {}, disconnect: () => {} };
  const owner = new ThreadViewportVisibilityController({
    intersection: callback => { intersection = callback; return observer; },
    resize: () => observer,
  });
  owner.observe(target, state => states.push(state));
  intersection([{ target, isIntersecting: false, boundingClientRect: { height: 0 } }]);
  assert.equal(states.some(state => !state.visible), false);
  owner.dispose();
});
