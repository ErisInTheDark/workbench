/*
 * No exports. Tests protect shared per-interval tickers that run only while subscribed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTimeSource } from "./use-time.ts";

function fakeClock() {
  let now = 1_000;
  let nextHandle = 1;
  const timers = new Map<number, { intervalMs: number; tick: () => void }>();
  const source = createTimeSource({
    clearInterval: (handle) => { timers.delete(handle); },
    now: () => now,
    setInterval: (tick, intervalMs) => { timers.set(nextHandle, { intervalMs, tick }); return nextHandle++; },
  });
  const advance = (intervalMs: number, by: number) => {
    now += by;
    for (const timer of [...timers.values()]) if (timer.intervalMs === intervalMs) timer.tick();
  };
  return { advance, source, timers };
}

test("callers on one interval share a ticker that stops with its last subscriber", () => {
  const { advance, source, timers } = fakeClock();
  const seen: number[] = [];
  const first = source.subscribe(30_000, () => seen.push(source.read(30_000)));
  const second = source.subscribe(30_000, () => seen.push(source.read(30_000)));
  assert.equal(timers.size, 1);
  advance(30_000, 30_000);
  assert.deepEqual(seen, [31_000, 31_000]);
  first();
  assert.equal(timers.size, 1);
  second();
  assert.equal(timers.size, 0);
});

test("different intervals tick independently", () => {
  const { advance, source, timers } = fakeClock();
  let fast = 0;
  let slow = 0;
  source.subscribe(1_000, () => { fast += 1; });
  source.subscribe(60_000, () => { slow += 1; });
  assert.equal(timers.size, 2);
  advance(1_000, 1_000);
  assert.deepEqual([fast, slow], [1, 0]);
});
