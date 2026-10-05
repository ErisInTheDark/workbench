/* Exports: none. Protect ordered daemon field edits, late replies and visible persistence failures. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_THREAD_AUTO_COMPACT_SETTINGS } from "workbench-shared/workbench/settings/thread-auto-compact";
import ThreadAutoCompactSettingsController from "./ThreadAutoCompactSettingsController";

test("edits persist in order and keep unrelated thresholds when the checkbox changes", async () => {
  let stored = { ...DEFAULT_THREAD_AUTO_COMPACT_SETTINGS };
  const firstStarted = Promise.withResolvers<void>();
  const firstDone = Promise.withResolvers<void>();
  const updates: Array<Partial<typeof stored>> = [];
  const owner = new ThreadAutoCompactSettingsController({
    read: async () => ({ settings: stored }),
    update: async ({ settings }) => {
      updates.push(settings);
      if (updates.length === 1) { firstStarted.resolve(); await firstDone.promise; }
      stored = { ...stored, ...settings };
      return { settings: stored };
    },
  });
  await owner.load();
  const first = owner.update({ tokenThreshold: 250_000 });
  await firstStarted.promise;
  const second = owner.update({ enabled: false });
  assert.equal(updates.length, 1);
  firstDone.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(owner.getSnapshot().settings, { enabled: false, tokenThreshold: 250_000, idleMinutes: 30 });
  owner.dispose();
});

test("a retired settings selection ignores its outstanding load", async () => {
  const started = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<{ settings: typeof DEFAULT_THREAD_AUTO_COMPACT_SETTINGS }>();
  const owner = new ThreadAutoCompactSettingsController({
    read: () => { started.resolve(); return reply.promise; },
    update: async () => ({ settings: DEFAULT_THREAD_AUTO_COMPACT_SETTINGS }),
  });
  const load = owner.load();
  await started.promise;
  owner.dispose();
  reply.resolve({ settings: DEFAULT_THREAD_AUTO_COMPACT_SETTINGS });
  await load;
  assert.equal(owner.getSnapshot().settings, null);
});

test("failed saves retain confirmed settings and publish an actionable error", async () => {
  const owner = new ThreadAutoCompactSettingsController({
    read: async () => ({ settings: DEFAULT_THREAD_AUTO_COMPACT_SETTINGS }),
    update: async () => { throw new Error("save failed"); },
  });
  await owner.load();
  await owner.update({ enabled: false });
  assert.deepEqual(owner.getSnapshot().settings, DEFAULT_THREAD_AUTO_COMPACT_SETTINGS);
  assert.match(owner.getSnapshot().error, /save failed/);
  owner.dispose();
});
