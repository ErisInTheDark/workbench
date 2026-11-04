/* Exports: none. Protect ordered per-provider daemon edits, late replies and visible persistence failures. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { THREAD_AUTO_COMPACT_DEFAULTS, ThreadAutoCompactRules, type ThreadAutoCompactUpdate } from "workbench-shared/workbench/settings/thread-auto-compact";
import ThreadAutoCompactSettingsController from "./ThreadAutoCompactSettingsController";

const store = (initial = THREAD_AUTO_COMPACT_DEFAULTS) => {
  let stored = initial;
  return {
    get: () => stored,
    apply: ({ provider, settings }: ThreadAutoCompactUpdate) => {
      stored = { ...stored, [provider]: ThreadAutoCompactRules.apply(stored[provider], settings) };
      return { settings: stored };
    },
  };
};

test("edits persist in order and keep unrelated providers and thresholds when a checkbox changes", async () => {
  const daemon = store();
  const firstStarted = Promise.withResolvers<void>();
  const firstDone = Promise.withResolvers<void>();
  const updates: ThreadAutoCompactUpdate[] = [];
  const owner = new ThreadAutoCompactSettingsController({
    read: async () => ({ settings: daemon.get() }),
    update: async edit => {
      updates.push(edit);
      if (updates.length === 1) { firstStarted.resolve(); await firstDone.promise; }
      return daemon.apply(edit);
    },
  });
  await owner.load();
  const first = owner.update("claude", { tokenThreshold: 600_000 });
  await firstStarted.promise;
  const second = owner.update("claude", { enabled: false });
  assert.equal(updates.length, 1);
  assert.deepEqual(owner.getSnapshot().settings?.claude.turnEndTokenThreshold, 600_000, "the shown turn-end follows the idle threshold up");
  firstDone.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(owner.getSnapshot().settings, {
    ...THREAD_AUTO_COMPACT_DEFAULTS,
    claude: { enabled: false, idle: { tokenThreshold: 600_000, minutes: 60 }, turnEndTokenThreshold: 600_000 },
  });
  owner.dispose();
});

test("queued edits show immediately and a failed edit falls back without dropping later ones", async () => {
  const gate = Promise.withResolvers<void>();
  const daemon = store();
  const owner = new ThreadAutoCompactSettingsController({
    read: async () => ({ settings: daemon.get() }),
    update: async edit => {
      await gate.promise;
      if (edit.settings.idleMinutes) throw new Error("idle refused");
      return daemon.apply(edit);
    },
  });
  await owner.load();
  const first = owner.update("opencode", { idleMinutes: 60 });
  const second = owner.update("codex", { turnEndTokenThreshold: 300_000 });
  const codex = { ...THREAD_AUTO_COMPACT_DEFAULTS.codex, turnEndTokenThreshold: 300_000 };
  assert.deepEqual(owner.getSnapshot().settings, {
    ...THREAD_AUTO_COMPACT_DEFAULTS, codex,
    opencode: { ...THREAD_AUTO_COMPACT_DEFAULTS.opencode, idle: { tokenThreshold: 200_000, minutes: 60 } },
  });
  gate.resolve();
  await first;
  assert.match(owner.getSnapshot().error, /idle refused/);
  assert.deepEqual(owner.getSnapshot().settings, { ...THREAD_AUTO_COMPACT_DEFAULTS, codex });
  await second;
  assert.deepEqual(owner.getSnapshot().settings, { ...THREAD_AUTO_COMPACT_DEFAULTS, codex });
  owner.dispose();
});

test("a retired settings selection ignores its outstanding load", async () => {
  const started = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<{ settings: typeof THREAD_AUTO_COMPACT_DEFAULTS }>();
  const owner = new ThreadAutoCompactSettingsController({
    read: () => { started.resolve(); return reply.promise; },
    update: async () => ({ settings: THREAD_AUTO_COMPACT_DEFAULTS }),
  });
  const load = owner.load();
  await started.promise;
  owner.dispose();
  reply.resolve({ settings: THREAD_AUTO_COMPACT_DEFAULTS });
  await load;
  assert.equal(owner.getSnapshot().settings, null);
});

test("failed saves retain confirmed settings and publish an actionable error", async () => {
  const owner = new ThreadAutoCompactSettingsController({
    read: async () => ({ settings: THREAD_AUTO_COMPACT_DEFAULTS }),
    update: async () => { throw new Error("save failed"); },
  });
  await owner.load();
  await owner.update("claude", { enabled: false });
  assert.deepEqual(owner.getSnapshot().settings, THREAD_AUTO_COMPACT_DEFAULTS);
  assert.match(owner.getSnapshot().error, /save failed/);
  owner.dispose();
});
