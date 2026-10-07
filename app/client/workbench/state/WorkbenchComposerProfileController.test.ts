/*
 * Exports: none.
 * Tests:
 * - WorkbenchComposerProfileController keeps daemon-owned definitions and target snapshots acknowledged without stale-read rollback.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type {
  ThreadPayload,
  WorkbenchComposerProfile,
  WorkbenchComposerProfileMutation,
  WorkbenchComposerProfileTargetSelection,
  WorkbenchComposerSettings,
  WorkbenchModelOption,
} from "workbench-shared/types";
import type { WorkbenchComposerProfileSlot } from "workbench-shared/types";
import type { ComposerProfilePersistence, ComposerProfileTargetPersistence } from "./composer-profile-api";
import WorkbenchComposerProfileController from "./WorkbenchComposerProfileController";
import { createComposerProfileTargetPersistence } from "./composer-profile-api";
import type WorkbenchPresentationClient from "./WorkbenchPresentationClient";
import WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  DraftId: {
    "draft-a": fixtureIdentitySchemas.DraftIdSchema.parse("draft-a"),
  },
  ProjectId: {
    "project-a": fixtureIdentitySchemas.ProjectIdSchema.parse("project-a"),
  },
  WorkbenchThreadId: {
    "thread": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"),
    "thread-a": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread-a"),
    "thread-b": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread-b"),
    "thread-c": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread-c"),
  },
};

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
  async read(slot: WorkbenchComposerProfileSlot): Promise<WorkbenchComposerProfileTargetSelection | null> {
    return this.selections.get(this.key(slot)) ?? null;
  }
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
const OPENCODE_MODEL: WorkbenchModelOption = {
  id: "native/default", displayName: "Default", description: "", hidden: false, isDefault: true,
  supportsPersonality: false, supportsReasoningEffort: true, supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "high",
  supportsVision: false, supportsFastMode: false, inputModalities: ["text"], maxContextWindowTokens: null, additionalSpeedTiers: [], policyState: null, billingMultiplier: null,
  contextWindow: { defaultTokens: 200_000, maximumTokens: 400_000 },
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

test("a new-turn profile write exposes pending and failed state before Send", async (context) => {
  const { controller, targets } = await createController();
  context.after(() => controller.dispose());
  const slot: WorkbenchComposerProfileSlot = {
    kind: "new-thread", projectId: fixtureIdentityValues.ProjectId["project-a"],
  };
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  targets.write = async () => {
    entered.resolve();
    await release.promise;
    throw new Error("Daemon rejected the target mutation.");
  };
  const writing = controller.selectCustom(slot, CODEX_SETTINGS);
  await entered.promise;
  assert.equal(controller.selectionWriteState(slot), "pending");
  release.resolve();
  assert.equal(await writing, false);
  assert.equal(controller.selectionWriteState(slot), "failed");
  assert.equal(controller.selectionWriteState({
    kind: "new-thread", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("another-project"),
  }), "ready");
});

test("catalogue refresh coalesces without overwriting edits or surviving disconnect", async (context) => {
  const { controller, persistence } = await createController([profile()]);
  context.after(() => controller.dispose());
  let release!: (payload: { profiles: WorkbenchComposerProfile[] }) => void;
  let reads = 0;
  persistence.read = () => {
    reads++;
    return new Promise(resolve => { release = resolve; });
  };
  const first = controller.refreshProfiles();
  const second = controller.refreshProfiles();
  assert.equal(reads, 1);
  await controller.updateProfile("profile-a", { name: "New name" });
  release({ profiles: [profile({ lastUsedAt: 40 })] });
  await Promise.all([first, second]);
  assert.equal(controller.getProfile("profile-a")?.name, "New name");
  const disconnected = controller.refreshProfiles();
  controller.disconnectPersistence();
  release({ profiles: [profile({ name: "Stale" })] });
  await disconnected;
  assert.equal(controller.getProfile("profile-a")?.name, "New name");
});

test("the approval mode persists on a default-previewing slot and survives later model and profile changes", async (context) => {
  const { controller, targets } = await createController([profile()]);
  context.after(() => controller.dispose());
  const slot: WorkbenchComposerProfileSlot = { kind: "new-thread", projectId: fixtureIdentityValues.ProjectId["project-a"] };
  const codexDefault = { ...OPENCODE_MODEL, id: "gpt-default" };
  await controller.loadSelection(slot);
  assert.equal(await controller.setApprovalMode(slot, "skip", { harness: "codex", loadModels: async () => [codexDefault] }), true);
  assert.deepEqual(await targets.read(slot), {
    kind: "custom", approvalMode: "skip",
    settings: { agentPath: null, agentSource: null, harness: "codex", model: "gpt-default", reasoningEffort: "high", serviceTier: null, contextWindowTokens: 200_000 },
  });
  await controller.selectCustom(slot, CODEX_SETTINGS);
  assert.equal((await targets.read(slot))?.approvalMode, "skip");
  controller.selectProfile(slot, "profile-a");
  await controller.waitForSelection(slot);
  assert.equal((await targets.read(slot))?.approvalMode, "skip");
  assert.equal(controller.getApprovalMode(slot), "skip");
});

test("missing daemon selection never resolves settings from a raw thread", async () => {
  const { controller } = await createController();
  const slot = { kind: "thread" as const, harness: "codex" as const, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project-a"), threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread") };
  assert.equal(controller.resolveSettings(slot), null);
  controller.dispose();
});

test("empty target reads finish loading and allow a profile to be selected", async () => {
  const { controller } = await createController([profile()]);
  const slots: WorkbenchComposerProfileSlot[] = [
    { kind: "new-thread", projectId: fixtureIdentityValues.ProjectId["project-a"] },
    { kind: "draft", projectId: fixtureIdentityValues.ProjectId["project-a"], harness: "codex", draftId: fixtureIdentityValues.DraftId["draft-a"] },
  ];
  try {
    for (const slot of slots) {
      assert.equal(controller.hasSelection(slot), false);
      await controller.loadSelection(slot);
      assert.equal(controller.hasSelection(slot), true);
      assert.equal(controller.resolveSettings(slot), null);
      assert.equal(controller.selectProfile(slot, "profile-a"), true);
      await controller.loadSelection(slot);
      assert.deepEqual(controller.resolveSettings(slot), CODEX_SETTINGS);
    }
  } finally {
    controller.dispose();
  }
});

test("targets requested before connection load when persistence arrives", async () => {
  const controller = new WorkbenchComposerProfileController();
  const slot = { kind: "thread" as const, harness: "codex" as const, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project-a"), threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread") };
  const targets = new MemoryTargetPersistence();
  await targets.write(slot, { kind: "custom", settings: CODEX_SETTINGS });
  let notifications = 0;
  const unsubscribe = controller.subscribe(() => { notifications++; });

  await controller.loadSelection(slot);
  await controller.initializeTargetPersistence(targets);

  assert.deepEqual(controller.resolveSettings(slot), CODEX_SETTINGS);
  assert.equal(controller.getSnapshot().error, "");
  assert.ok(notifications > 0);
  unsubscribe();
  controller.dispose();
});

test("disconnect fences late reads without severing profile subscribers", async () => {
  const controller = new WorkbenchComposerProfileController();
  const slot = { kind: "thread" as const, harness: "codex" as const, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project-a"), threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread") };
  let release!: (selection: WorkbenchComposerProfileTargetSelection) => void;
  const pending = new Promise<WorkbenchComposerProfileTargetSelection>((resolve) => { release = resolve; });
  await controller.initializeTargetPersistence({ read: async () => pending, write: async () => undefined });
  let notifications = 0;
  const unsubscribe = controller.subscribe(() => { notifications++; });
  const loading = controller.loadSelection(slot);
  controller.disconnectPersistence();
  const replacement = new MemoryTargetPersistence();
  await replacement.write(slot, { kind: "custom", settings: { ...CODEX_SETTINGS, model: "replacement" } });
  await controller.initializeTargetPersistence(replacement);
  release({ kind: "custom", settings: CODEX_SETTINGS });
  await loading;
  assert.equal(controller.resolveSettings(slot)?.model, "replacement");
  assert.ok(notifications > 0);
  unsubscribe();
  controller.dispose();
});

test("draft profile reads wait for app facts while configured threads still read their daemon", async () => {
  let release!: () => void;
  const saving = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  const daemon = new WorkbenchDaemonClient({
    request: async <TResponse>() => { reads++; return { selection: { kind: "custom", settings: CODEX_SETTINGS } } as TResponse; },
  });
  const slot = { kind: "draft" as const, harness: "codex" as const, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project-a"), draftId: fixtureIdentitySchemas.DraftIdSchema.parse("draft") };
  const appDrafts = { ready: async () => saving,
    draft: (id: string) => {
      assert.equal(id, slot.draftId);
      return { selection: { kind: "custom", settings: CODEX_SETTINGS } };
    },
  } as unknown as WorkbenchPresentationClient;
  const persistence = createComposerProfileTargetPersistence(daemon, appDrafts, fixtureIdentitySchemas.DaemonIdSchema.parse("00000000-0000-4000-8000-000000000001"));
  const reading = persistence.read(slot);
  assert.equal(reads, 0);
  release();
  assert.deepEqual(await reading, { kind: "custom", settings: CODEX_SETTINGS });
  assert.equal(reads, 0);
  await persistence.read({ kind: "thread", harness: "codex", projectId: fixtureIdentityValues.ProjectId["project-a"], threadId: fixtureIdentityValues.WorkbenchThreadId["thread"] });
  assert.equal(reads, 1);
});

test("draft profile edits await app acknowledgement and preserve failed-save propagation", async () => {
  let release!: () => void;
  const saving = new Promise<void>((resolve) => { release = resolve; });
  let writes = 0;
  const daemon = new WorkbenchDaemonClient({ request: async () => { throw new Error("Draft profiles are app-owned."); } });
  const slot = { kind: "draft" as const, harness: "codex" as const, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project-a"), draftId: fixtureIdentitySchemas.DraftIdSchema.parse("draft") };
  const selection = { kind: "custom" as const, settings: CODEX_SETTINGS };
  let fail = false;
  const appDrafts = {
    ready: async () => {},
    draft: () => ({ id: slot.draftId, phase: "unsent", prompt: "Retained prompt",
      logicalProjectId: "logical", target: { daemonId: "daemon", projectId: slot.projectId }, selection }),
    putDraft: async (value: { prompt: string; selection: object }) => {
      assert.equal(value.prompt, "Retained prompt");
      assert.deepEqual(value.selection, selection);
      writes++;
      await saving;
      if (fail) throw new Error("Draft save failed");
    },
  } as unknown as WorkbenchPresentationClient;
  const persistence = createComposerProfileTargetPersistence(daemon, appDrafts, fixtureIdentitySchemas.DaemonIdSchema.parse("00000000-0000-4000-8000-000000000001"));
  const writing = persistence.write(slot, selection);
  assert.equal(writes, 0);
  release();
  await writing;
  assert.equal(writes, 1);
  fail = true;
  await assert.rejects(persistence.write(slot, selection), /Draft save failed/);
  assert.equal(writes, 2);
});

test("target edits remain ordered and sending waits for their acknowledgement", async () => {
  const controller = new WorkbenchComposerProfileController();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const writes: WorkbenchComposerProfileTargetSelection[] = [];
  controller.initializeTargetPersistence({
    read: async () => writes.at(-1) ?? null,
    write: async (_slot, selection) => { writes.push(selection); await gate; },
  });
  const slot = { kind: "new-thread" as const, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project-a") };
  try {
    controller.selectCustom(slot, CODEX_SETTINGS);
    controller.selectCustom(slot, { ...CODEX_SETTINGS, model: "new-model" });
    await Promise.resolve();
    assert.equal(writes.length, 1);
    let ready = false;
    const waiting = controller.waitForSelection(slot).then(() => { ready = true; });
    assert.equal(ready, false);
    release();
    await waiting;
    assert.equal(writes.length, 2);
    assert.equal(controller.resolveSettings(slot)?.model, "new-model");
  } finally {
    release();
    controller.dispose();
  }
});

test("scope changes retain stable ids and preserve hidden out-of-scope links", async () => {
  const { controller } = await createController();
  const sourceSlot = { kind: "new-thread" as const, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project-b") };
  const created = await controller.createProfile({
    ...CODEX_SETTINGS,
    name: "Lily",
    scope: { kind: "global" },
  });
  assert.ok(created);
  controller.selectProfile(sourceSlot, created.id);

  const demoted = await controller.updateProfile(created.id, { scope: { kind: "project", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project-a") } });
  assert.equal(demoted?.id, created.id);
  assert.deepEqual(controller.getVisibleProfiles("project-b"), []);
  assert.equal(controller.getSelectedProfile(sourceSlot)?.id, created.id);
  assert.equal(controller.resolveSettings(sourceSlot)?.model, "gpt-5.4");
  controller.dispose();
});

test("materialization copies only compatible profile links to durable destination slots", async () => {
  const sourceSlot = { kind: "new-thread" as const, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project-a") };
  const { controller, targets } = await createController([profile()]);
  controller.selectProfile(sourceSlot, "profile-a");
  await controller.loadSelection(sourceSlot);

  controller.materializeSelection(sourceSlot, fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread-a"), "codex");
  controller.materializeSelection(sourceSlot, fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread-b"), "copilot");
  assert.equal(controller.getSelectedProfile({ harness: "codex", kind: "thread", projectId: fixtureIdentityValues.ProjectId["project-a"], threadId: fixtureIdentityValues.WorkbenchThreadId["thread-a"] })?.id, "profile-a");
  assert.equal(controller.getSelection({ harness: "copilot", kind: "thread", projectId: fixtureIdentityValues.ProjectId["project-a"], threadId: fixtureIdentityValues.WorkbenchThreadId["thread-b"] }).kind, "custom");
  assert.equal(controller.selectProfile({ harness: "copilot", kind: "thread", projectId: fixtureIdentityValues.ProjectId["project-a"], threadId: fixtureIdentityValues.WorkbenchThreadId["thread-c"] }, "profile-a"), false);
  assert.equal(targets.selections.size, 1);
  controller.dispose();
});

test("a stored profile can change provider and project agents cannot be promoted globally", async () => {
  const projectProfile = profile({
    agentPath: ".agents/agents/project.md",
    agentSource: "project",
    scope: { kind: "project", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project-a") },
  });
  const { controller } = await createController([projectProfile]);

  const updated = await controller.updateProfile(projectProfile.id, { harness: "copilot", model: "copilot-model" });
  assert.equal(updated?.harness, "copilot");
  assert.equal(updated?.model, "copilot-model");
  const rejected = await controller.updateProfile(projectProfile.id, { scope: { kind: "global" } });
  assert.equal(rejected, null);
  assert.match(controller.getSnapshot().error, /project agent/i);
  assert.deepEqual(controller.getProfile(projectProfile.id)?.scope, { kind: "project", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project-a") });
  controller.dispose();
});

test("deleting a definition previews Custom without rewriting the saved snapshot", async () => {
  const slot = { harness: "codex" as const, kind: "thread" as const, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project-a"), threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread-a") };
  const { controller, targets } = await createController([profile()]);
  controller.selectProfile(slot, "profile-a");
  await controller.waitForSelection(slot);

  await controller.deleteProfile("profile-a");
  const selection = controller.getSelection(slot);
  assert.equal(selection.kind, "custom");
  assert.equal(controller.getSelectedProfile(slot), null);
  assert.deepEqual(selection.settings, CODEX_SETTINGS);
  assert.deepEqual(await targets.read(slot), { kind: "profile", profileId: "profile-a", settings: CODEX_SETTINGS });
  controller.dispose();
});

test("a provider-drifted linked profile previews its saved Custom snapshot", async () => {
  const slot = { harness: "codex" as const, kind: "thread" as const, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project-a"), threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread-a") };
  const { controller, targets } = await createController([profile()]);
  controller.selectProfile(slot, "profile-a");
  await controller.waitForSelection(slot);

  await controller.updateProfile("profile-a", { harness: "copilot", model: "copilot-model" });
  assert.equal(controller.getSelectedProfile(slot), null);
  assert.deepEqual(controller.getSelection(slot), { kind: "profile", profileId: "profile-a", settings: CODEX_SETTINGS });
  assert.deepEqual(controller.resolveSettings(slot), CODEX_SETTINGS);
  assert.deepEqual(await targets.read(slot), { kind: "profile", profileId: "profile-a", settings: CODEX_SETTINGS });
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
  const slot = { kind: "new-thread" as const, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project-a") };
  const { controller } = await createController([profile()]);
  controller.selectProfile(slot, "profile-a");
  const resolved = controller.resolveThread(slot, {
    agentNickname: null,
    agentPath: null,
    agentRole: null,
    browseResultEntries: [],
    createdAt: 1,
    cwd: "C:/workspace",
    harness: "codex",
    id: fixtureIdentitySchemas.DraftIdSchema.parse("draft:1"),
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

test("draft profile slots stay UUID-isolated and provider-mobile", async () => {
  const { controller } = await createController([profile()]);
  const first = { draftId: fixtureIdentitySchemas.DraftIdSchema.parse("11111111-1111-4111-8111-111111111111"), harness: "codex" as const, kind: "draft" as const, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project-a") };
  const second = { ...first, draftId: fixtureIdentitySchemas.DraftIdSchema.parse("22222222-2222-4222-8222-222222222222") };

  assert.equal(controller.selectProfile(first, "profile-a"), true);
  assert.deepEqual(controller.getSelection(first), { kind: "profile", profileId: "profile-a", settings: CODEX_SETTINGS });
  assert.deepEqual(controller.getSelection(second), { kind: "custom" });
  // A draft is not provider-bound: selecting the profile at another provider retargets the draft.
  assert.equal(controller.selectProfile({ ...first, harness: "opencode" }, "profile-a"), true);
  assert.equal(controller.getSelectedProfile({ ...first, harness: "opencode" })?.id, "profile-a");
  controller.dispose();
});

test("a draft adopts a drifted linked profile's provider instead of falling back", async () => {
  const slot = { draftId: fixtureIdentitySchemas.DraftIdSchema.parse("33333333-3333-4333-8333-333333333333"), harness: "codex" as const, kind: "draft" as const, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project-a") };
  const { controller } = await createController([profile()]);
  controller.selectProfile(slot, "profile-a");
  await controller.waitForSelection(slot);

  await controller.updateProfile("profile-a", { harness: "copilot", model: "copilot-model" });
  assert.equal(controller.getSelectedProfile(slot)?.id, "profile-a");
  assert.equal(controller.resolveSettings(slot)?.harness, "copilot");
  controller.dispose();
});

test("definition edits update next-turn preview without rewriting target snapshots", async () => {
  const slot = { kind: "new-thread" as const, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project-a") };
  const { controller, targets } = await createController([profile()]);
  controller.selectProfile(slot, "profile-a");
  await controller.loadSelection(slot);
  assert.deepEqual(await targets.read(slot), {
    kind: "profile",
    profileId: "profile-a",
    settings: CODEX_SETTINGS,
  });

  await controller.updateProfile("profile-a", { model: "gpt-5.5", reasoningEffort: "medium" });
  assert.deepEqual(controller.resolveSettings(slot), { ...CODEX_SETTINGS, model: "gpt-5.5", reasoningEffort: "medium" });
  assert.equal(controller.getSelectedProfile(slot)?.model, "gpt-5.5");
  const synchronized = controller.getSelection(slot);
  assert.deepEqual(synchronized, {
    kind: "profile",
    profileId: "profile-a",
    settings: CODEX_SETTINGS,
  });
  assert.deepEqual(await targets.read(slot), synchronized);
  controller.dispose();
});

test("reopening refreshes an externally edited definition", async () => {
  const { controller, persistence, targets } = await createController([profile()]);
  const slot = { kind: "thread" as const, harness: "codex" as const, projectId: fixtureIdentityValues.ProjectId["project-a"], threadId: fixtureIdentityValues.WorkbenchThreadId["thread-a"] };
  await targets.write(slot, { kind: "profile", profileId: "profile-a", settings: CODEX_SETTINGS });
  await controller.loadSelection(slot);
  persistence.profiles = [profile({ model: "external-model" })];
  await controller.loadSelection(slot);
  assert.equal(controller.resolveSettings(slot)?.model, "external-model");
  controller.dispose();
});

test("a pushed target does not discard the current catalogue refresh", async (context) => {
  const { controller, persistence, targets } = await createController([profile()]);
  const slot = { kind: "thread" as const, harness: "codex" as const, projectId: fixtureIdentityValues.ProjectId["project-a"], threadId: fixtureIdentityValues.WorkbenchThreadId["thread-a"] };
  const selection = { kind: "profile" as const, profileId: "profile-a", settings: CODEX_SETTINGS };
  await targets.write(slot, selection);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  context.after(() => { release(); controller.dispose(); });
  persistence.read = async () => { await gate; return { profiles: [profile({ model: "fresh-definition" })] }; };
  const loading = controller.loadSelection(slot);
  controller.observeSelection(slot, selection);
  release();
  await loading;
  assert.equal(controller.resolveSettings(slot)?.model, "fresh-definition");
  assert.deepEqual(await targets.read(slot), selection);
});

test("a Custom deletion preview still waits for the pending definition save", async (context) => {
  const { controller, persistence } = await createController([profile()]);
  const slot = { kind: "thread" as const, harness: "codex" as const, projectId: fixtureIdentityValues.ProjectId["project-a"], threadId: fixtureIdentityValues.WorkbenchThreadId["thread-a"] };
  controller.selectProfile(slot, "profile-a");
  await controller.waitForSelection(slot);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  context.after(() => { release(); controller.dispose(); });
  persistence.mutate = async () => { await gate; throw new Error("Deletion rejected"); };
  const deleting = controller.deleteProfile("profile-a");
  const waiting = controller.waitForSelection(slot);
  release();
  assert.equal(await deleting, null);
  await assert.rejects(waiting, /Deletion rejected/);
  assert.equal(controller.getSelection(slot).kind, "profile");
});

test("missing pushed snapshots recover next-turn settings and catalogue failures stay visible", async () => {
  const { controller, persistence, targets } = await createController([profile()]);
  const slot = { kind: "thread" as const, harness: "codex" as const, projectId: fixtureIdentityValues.ProjectId["project-a"], threadId: fixtureIdentityValues.WorkbenchThreadId["thread-a"] };
  const selection = { kind: "profile" as const, profileId: "profile-a", settings: CODEX_SETTINGS };
  await targets.write(slot, selection);
  await controller.observeSelection(slot, null);
  assert.deepEqual(controller.resolveSettings(slot), CODEX_SETTINGS);
  persistence.read = async () => { throw new Error("Catalogue unavailable"); };
  await controller.loadSelection(slot);
  assert.match(controller.getSnapshot().error, /Catalogue unavailable/);
  assert.deepEqual(await targets.read(slot), { kind: "profile", profileId: "profile-a", settings: CODEX_SETTINGS });
  controller.dispose();
});

test("daemon target settings remain available while profile labels are loading", async () => {
  const slot = { kind: "new-thread" as const, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project-a") };
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
  assert.deepEqual(controller.getSelection(slot), {
    kind: "profile",
    profileId: "profile-a",
    settings: CODEX_SETTINGS,
  });

  resolveProfiles({ profiles: [profile()] });
  await initialization;
  controller.dispose();
});

test("late reads cannot erase newer selections and missing daemon targets clear provisional display", async () => {
  const slot = { kind: "new-thread" as const, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project-a") };
  let resolveRead: (selection: WorkbenchComposerProfileTargetSelection | null) => void = () => undefined;
  const read = new Promise<WorkbenchComposerProfileTargetSelection | null>((resolve) => { resolveRead = resolve; });
  const persisted = new MemoryTargetPersistence();
  let reads = 0;
  const controller = new WorkbenchComposerProfileController();
  controller.initializeTargetPersistence({
    read: async (target) => ++reads === 1 ? await read : await persisted.read(target),
    write: async (target, selection) => await persisted.write(target, selection),
  });
  await controller.initializePersistence(new MemoryPersistence([profile()]));

  const loading = controller.loadSelection(slot);
  const saving = controller.selectCustom(slot, { ...CODEX_SETTINGS, model: "newer-model" });
  resolveRead({ kind: "custom", settings: { ...CODEX_SETTINGS, model: "stale-model" } });
  await loading;
  assert.equal(controller.resolveSettings(slot)?.model, "newer-model");
  await saving;

  const draftSlot = {
    draftId: fixtureIdentitySchemas.DraftIdSchema.parse("11111111-1111-4111-8111-111111111111"),
    harness: "codex" as const,
    kind: "draft" as const,
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project-a"),
  };
  controller.selectProfile(slot, "profile-a");
  controller.materializeDraftSelection({ ...draftSlot, composerSettings: CODEX_SETTINGS, profileId: null });
  assert.deepEqual(controller.getSelection(draftSlot), { kind: "custom", settings: CODEX_SETTINGS });
  const emptyTargets = new MemoryTargetPersistence();
  controller.initializeTargetPersistence(emptyTargets);
  await controller.loadSelection(draftSlot);
  assert.equal(controller.resolveSettings(draftSlot), null);
  controller.dispose();
});

test("target persistence failure restores acknowledged settings and exposes the failure", async () => {
  const slot = { kind: "new-thread" as const, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project-a") };
  const { controller, targets } = await createController();
  await controller.selectCustom(slot, CODEX_SETTINGS);
  targets.failWrites = true;
  assert.equal(await controller.selectCustom(slot, { ...CODEX_SETTINGS, model: "unsaved-model" }), false);
  assert.match(controller.getSnapshot().error, /daemon rejected the target mutation/i);
  assert.deepEqual(controller.getSelection(slot), { kind: "custom", settings: CODEX_SETTINGS });
  controller.dispose();
});

test("Custom provider changes persist before models arrive and only fill the current blank selection", async () => {
  const controller = new WorkbenchComposerProfileController();
  const slot = { kind: "draft" as const, projectId: fixtureIdentityValues.ProjectId["project-a"], draftId: fixtureIdentityValues.DraftId["draft-a"], harness: "codex" as const };
  let saved: WorkbenchComposerProfileTargetSelection = { kind: "custom", settings: CODEX_SETTINGS };
  await controller.initializeTargetPersistence({
    read: async (target) => target.kind === "draft" ? saved : null,
    write: async (_target, selection) => { saved = selection; },
  });
  await controller.loadSelection(slot);
  assert.equal(await controller.selectHarness(slot, "opencode", async () => {
    throw new Error("Selecting OpenCode must not wait for its models.");
  }), true);
  assert.deepEqual(saved, { kind: "custom", settings: {
    harness: "opencode", model: "", agentPath: null, agentSource: null, reasoningEffort: null, serviceTier: null,
    contextWindowTokens: null,
  } });
  assert.equal(await controller.fillMissingModel(slot, "opencode", [OPENCODE_MODEL]), true);
  assert.deepEqual(controller.resolveSettings({ ...slot, harness: "opencode" }), {
    harness: "opencode", model: "native/default", agentPath: null, agentSource: null, reasoningEffort: "high", serviceTier: null,
    contextWindowTokens: 200_000,
  });
  assert.equal(await controller.selectHarness(slot, "codex", async () => [{ ...OPENCODE_MODEL, id: "codex/default" }]), true);
  assert.equal(await controller.fillMissingModel(slot, "opencode", [OPENCODE_MODEL]), false);
  assert.equal(controller.resolveSettings(slot)?.harness, "codex");
  controller.dispose();
});

test("a cached model can fill a Custom provider while its blank selection write is still pending", async () => {
  const controller = new WorkbenchComposerProfileController();
  const slot = { kind: "draft" as const, projectId: fixtureIdentityValues.ProjectId["project-a"],
    draftId: fixtureIdentityValues.DraftId["draft-a"], harness: "codex" as const };
  let saved: WorkbenchComposerProfileTargetSelection = { kind: "custom", settings: CODEX_SETTINGS };
  const blankWrite = Promise.withResolvers<void>();
  await controller.initializeTargetPersistence({
    read: async () => saved,
    write: async (_target, selection) => {
      if (!selection.settings.model) await blankWrite.promise;
      saved = selection;
    },
  });
  await controller.loadSelection(slot);
  const selecting = controller.selectHarness(slot, "opencode", async () => []);
  const filling = controller.fillMissingModel(slot, "opencode", [OPENCODE_MODEL]);
  blankWrite.resolve();
  assert.equal(await selecting, true);
  assert.equal(await filling, true);
  assert.equal(saved.settings.model, OPENCODE_MODEL.id);
  controller.dispose();
});

test("other provider changes still wait for a supported model before saving", async () => {
  const controller = new WorkbenchComposerProfileController();
  const slot = { kind: "draft" as const, projectId: fixtureIdentityValues.ProjectId["project-a"],
    draftId: fixtureIdentityValues.DraftId["draft-a"], harness: "opencode" as const };
  let saved: WorkbenchComposerProfileTargetSelection = { kind: "custom", settings: { ...CODEX_SETTINGS, harness: "opencode" } };
  await controller.initializeTargetPersistence({
    read: async () => saved,
    write: async (_target, selection) => { saved = selection; },
  });
  await controller.loadSelection(slot);
  const models = Promise.withResolvers<WorkbenchModelOption[]>();
  const changing = controller.selectHarness(slot, "codex", () => models.promise);
  assert.equal(saved.settings.harness, "opencode");
  models.resolve([]);
  assert.equal(await changing, false);
  assert.equal(saved.settings.harness, "opencode");
  controller.dispose();
});
