/*
 * Tests:
 * - WorkbenchComposerProfileController keeps daemon-owned definitions acknowledged and app-owned selections durable. Keywords: composer, profile, controller, daemon, app state, regression.
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
import WorkbenchClientStateController from "./WorkbenchClientStateController";
import WorkbenchComposerProfileController from "./WorkbenchComposerProfileController";

class MemoryPersistence implements ComposerProfilePersistence {
  failMutations = false;
  profiles: WorkbenchComposerProfile[];

  constructor(profiles: WorkbenchComposerProfile[] = []) {
    this.profiles = profiles;
  }

  async mutate(mutation: WorkbenchComposerProfileMutation) {
    if (this.failMutations) throw new Error("Daemon rejected the profile mutation.");
    this.profiles = mutation.kind === "delete"
      ? this.profiles.filter((profile) => profile.id !== mutation.profileId)
      : [...this.profiles.filter((profile) => profile.id !== mutation.profile.id), mutation.profile];
    return { profiles: this.profiles };
  }

  async read() {
    return { profiles: this.profiles };
  }
}

const CODEX_SETTINGS: WorkbenchComposerSettings = {
  agentPath: "library:agents/lily.md",
  agentSource: "library",
  harness: "codex",
  model: "gpt-5.4",
  reasoningEffort: "high",
  serviceTier: "fast",
};

function profile(overrides: Partial<WorkbenchComposerProfile> = {}): WorkbenchComposerProfile {
  return {
    ...CODEX_SETTINGS,
    createdAt: 1,
    id: "profile-a",
    name: "Lily",
    scope: { kind: "global" },
    updatedAt: 1,
    ...overrides,
  };
}

async function createController(initialProfiles: WorkbenchComposerProfile[] = []) {
  const clientStateController = new WorkbenchClientStateController({ mode: "memory" });
  const persistence = new MemoryPersistence(initialProfiles);
  const controller = new WorkbenchComposerProfileController(clientStateController);
  await controller.initializePersistence(persistence);
  return { clientStateController, controller, persistence };
}

test("scope changes retain stable ids and preserve hidden out-of-scope links", async () => {
  const { controller } = await createController();
  const sourceSlot = { kind: "new-thread" as const, projectId: "project-b" };
  const created = await controller.createProfile({
    ...CODEX_SETTINGS,
    name: "Lily",
    scope: { kind: "global" },
  });
  assert.ok(created);
  controller.selectProfile(sourceSlot, created.id);

  const demoted = await controller.updateProfile(created.id, { scope: { kind: "project", projectId: "project-a" } });
  assert.equal(demoted?.id, created.id);
  assert.deepEqual(controller.getVisibleProfiles("project-b"), []);
  assert.equal(controller.getSelectedProfile(sourceSlot)?.id, created.id);
  assert.equal(controller.resolveSettings(sourceSlot, null)?.model, "gpt-5.4");
  controller.dispose();
});

test("materialization copies only compatible profile links to durable destination slots", async () => {
  const sourceSlot = { kind: "new-thread" as const, projectId: "project-a" };
  const { clientStateController, controller } = await createController([profile()]);
  controller.selectProfile(sourceSlot, "profile-a");

  controller.materializeSelection(sourceSlot, "thread-a", "codex");
  controller.materializeSelection(sourceSlot, "thread-b", "copilot");
  assert.equal(controller.getSelectedProfile({ harness: "codex", kind: "thread", threadId: "thread-a" })?.id, "profile-a");
  assert.equal(controller.getSelection({ harness: "copilot", kind: "thread", threadId: "thread-b" }).kind, "custom");
  assert.equal(controller.selectProfile({ harness: "copilot", kind: "thread", threadId: "thread-c" }, "profile-a"), false);
  assert.equal(clientStateController.records("threadProfilePreference").length, 1);
  controller.dispose();
});

test("profile harness is immutable and project agents cannot be promoted globally", async () => {
  const projectProfile = profile({
    agentPath: ".agents/agents/project.md",
    agentSource: "project",
    scope: { kind: "project", projectId: "project-a" },
  });
  const { controller } = await createController([projectProfile]);

  const updated = await controller.updateProfile(projectProfile.id, { harness: "copilot" } as never);
  assert.equal(updated?.harness, "codex");
  const rejected = await controller.updateProfile(projectProfile.id, { scope: { kind: "global" } });
  assert.equal(rejected, null);
  assert.match(controller.getSnapshot().error, /project agent/i);
  assert.deepEqual(controller.getProfile(projectProfile.id)?.scope, { kind: "project", projectId: "project-a" });
  controller.dispose();
});

test("deleting a linked profile preserves its last settings as a durable custom handoff", async () => {
  const slot = { harness: "codex" as const, kind: "thread" as const, threadId: "thread-a" };
  const { clientStateController, controller } = await createController([profile()]);
  controller.selectProfile(slot, "profile-a");

  await controller.deleteProfile("profile-a");
  const selection = controller.getSelection(slot);
  assert.equal(selection.kind, "custom");
  assert.deepEqual(selection.kind === "custom" ? selection.pendingSettings : null, CODEX_SETTINGS);
  assert.equal(clientStateController.records("threadProfilePreference")[0]?.value.kind, "custom");
  controller.acknowledgePendingSettings(slot);
  assert.deepEqual(controller.getSelection(slot), { kind: "custom" });
  controller.dispose();
});

test("daemon mutation failure leaves the visible profile unchanged and exposes the error", async () => {
  const { controller, persistence } = await createController([profile()]);
  persistence.failMutations = true;

  const updated = await controller.updateProfile("profile-a", { name: "Changed" });
  assert.equal(updated, null);
  assert.equal(controller.getProfile("profile-a")?.name, "Lily");
  assert.match(controller.getSnapshot().error, /daemon rejected/i);
  controller.dispose();
});

test("profile descriptions preserve multiline text and clear to an absent optional field", async () => {
  const { controller } = await createController();
  const created = await controller.createProfile({
    ...CODEX_SETTINGS,
    description: "  Use for implementation reviews.\r\nDo not use for quick searches.  ",
    name: "Described Lily",
    scope: { kind: "global" },
  });
  assert.equal(created?.description, "Use for implementation reviews.\nDo not use for quick searches.");
  const cleared = created ? await controller.updateProfile(created.id, { description: " \r\n " }) : null;
  assert.equal(cleared && "description" in cleared, false);
  controller.dispose();
});

test("profile resolution preserves the thread payload contract", async () => {
  const slot = { kind: "new-thread" as const, projectId: "project-a" };
  const { controller } = await createController([profile()]);
  controller.selectProfile(slot, "profile-a");
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

test("draft profile slots remain UUID-isolated and harness-bound", async () => {
  const { controller } = await createController([profile()]);
  const first = { draftId: "11111111-1111-4111-8111-111111111111", harness: "codex" as const, kind: "draft" as const, projectId: "project-a" };
  const second = { ...first, draftId: "22222222-2222-4222-8222-222222222222" };

  assert.equal(controller.selectProfile(first, "profile-a"), true);
  assert.deepEqual(controller.getSelection(first), { kind: "profile", profileId: "profile-a" });
  assert.deepEqual(controller.getSelection(second), { kind: "custom" });
  assert.equal(controller.selectProfile({ ...first, harness: "opencode" }, "profile-a"), false);
  controller.dispose();
});
