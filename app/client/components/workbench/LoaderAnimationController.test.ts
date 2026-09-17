/* No exports. Tests loader completion ownership, non-repetition and cancellation. */
import assert from "node:assert/strict";
import { test } from "node:test";
import LoaderAnimationController, { type LoaderAnimator } from "./LoaderAnimationController";

const fixtures = [1, 3, 2].map((weight, target) => ({
  weight,
  duration: 100,
  tracks: () => [
    { target, frames: [{ opacity: 1 }, { opacity: 1 }] },
    { target, frames: [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }] },
  ],
}));

function harness(random = () => 0) {
  const calls: Array<{
    target: Parameters<LoaderAnimator>[0];
    options: KeyframeAnimationOptions;
    resolve: () => void;
    reject: (error: Error) => void;
    cancelled: boolean;
  }> = [];
  let warnings = 0;
  const controller = new LoaderAnimationController((target, _frames, options) => {
    const completion = Promise.withResolvers<Animation>();
    const call = { target, options, resolve: () => completion.resolve({} as Animation), reject: completion.reject, cancelled: false };
    calls.push(call);
    return { finished: completion.promise, cancel: () => {
      call.cancelled = true;
      completion.reject(new DOMException("Cancelled", "AbortError"));
    } };
  }, random, () => { warnings++; }, fixtures);
  return { controller, calls, warnings: () => warnings };
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

test("weights choices and renormalises after excluding the previous motion", async () => {
  for (const excludeFirst of [false, true]) {
    const counts = new Map<number, number>();
    const total = excludeFirst ? 5 : 6;
    for (let sample = 0; sample < total; sample++) {
      let random = excludeFirst ? 0 : (sample + .5) / total;
      const h = harness(() => random);
      h.controller.start();
      let batch = h.calls.filter(call => call.target !== "spin");
      if (excludeFirst) {
        random = (sample + .5) / total;
        const count = h.calls.length;
        batch.forEach(call => call.resolve());
        await flush();
        batch = h.calls.slice(count);
      }
      const choice = Number(batch[0]!.target);
      counts.set(choice, (counts.get(choice) ?? 0) + 1);
      h.controller.dispose();
      await flush();
    }
    assert.deepEqual(counts, new Map([
      ...(!excludeFirst ? [[0, 1] as const] : []),
      [1, 3], [2, 2],
    ]));
  }
});

test("waits for the whole motion, excludes its previous choice and preserves the outer spin", async () => {
  const h = harness();
  h.controller.start();
  assert.equal(h.calls.filter(call => call.target === "spin").length, 1);
  const first = h.calls.filter(call => call.target !== "spin");
  assert.ok(first.length > 0);
  first.slice(0, -1).forEach(call => call.resolve());
  await flush();
  assert.equal(h.calls.length, first.length + 1);
  first.at(-1)!.resolve();
  await flush();
  const second = h.calls.slice(first.length + 1);
  assert.ok(second.length > 0);
  assert.notEqual(second[0]!.target, first[0]!.target);
  assert.equal(h.calls.filter(call => call.target === "spin").length, 1);
  h.controller.dispose();
  await flush();
  assert.ok(h.calls.every(call => call.cancelled));
  assert.equal(h.warnings(), 0);
});

test("disposal fences completion and cancellation does not restart or warn", async () => {
  const h = harness();
  h.controller.start();
  const count = h.calls.length;
  h.calls.forEach(call => call.resolve());
  h.controller.dispose();
  await flush();
  assert.equal(h.calls.length, count);
  assert.equal(h.warnings(), 0);
});

test("unexpected animation rejection stops all motion and warns once", async () => {
  const h = harness();
  h.controller.start();
  assert.ok(h.calls.length > 0);
  h.calls[0]!.reject(new Error("animation failure"));
  await flush();
  assert.ok(h.calls.every(call => call.cancelled));
  assert.equal(h.warnings(), 1);
});
