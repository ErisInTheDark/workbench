/*
 * Tests:
 * - WorkbenchComposerProfileController profile scope, selection, materialization, immutable harness, promotion, and deletion fallback behavior. Keywords: composer, profile, controller, persistence, regression.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type {
  ThreadPayload,
  WorkbenchComposerProfile,
  WorkbenchComposerProfileMutation,
  WorkbenchComposerSettings,
} from "../../types";
import type { ComposerProfilePersistence } from "./composer-profile-api";
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

class MemoryPersistence implements ComposerProfilePersistence {
  readonly imported: WorkbenchComposerProfile[][] = [];
  readonly mutations: WorkbenchComposerProfileMutation[] = [];
  profiles: WorkbenchComposerProfile[] = [];

  async importLegacy(profiles: WorkbenchComposerProfile[]) {
    this.imported.push(profiles);
    this.profiles = profiles;
    return { profiles: this.profiles };
  }

  async mutate(mutation: WorkbenchComposerProfileMutation) {
    this.mutations.push(mutation);
    this.profiles = mutation.kind === "delete"
      ? this.profiles.filter((profile) => profile.id !== mutation.profileId)
      : [...this.profiles.filter((profile) => profile.id !== mutation.profile.id), mutation.profile];
    return { profiles: this.profiles };
  }

  async read() {
    return { profiles: this.profiles };
  }
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("Timed out waiting for profile persistence.");
}

const CODEX_SETTINGS: WorkbenchComposerSettings = {
  agentPath: "library:agents/lily.md",
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

test("profile descriptions preserve multiline text and clear to an absent optional field", () => {
  const controller = new WorkbenchComposerProfileController(new MemoryStorage());
  const profile = controller.createProfile({
    ...CODEX_SETTINGS,
    description: "  Use for implementation reviews.\r\nDo not use for quick searches.  ",
    name: "Described Lily",
    scope: { kind: "global" },
  });

  assert.equal(profile.description, "Use for implementation reviews.\nDo not use for quick searches.");
  const cleared = controller.updateProfile(profile.id, { description: " \r\n " });
  assert.equal(cleared && "description" in cleared, false);
  controller.dispose();
});

test("imports legacy profiles once, flushes the mutation outbox, and notifies subscribers", async () => {
  const storage = new MemoryStorage();
  const controller = new WorkbenchComposerProfileController(storage);
  const profile = controller.createProfile({ ...CODEX_SETTINGS, name: "Durable Lily", scope: { kind: "global" } });
  const persistence = new MemoryPersistence();
  let notifications = 0;
  controller.subscribe(() => { notifications += 1; });

  await controller.initializePersistence(persistence);
  await waitFor(() => persistence.mutations.length === 1);
  assert.deepEqual(persistence.imported, [[profile]]);
  assert.deepEqual(persistence.mutations, [{ kind: "upsert", profile }]);
  assert.equal(storage.getItem("workbench:composer-profiles:disk-v1"), "complete");
  assert.ok(notifications >= 1);
  controller.dispose();
});

test("profile resolution preserves the thread payload contract", () => {
  const controller = new WorkbenchComposerProfileController(new MemoryStorage());
  const slot = { kind: "new-thread" as const, projectId: "project-a" };
  const profile = controller.createProfile({ ...CODEX_SETTINGS, name: "Thread-safe Lily", scope: { kind: "global" } });
  controller.selectProfile(slot, profile.id);
  const resolved = controller.resolveThread(slot, {
    agentNickname: null,
    agentPath: null,
    agentRole: null,
    browseResultEntries: [],
    createdAt: 1,
    cwd: "C:/workspace",
    forkedFromId: null,
    harness: "codex",
    id: "draft:1",
    isDraft: true,
    model: "gpt-5.4",
    name: "Draft",
    preview: "",
    path: null,
    reasoningEffort: null,
    serviceTier: null,
    source: "codex",
    status: "idle",
    tokenUsage: null,
    turnHistory: [],
    turns: [],
    updatedAt: 1,
  } satisfies ThreadPayload);

  assert.equal("profileId" in resolved, false);
  assert.equal("scope" in resolved, false);
  assert.equal("updatedAt" in resolved, true);
  controller.dispose();
});

test("resolves a hydrated subagent's current profile effort without crossing harnesses", () => {
  const controller = new WorkbenchComposerProfileController(new MemoryStorage());
  const profile = controller.createProfile({ ...CODEX_SETTINGS, name: "Medium Lily", reasoningEffort: "medium", scope: { kind: "global" } });

  assert.equal(controller.getProfileReasoningEffort(profile.id, "codex"), "medium");
  assert.equal(controller.getProfileReasoningEffort(profile.id, "opencode"), null);
  assert.equal(controller.getProfileReasoningEffort("missing-profile", "codex"), null);
  controller.dispose();
});

test("keeps UUID draft profile slots isolated and harness-bound", () => {
  const controller = new WorkbenchComposerProfileController(new MemoryStorage());
  const profile = controller.createProfile({ ...CODEX_SETTINGS, name: "Draft profile", scope: { kind: "global" } });
  const first = { draftId: "11111111-1111-4111-8111-111111111111", harness: "codex" as const, kind: "draft" as const, projectId: "project-a" };
  const second = { ...first, draftId: "22222222-2222-4222-8222-222222222222" };

  assert.equal(controller.selectProfile(first, profile.id), true);
  assert.deepEqual(controller.getSelection(first), { kind: "profile", profileId: profile.id });
  assert.deepEqual(controller.getSelection(second), { kind: "custom" });
  assert.equal(controller.selectProfile({ ...first, harness: "opencode" }, profile.id), false);
  controller.dispose();
});
