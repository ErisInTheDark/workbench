/*
 * Tests:
 * - WorkbenchComposerProfileController keeps daemon-owned definitions and target snapshots acknowledged without stale-read rollback. Keywords: composer, profile, controller, daemon, regression.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type {
  ThreadPayload,
  WorkbenchComposerProfile,
  WorkbenchComposerProfileMutation,
  WorkbenchComposerProfileSlot,
  WorkbenchComposerProfileTargetSelection,
  WorkbenchComposerSettings,
} from "../../types";
import type { ComposerProfilePersistence, ComposerProfileTargetPersistence } from "./composer-profile-api";
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

class MemoryTargetPersistence implements ComposerProfileTargetPersistence {
  failWrites = false;
  readonly selections = new Map<string, WorkbenchComposerProfileTargetSelection>();
  private key(slot: WorkbenchComposerProfileSlot) { return JSON.stringify(slot); }
  async read(slot: WorkbenchComposerProfileSlot) { return this.selections.get(this.key(slot)) ?? null; }
  async write(slot: WorkbenchComposerProfileSlot, selection: WorkbenchComposerProfileTargetSelection) {
    if (this.failWrites) throw new Error("Daemon rejected the target mutation.");
    this.selections.set(this.key(slot), structuredClone(selection));
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
  const persistence = new MemoryPersistence(initialProfiles);
  const targets = new MemoryTargetPersistence();
  const controller = new WorkbenchComposerProfileController();
  controller.initializeTargetPersistence(targets);
  await controller.initializePersistence(persistence);
  return { controller, persistence, targets };
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
  const { controller, targets } = await createController([profile()]);
  controller.selectProfile(sourceSlot, "profile-a");
  await controller.synchronizeSelection(sourceSlot, CODEX_SETTINGS);

  controller.materializeSelection(sourceSlot, "thread-a", "codex");
  controller.materializeSelection(sourceSlot, "thread-b", "copilot");
  assert.equal(controller.getSelectedProfile({ harness: "codex", kind: "thread", projectId: "project-a", threadId: "thread-a" })?.id, "profile-a");
  assert.equal(controller.getSelection({ harness: "copilot", kind: "thread", projectId: "project-a", threadId: "thread-b" }).kind, "custom");
  assert.equal(controller.selectProfile({ harness: "copilot", kind: "thread", projectId: "project-a", threadId: "thread-c" }, "profile-a"), false);
  assert.equal(targets.selections.size, 1);
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
  const slot = { harness: "codex" as const, kind: "thread" as const, projectId: "project-a", threadId: "thread-a" };
  const { controller, targets } = await createController([profile()]);
  controller.selectProfile(slot, "profile-a");

  await controller.deleteProfile("profile-a");
  const selection = controller.getSelection(slot);
  assert.equal(selection.kind, "custom");
  assert.deepEqual(selection.kind === "custom" ? selection.settings : null, CODEX_SETTINGS);
  assert.equal([...targets.selections.values()][0]?.kind, "custom");
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
  assert.deepEqual(controller.getSelection(first), { kind: "profile", profileId: "profile-a", settings: CODEX_SETTINGS });
  assert.deepEqual(controller.getSelection(second), { kind: "custom" });
  assert.equal(controller.selectProfile({ ...first, harness: "opencode" }, "profile-a"), false);
  controller.dispose();
});

test("acknowledged tied profile edits update the composer before target synchronization", async () => {
  const slot = { kind: "new-thread" as const, projectId: "project-a" };
  const { controller, targets } = await createController([profile()]);
  controller.selectProfile(slot, "profile-a");
  await controller.synchronizeSelection(slot, CODEX_SETTINGS);
  assert.deepEqual(await targets.read(slot), {
    kind: "profile",
    profileId: "profile-a",
    settings: CODEX_SETTINGS,
  });

  await controller.updateProfile("profile-a", { model: "gpt-5.5", reasoningEffort: "medium" });
  assert.deepEqual(controller.resolveSettings(slot, null), {
    ...CODEX_SETTINGS,
    model: "gpt-5.5",
    reasoningEffort: "medium",
  });
  const synchronized = await controller.synchronizeSelection(slot, CODEX_SETTINGS);
  assert.deepEqual(synchronized, {
    kind: "profile",
    profileId: "profile-a",
    settings: { ...CODEX_SETTINGS, model: "gpt-5.5", reasoningEffort: "medium" },
  });
  assert.deepEqual(await targets.read(slot), synchronized);
  controller.dispose();
});

test("target synchronization preserves a tied snapshot while profile definitions are still loading", async () => {
  const slot = { kind: "new-thread" as const, projectId: "project-a" };
  const targets = new MemoryTargetPersistence();
  await targets.write(slot, {
    kind: "profile",
    profileId: "profile-a",
    settings: CODEX_SETTINGS,
  });
  let resolveProfiles: (value: { profiles: WorkbenchComposerProfile[] }) => void = () => undefined;
  const profiles = new Promise<{ profiles: WorkbenchComposerProfile[] }>((resolve) => { resolveProfiles = resolve; });
  const controller = new WorkbenchComposerProfileController();
  controller.initializeTargetPersistence(targets);
  const initialization = controller.initializePersistence({
    mutate: async () => ({ profiles: [] }),
    read: async () => await profiles,
  });

  await controller.loadSelection(slot);
  assert.deepEqual(await controller.synchronizeSelection(slot, CODEX_SETTINGS), {
    kind: "profile",
    profileId: "profile-a",
    settings: CODEX_SETTINGS,
  });

  resolveProfiles({ profiles: [profile()] });
  await initialization;
  controller.dispose();
});

test("late target reads cannot erase newer or materialized selections", async () => {
  const slot = { kind: "new-thread" as const, projectId: "project-a" };
  let resolveRead: (selection: WorkbenchComposerProfileTargetSelection | null) => void = () => undefined;
  const read = new Promise<WorkbenchComposerProfileTargetSelection | null>((resolve) => { resolveRead = resolve; });
  const persisted = new MemoryTargetPersistence();
  const controller = new WorkbenchComposerProfileController();
  controller.initializeTargetPersistence({
    read: async () => await read,
    write: async (target, selection) => await persisted.write(target, selection),
  });
  await controller.initializePersistence(new MemoryPersistence([profile()]));

  const loading = controller.loadSelection(slot);
  controller.selectCustom(slot, { ...CODEX_SETTINGS, model: "newer-model" });
  resolveRead({ kind: "custom", settings: { ...CODEX_SETTINGS, model: "stale-model" } });
  await loading;
  assert.equal(controller.resolveSettings(slot, null)?.model, "newer-model");
  await controller.synchronizeSelection(slot, CODEX_SETTINGS);

  const draftSlot = {
    draftId: "11111111-1111-4111-8111-111111111111",
    harness: "codex" as const,
    kind: "draft" as const,
    projectId: "project-a",
  };
  controller.selectProfile(slot, "profile-a");
  controller.materializeDraftSelection(slot, draftSlot.draftId, draftSlot.harness, draftSlot.projectId);
  const emptyTargets = new MemoryTargetPersistence();
  controller.initializeTargetPersistence(emptyTargets);
  await controller.loadSelection(draftSlot);
  assert.equal(controller.getSelectedProfile(draftSlot)?.id, "profile-a");
  controller.dispose();
});

test("target persistence failure rejects pre-send synchronization", async () => {
  const slot = { kind: "new-thread" as const, projectId: "project-a" };
  const { controller, targets } = await createController();
  await controller.synchronizeSelection(slot, CODEX_SETTINGS);
  targets.failWrites = true;
  controller.selectCustom(slot, { ...CODEX_SETTINGS, model: "unsaved-model" });

  await assert.rejects(
    controller.synchronizeSelection(slot, { ...CODEX_SETTINGS, model: "unsaved-model" }),
    /daemon rejected the target mutation/i,
  );
  assert.match(controller.getSnapshot().error, /daemon rejected the target mutation/i);
  assert.deepEqual(controller.getSelection(slot), { kind: "custom", settings: CODEX_SETTINGS });
  controller.dispose();
});
