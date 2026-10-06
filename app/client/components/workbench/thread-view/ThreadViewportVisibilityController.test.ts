/* No exports. Protect measured visibility and shared observer disposal. */
import assert from "node:assert/strict";
import test from "node:test";
import ThreadViewportVisibilityController from "./ThreadViewportVisibilityController";

test("viewport visibility owns exact, approaching, and nearby observation ranges", () => {
  const observers: Array<{ disconnected: boolean; margin: number; range: string }> = [];
  const observed = { approaching: 0, nearby: 0, viewport: 0 };
  let rootHeight = 640;
  let resize: (entries: readonly { target: Element }[]) => void = () => {};
  const root = { getBoundingClientRect: () => ({ height: rootHeight }) } as HTMLElement;
  const target = { getBoundingClientRect: () => ({ height: 120 }) } as HTMLElement;
  const nearbyTarget = { getBoundingClientRect: () => ({ height: 120 }) } as HTMLElement;
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
    { margin: 160, range: "approaching" },
    { margin: 640, range: "nearby" },
  ]);
  owner.observe(target, () => {}, "approaching");
  owner.observe(nearbyTarget, () => {}, "nearby");
  assert.deepEqual(observed, { approaching: 1, nearby: 1, viewport: 0 });
  rootHeight = 800;
  resize([{ target: root }]);
  assert.deepEqual(
    observers.slice(-2),
    [
      { disconnected: false, margin: 200, range: "approaching" },
      { disconnected: false, margin: 800, range: "nearby" },
    ],
  );
  assert.equal(observers[1]?.disconnected, true);
  assert.equal(observers[2]?.disconnected, true);
  assert.deepEqual(observed, { approaching: 2, nearby: 2, viewport: 0 });
  owner.dispose();
});

test("offscreen placeholders retain measured height until visible content is measured again", () => {
  const intersections: Partial<Record<"approaching" | "nearby" | "viewport", (entries: readonly { target: Element; isIntersecting: boolean; boundingClientRect: { height: number } }[]) => void>> = {};
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
  assert.equal(disconnected, 4);
});

test("unmeasured content is not hidden using a fabricated height", () => {
  const intersections: Partial<Record<"approaching" | "nearby" | "viewport", (entries: readonly { target: Element; isIntersecting: boolean; boundingClientRect: { height: number } }[]) => void>> = {};
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

test("large-jump refresh activates approaching placeholders before intersection delivery", () => {
  const intersections: Partial<Record<"approaching" | "nearby" | "viewport", (entries: readonly {
    target: Element;
    isIntersecting: boolean;
    boundingClientRect: { height: number };
  }[]) => void>> = {};
  const root = {
    getBoundingClientRect: () => ({ bottom: 740, height: 640, top: 100 }),
  } as HTMLElement;
  let targetRect = { bottom: 2_120, height: 120, top: 2_000 };
  const target = { getBoundingClientRect: () => targetRect } as HTMLElement;
  const states: Array<{ visible: boolean; height: number }> = [];
  const observer = { observe: () => {}, unobserve: () => {}, disconnect: () => {} };
  const owner = new ThreadViewportVisibilityController({
    root,
    intersection: (callback, range) => { intersections[range] = callback; return observer; },
    resize: () => observer,
  });
  owner.observe(target, state => states.push(state), "approaching");
  intersections.approaching?.([{ target, isIntersecting: false, boundingClientRect: { height: 120 } }]);
  assert.equal(states.at(-1)?.visible, false);

  targetRect = { bottom: 320, height: 120, top: 200 };
  owner.refresh("approaching");

  assert.deepEqual(states.at(-1), { visible: true, height: 120 });
  owner.dispose();
});
