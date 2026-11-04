/* Exports: none. Protect per-provider rule edits and when each rule makes compaction due. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { THREAD_AUTO_COMPACT_DEFAULTS, ThreadAutoCompactRules } from "./thread-auto-compact.ts";

const { claude, codex } = THREAD_AUTO_COMPACT_DEFAULTS;

test("raising the idle threshold carries the turn-end threshold, and a lower turn-end is held at the idle one", () => {
  assert.deepEqual(ThreadAutoCompactRules.apply(claude, { tokenThreshold: 600_000 }).turnEndTokenThreshold, 600_000);
  assert.deepEqual(ThreadAutoCompactRules.apply(claude, { turnEndTokenThreshold: 100_000 }).turnEndTokenThreshold, 200_000);
  assert.deepEqual(ThreadAutoCompactRules.apply(codex, { turnEndTokenThreshold: 100_000 }).turnEndTokenThreshold, 100_000);
});

test("a provider without an idle rule refuses idle edits", () => {
  assert.throws(() => ThreadAutoCompactRules.apply(codex, { idleMinutes: 30 }), /no idle compaction rule/);
  assert.throws(() => ThreadAutoCompactRules.apply(codex, { tokenThreshold: 200_000 }), /no idle compaction rule/);
});

test("a turn ending over the turn-end threshold is due at once; otherwise only the idle rule applies, after its idle time", () => {
  const evidence = (contextTokens: number | null) => ({ activityAt: 1_000, contextTokens });
  assert.deepEqual(ThreadAutoCompactRules.timing(claude, evidence(500_000)), { rule: "turnEnd", dueAt: 1_000 });
  assert.deepEqual(ThreadAutoCompactRules.timing(claude, evidence(300_000)), { rule: "idle", dueAt: 1_000 + 60 * 60_000 });
  assert.equal(ThreadAutoCompactRules.timing(claude, evidence(100_000)), null);
  assert.equal(ThreadAutoCompactRules.timing(codex, evidence(300_000)), null, "codex has no idle rule");
  assert.deepEqual(ThreadAutoCompactRules.timing(codex, evidence(500_000)), { rule: "turnEnd", dueAt: 1_000 });
  assert.equal(ThreadAutoCompactRules.timing({ ...claude, enabled: false }, evidence(900_000)), null);
  assert.equal(ThreadAutoCompactRules.timing(undefined, evidence(900_000)), null, "a provider without rules never compacts");
  assert.equal(ThreadAutoCompactRules.timing(claude, evidence(null)), null);
});
