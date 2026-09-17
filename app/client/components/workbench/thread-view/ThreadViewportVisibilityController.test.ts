/* No exports. Protect measured visibility and shared observer disposal. */
import assert from "node:assert/strict";
import test from "node:test";
import ThreadViewportVisibilityController from "./ThreadViewportVisibilityController";

test("viewport visibility owns exact and nearby observation ranges", () => {
  const observers: Array<{ disconnected: boolean; margin: number; range: string }> = [];
  const observed = { nearby: 0, viewport: 0 };
  let rootHeight = 640;
  let resize: (entries: readonly { target: Element }[]) => void = () => {};
  const root = { getBoundingClientRect: () => ({ height: rootHeight }) } as HTMLElement;
  const target = { getBoundingClientRect: () => ({ height: 120 }) } as HTMLElement;
  const owner = new ThreadViewportVisibilityController({
    root,
    intersection: (_callback, range, margin) => {
      const record = { disconnected: false, margin, range };
      observers.push(record);
      return {
        observe: () => { observed[range]++; },
        unobserve: () => {},
        disconnect: () => { record.disconnected = true; },
      };
    },
    resize: callback => {
      resize = callback;
      return { observe: () => {}, unobserve: () => {}, disconnect: () => {} };
    },
  });

  assert.deepEqual(observers.map(({ margin, range }) => ({ margin, range })), [
    { margin: 0, range: "viewport" },
    { margin: 640, range: "nearby" },
  ]);
  owner.observe(target, () => {}, "nearby");
  assert.deepEqual(observed, { nearby: 1, viewport: 0 });
  rootHeight = 800;
  resize([{ target: root }]);
  assert.deepEqual(observers.at(-1), { disconnected: false, margin: 800, range: "nearby" });
  assert.equal(observers[1]?.disconnected, true);
  assert.deepEqual(observed, { nearby: 2, viewport: 0 });
  owner.dispose();
});

test("offscreen placeholders retain measured height until visible content is measured again", () => {
  const intersections: Partial<Record<"nearby" | "viewport", (entries: readonly { target: Element; isIntersecting: boolean; boundingClientRect: { height: number } }[]) => void>> = {};
  let resize: (entries: readonly { target: Element }[]) => void = () => {};
  let height = 120;
  const target = { getBoundingClientRect: () => ({ height }) } as HTMLElement;
  const states: Array<{ visible: boolean; height: number }> = [];
  let disconnected = 0;
  let unobserved = 0;
  const root = { getBoundingClientRect: () => ({ height: 640 }) } as HTMLElement;
  const observer = () => ({
    observe: () => {}, unobserve: () => { unobserved++; }, disconnect: () => { disconnected++; },
  });
  const owner = new ThreadViewportVisibilityController({
    root,
    intersection: (callback, range) => { intersections[range] = callback; return observer(); },
    resize: callback => { resize = callback; return observer(); },
  });
  const stop = owner.observe(target, state => states.push(state));
  intersections.viewport?.([{ target, isIntersecting: false, boundingClientRect: { height: 120 } }]);
  height = 0;
  resize([{ target }]);
  assert.deepEqual(states.at(-1), { visible: false, height: 120 });
  intersections.viewport?.([{ target, isIntersecting: true, boundingClientRect: { height: 120 } }]);
  height = 80;
  resize([{ target }]);
  assert.deepEqual(states.at(-1), { visible: true, height: 80 });
  stop();
  const count = states.length;
  intersections.viewport?.([{ target, isIntersecting: false, boundingClientRect: { height: 80 } }]);
  assert.equal(states.length, count);
  assert.equal(unobserved, 2);
  owner.dispose();
  assert.equal(disconnected, 3);
});

test("unmeasured content is not hidden using a fabricated height", () => {
  const intersections: Partial<Record<"nearby" | "viewport", (entries: readonly { target: Element; isIntersecting: boolean; boundingClientRect: { height: number } }[]) => void>> = {};
  const target = { getBoundingClientRect: () => ({ height: 0 }) } as HTMLElement;
  const states: Array<{ visible: boolean; height: number }> = [];
  const observer = { observe: () => {}, unobserve: () => {}, disconnect: () => {} };
  const root = { getBoundingClientRect: () => ({ height: 640 }) } as HTMLElement;
  const owner = new ThreadViewportVisibilityController({
    root,
    intersection: (callback, range) => { intersections[range] = callback; return observer; },
    resize: () => observer,
  });
  owner.observe(target, state => states.push(state));
  intersections.viewport?.([{ target, isIntersecting: false, boundingClientRect: { height: 0 } }]);
  assert.equal(states.some(state => !state.visible), false);
  owner.dispose();
});
