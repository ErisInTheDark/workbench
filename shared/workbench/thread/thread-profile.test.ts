/*
 * Exports: none. Protect exact profile settings across catalogue and target boundaries.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchComposerProfile, WorkbenchComposerSettings } from "../../types.ts";
import { normalizeComposerProfile, normalizeComposerProfileMutation } from "../state/composer-profile-state.ts";
import { WorkbenchComposerProfileSelectionSchema } from "./thread-state.ts";
import { contextCompactionThreshold, copyComposerSettings, resolveLinkedProfileSelection } from "./thread-profile.ts";

test("compaction reserves fixed headroom for small windows and proportional headroom for large ones", () => {
  assert.equal(contextCompactionThreshold(128_000), 78_000);
  assert.equal(contextCompactionThreshold(500_000), 450_000);
  assert.equal(contextCompactionThreshold(872_000), 784_800);
});

test("context caps survive catalogue normalization and target snapshots", () => {
  const settings = {
    agentPath: null, agentSource: null, harness: "codex", model: "test-model",
    reasoningEffort: "high", serviceTier: null, contextWindowTokens: 500_000,
  };
  const profile = {
    ...settings, id: "stored", name: "Stored", scope: { kind: "global" }, createdAt: 1, updatedAt: 1,
  };
  const normalized = normalizeComposerProfile(profile);
  assert.ok(normalized);
  assert.equal(Reflect.get(normalized, "contextWindowTokens"), settings.contextWindowTokens);
  const selection = WorkbenchComposerProfileSelectionSchema.parse({
    kind: "profile", profileId: profile.id, settings,
  });
  assert.deepEqual(selection.settings, settings);
  const mutation = normalizeComposerProfileMutation({
    kind: "upsert", profile, changes: { contextWindowTokens: 600_000 },
  });
  assert.ok(mutation && mutation.kind === "upsert");
  assert.deepEqual(mutation.changes, { contextWindowTokens: 600_000 });
});

test("repairs legacy OpenCode context caps without changing Codex settings", () => {
  const settings = {
    agentPath: null, agentSource: null, harness: "opencode" as const, model: "opencode-go/model",
    reasoningEffort: null, serviceTier: null, contextWindowTokens: 200_000,
  };
  const normalized = normalizeComposerProfile({
    ...settings, id: "stored", name: "Stored", scope: { kind: "global" }, createdAt: 1, updatedAt: 1,
  });

  assert.ok(normalized);
  assert.equal(Reflect.has(normalized, "contextWindowTokens"), false);
  assert.equal(Reflect.has(copyComposerSettings(settings), "contextWindowTokens"), false);
  assert.equal(copyComposerSettings({ ...settings, harness: "codex" }).contextWindowTokens, 200_000);
});

test("linked selections resolve current definitions and keep saved settings only as Custom", () => {
  const current: WorkbenchComposerSettings = {
    agentPath: null, agentSource: null, harness: "opencode", model: "current-model",
    reasoningEffort: null, serviceTier: null,
  };
  const profiles: WorkbenchComposerProfile[] = [
    { ...current, id: "linked", name: "Linked", scope: { kind: "global" }, createdAt: 1, updatedAt: 2 },
  ];
  const saved: WorkbenchComposerSettings = { ...current, harness: "codex", model: "saved-model" };
  assert.deepEqual(resolveLinkedProfileSelection(profiles, { profileId: "linked", settings: saved }),
    { kind: "profile", profileId: "linked", settings: current });
  assert.deepEqual(resolveLinkedProfileSelection(profiles, { profileId: "gone", settings: saved }),
    { kind: "custom", settings: saved });
  assert.deepEqual(resolveLinkedProfileSelection(profiles, { profileId: "linked", settings: saved }, { harness: "codex" }),
    { kind: "custom", settings: saved });
  assert.equal(resolveLinkedProfileSelection(profiles, { profileId: "gone", settings: null }), null);
});
