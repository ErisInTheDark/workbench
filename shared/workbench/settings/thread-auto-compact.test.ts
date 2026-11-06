/* Exports: none. Protect per-provider rule edits, which cause a thread's size and idleness make compaction due for, and when that answer changes. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { THREAD_AUTO_COMPACT_DEFAULTS, ThreadAutoCompactRules } from "./thread-auto-compact.ts";

test("raising the idle threshold carries the turn-end threshold, and a lower turn-end is held at the idle one", () => {
  const { claude, codex } = THREAD_AUTO_COMPACT_DEFAULTS;
  assert.deepEqual(ThreadAutoCompactRules.apply(claude, { tokenThreshold: 600_000 }).turnEndTokenThreshold, 600_000);
  assert.deepEqual(ThreadAutoCompactRules.apply(claude, { turnEndTokenThreshold: 100_000 }).turnEndTokenThreshold, 200_000);
  assert.deepEqual(ThreadAutoCompactRules.apply(codex, { turnEndTokenThreshold: 100_000 }).turnEndTokenThreshold, 100_000);
});

test("a provider without an idle rule refuses idle edits", () => {
  const { codex } = THREAD_AUTO_COMPACT_DEFAULTS;
  assert.throws(() => ThreadAutoCompactRules.apply(codex, { idleMinutes: 30 }), /no idle compaction rule/);
  assert.throws(() => ThreadAutoCompactRules.apply(codex, { tokenThreshold: 200_000 }), /no idle compaction rule/);
});

const MINUTE = 60_000;
const rules: ThreadAutoCompactRules = { enabled: true, idle: { tokenThreshold: 200_000, minutes: 60 }, turnEndTokenThreshold: 500_000 };
const assess = (contextTokens: number | null, now: number, prefixStale?: boolean) => (
  ThreadAutoCompactRules.assess(rules, { activityAt: 0, contextTokens }, now, prefixStale)
);

test("a small thread is never due, however idle", () => {
  assert.equal(assess(100_000, 500 * MINUTE), null);
  assert.equal(assess(null, 500 * MINUTE), null);
});

test("an idle-sized thread is due only once its cache expired or its prefix changed", () => {
  assert.deepEqual(assess(250_000, 59 * MINUTE), { cause: null, changesAt: 60 * MINUTE });
  assert.deepEqual(assess(250_000, 60 * MINUTE), { cause: "noCache", changesAt: null });
  assert.deepEqual(assess(250_000, MINUTE, true), { cause: "noCache", changesAt: null });
});

test("a big thread is too large while warm, then cold once its cache expires", () => {
  assert.deepEqual(assess(600_000, MINUTE), { cause: "tooMuchContext", changesAt: 60 * MINUTE });
  assert.deepEqual(assess(600_000, 60 * MINUTE), { cause: "noCache", changesAt: null });
  assert.deepEqual(assess(600_000, MINUTE, true), { cause: "noCache", changesAt: null });
});

test("a provider whose cache never expires only ever compacts for size, and disabled rules never do", () => {
  const codex: ThreadAutoCompactRules = { enabled: true, idle: null, turnEndTokenThreshold: 500_000 };
  assert.deepEqual(ThreadAutoCompactRules.assess(codex, { activityAt: 0, contextTokens: 600_000 }, 500 * MINUTE), { cause: "tooMuchContext", changesAt: null });
  assert.equal(ThreadAutoCompactRules.assess(codex, { activityAt: 0, contextTokens: 300_000 }, 500 * MINUTE), null);
  assert.equal(ThreadAutoCompactRules.assess({ ...rules, enabled: false }, { activityAt: 0, contextTokens: 600_000 }, 500 * MINUTE), null);
  assert.equal(ThreadAutoCompactRules.assess(undefined, { activityAt: 0, contextTokens: 600_000 }, 500 * MINUTE), null, "a provider without rules never compacts");
});
