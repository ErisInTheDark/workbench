/*
 * Tests:
 * - WorkbenchComposerProfileController profile scope, selection, materialization, immutable harness, promotion, and deletion fallback behavior. Keywords: composer, profile, controller, persistence, regression.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { WorkbenchComposerSettings } from "../../types";
import WorkbenchComposerProfileController from "./WorkbenchComposerProfileController";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const CODEX_SETTINGS: WorkbenchComposerSettings = {
  agentPath: "agent://lily.md",
  agentSource: "library",
  harness: "codex",
  model: "gpt-5.4",
  reasoningEffort: "high",
  serviceTier: "fast",
};

test("scope changes retain stable ids and preserve hidden out-of-scope links", () => {
  const controller = new WorkbenchComposerProfileController(new MemoryStorage());
  const sourceSlot = { kind: "new-thread" as const, projectId: "project-b" };
  const profile = controller.createProfile({
    ...CODEX_SETTINGS,
    name: "Lily",
    scope: { kind: "global" },
  });
  controller.selectProfile(sourceSlot, profile.id);

  const demoted = controller.updateProfile(profile.id, { scope: { kind: "project", projectId: "project-a" } });
  assert.equal(demoted?.id, profile.id);
  assert.deepEqual(controller.getVisibleProfiles("project-b"), []);
  assert.equal(controller.getSelectedProfile(sourceSlot)?.id, profile.id);
  assert.equal(controller.resolveSettings(sourceSlot, null)?.model, "gpt-5.4");
  controller.dispose();
});

test("materialization copies only compatible profile links to the destination thread", () => {
  const controller = new WorkbenchComposerProfileController(new MemoryStorage());
  const sourceSlot = { kind: "new-thread" as const, projectId: "project-a" };
  const profile = controller.createProfile({
    ...CODEX_SETTINGS,
    name: "Fast Lily",
    scope: { kind: "project", projectId: "project-a" },
  });
  controller.selectProfile(sourceSlot, profile.id);

  controller.materializeSelection(sourceSlot, "thread-a", "codex");
  controller.materializeSelection(sourceSlot, "thread-b", "copilot");
  assert.equal(controller.getSelectedProfile({ harness: "codex", kind: "thread", threadId: "thread-a" })?.id, profile.id);
  assert.equal(controller.getSelection({ harness: "copilot", kind: "thread", threadId: "thread-b" }).kind, "custom");
  assert.equal(controller.selectProfile({ harness: "copilot", kind: "thread", threadId: "thread-c" }, profile.id), false);
  controller.dispose();
});

test("profile harness is immutable and project agents cannot be promoted globally", () => {
  const controller = new WorkbenchComposerProfileController(new MemoryStorage());
  const profile = controller.createProfile({
    ...CODEX_SETTINGS,
    agentPath: ".agents/agents/project.md",
    agentSource: "project",
    name: "Project agent",
    scope: { kind: "project", projectId: "project-a" },
  });

  const updated = controller.updateProfile(profile.id, { harness: "copilot" } as never);
  assert.equal(updated?.harness, "codex");
  assert.throws(() => controller.updateProfile(profile.id, { scope: { kind: "global" } }), /project agent/i);
  controller.dispose();
});

test("deleting a linked profile preserves its last settings as a pending custom handoff", () => {
  const controller = new WorkbenchComposerProfileController(new MemoryStorage());
  const slot = { harness: "codex" as const, kind: "thread" as const, threadId: "thread-a" };
  const profile = controller.createProfile({
    ...CODEX_SETTINGS,
    name: "Disposable",
    scope: { kind: "global" },
  });
  controller.selectProfile(slot, profile.id);

  controller.deleteProfile(profile.id);
  const selection = controller.getSelection(slot);
  assert.equal(selection.kind, "custom");
  assert.deepEqual(selection.kind === "custom" ? selection.pendingSettings : null, CODEX_SETTINGS);
  controller.acknowledgePendingSettings(slot);
  assert.deepEqual(controller.getSelection(slot), { kind: "custom" });
  controller.dispose();
});

test("invalid persisted data normalizes to an empty usable registry", () => {
  const storage = new MemoryStorage();
  storage.setItem("workbench:composer-profiles", "{not-json");
  const controller = new WorkbenchComposerProfileController(storage);
  assert.deepEqual(controller.getSnapshot(), { profiles: [], selections: {} });
  controller.dispose();
});

test("unnamed profiles survive persistence and remain unnamed", () => {
  const storage = new MemoryStorage();
  const controller = new WorkbenchComposerProfileController(storage);
  const profile = controller.createProfile({ ...CODEX_SETTINGS, name: "", scope: { kind: "global" } });
  assert.equal(profile.name, "");
  controller.dispose();
  const reloaded = new WorkbenchComposerProfileController(storage);
  assert.equal(reloaded.getProfile(profile.id)?.name, "");
  reloaded.dispose();
});
