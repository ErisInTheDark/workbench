/*
 * Exports: none. Protect exact profile settings across catalogue and target boundaries.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchComposerProfile, WorkbenchComposerSettings } from "../../types.ts";
import { normalizeComposerProfile, normalizeComposerProfileMutation } from "../state/composer-profile-state.ts";
import { WorkbenchComposerProfileSelectionSchema } from "./thread-state.ts";
import {
  contextCompactionThreshold, copyComposerSettings, isSelectableContextWindow, resolveLinkedProfileSelection,
  WorkbenchModelContextCapabilitySchema,
} from "./thread-profile.ts";

test("compaction reserves fixed headroom for small windows and proportional headroom for large ones", () => {
  assert.equal(contextCompactionThreshold(128_000), 78_000);
  assert.equal(contextCompactionThreshold(500_000), 450_000);
  assert.equal(contextCompactionThreshold(872_000), 784_800);
});

test("a context floor below the default widens selectable windows; without one the default stays the floor", () => {
  const nativeDefault = { defaultTokens: 1_000_000, minimumTokens: 200_000, maximumTokens: 1_000_000 };
  assert.ok(isSelectableContextWindow(nativeDefault, 200_000));
  assert.ok(isSelectableContextWindow(nativeDefault, 401_000));
  assert.ok(!isSelectableContextWindow(nativeDefault, 199_000));
  assert.ok(!isSelectableContextWindow(nativeDefault, 200_500));
  const defaultFloor = { defaultTokens: 272_000, maximumTokens: 1_000_000 };
  assert.ok(isSelectableContextWindow(defaultFloor, 273_000));
  assert.ok(!isSelectableContextWindow(defaultFloor, 200_000));
  assert.ok(!WorkbenchModelContextCapabilitySchema.safeParse({ model: "m", ...nativeDefault, minimumTokens: 1_001_000 }).success,
    "a floor above the default is not a capability");
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

test("OpenCode context caps survive profile normalization and copying", () => {
  const settings = {
    agentPath: null, agentSource: null, harness: "opencode" as const, model: "opencode-go/model",
    reasoningEffort: null, serviceTier: null, contextWindowTokens: 200_000,
  };
  const normalized = normalizeComposerProfile({
    ...settings, id: "stored", name: "Stored", scope: { kind: "global" }, createdAt: 1, updatedAt: 1,
  });

  assert.ok(normalized);
  assert.equal(normalized.contextWindowTokens, 200_000);
  assert.equal(copyComposerSettings(settings).contextWindowTokens, 200_000);
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
