/* Exports: none; protects that upstream fetch freshness tightens with focus and backs off on failure without stalling forever. */
import assert from "node:assert/strict";
import test from "node:test";
import { isUpstreamFetchDue, upstreamFetchTtl } from "./upstream-fetch-schedule";

test("a never-fetched repository is due at any focus", () => {
  for (const focus of ["ambient", "focused"] as const) {
    assert.equal(isUpstreamFetchDue({ focus, fetchedAt: null, failures: 0, now: 0 }), true);
  }
});

test("focused observation comes due before ambient observation from the same fetch", () => {
  const now = upstreamFetchTtl("focused", 0);
  assert.equal(isUpstreamFetchDue({ focus: "focused", fetchedAt: 0, failures: 0, now }), true);
  assert.equal(isUpstreamFetchDue({ focus: "ambient", fetchedAt: 0, failures: 0, now }), false);
});

test("failures stretch the ttl monotonically up to a cap", () => {
  for (const focus of ["ambient", "focused"] as const) {
    const ttls = [0, 1, 2, 3, 10, 40].map(failures => upstreamFetchTtl(focus, failures));
    for (let index = 1; index < ttls.length; index++) assert.ok(ttls[index]! >= ttls[index - 1]!);
    assert.ok(ttls[1]! > ttls[0]!);
    assert.equal(ttls.at(-1), ttls.at(-2));
    assert.ok(Number.isFinite(ttls.at(-1)));
  }
});
