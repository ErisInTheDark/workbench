/*
 * No production exports. Tests exercise draft adapters with client-state storage and app presentation ports.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchComposerInputDraft } from "workbench-shared/types";
import type { PresentationDraftInput, PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import type { WorkbenchThreadAddressedFeedback } from "workbench-shared/workbench/thread/thread-addressed-feedback";
import DraftSessionController from "../../components/workbench/thread-view/DraftSessionController";
import WorkbenchClientStateController from "./WorkbenchClientStateController";
import type WorkbenchPresentationClient from "./WorkbenchPresentationClient";
import {
  attachComposerDraftReference, clearComposerDraft, clearQuestionnaireDraft, projectComposerDrafts,
  saveComposerDraft, saveQuestionnaireDraft,
  type ComposerDraftTarget,
} from "./draft-persistence";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

function presentationFixture() {
  const records = new Map<string, PresentationSnapshot["drafts"][number]>();
  const navigations: string[] = [];
  const selection = { kind: "custom" as const, settings: {
    agentPath: null, agentSource: null, harness: "codex" as const, model: "model", reasoningEffort: null,
    serviceTier: null, contextWindowTokens: null,
  } };
  const owner = {
    draft: (id: string) => records.get(id) ?? null,
    putDraft: async (input: PresentationDraftInput) => {
      const prior = records.get(input.id);
      records.set(input.id, { ...input, phase: "unsent", revision: (prior?.revision ?? 0) + 1,
        pinned: prior?.pinned ?? false, snoozed: prior?.snoozed ?? false, launchId: null, acceptedThreadId: null,
        attachments: prior?.attachments ?? [] });
    },
    uploadAttachment: async (id: string, attachmentId: string) => {
      records.get(id)!.attachments.push({ id: attachmentId, mediaType: "image/png", contentHash: attachmentId });
    },
    attachmentUrl: (_id: string, attachmentId: string) => `image:${attachmentId}`,
    removeDraft: async (id: string) => { records.delete(id); },
  } as unknown as WorkbenchPresentationClient;
  const draftId = fixtureIdentitySchemas.DraftIdSchema.parse(crypto.randomUUID());
  const target: Extract<ComposerDraftTarget, { kind: "presentation" }> = {
    kind: "presentation", draftId, isNew: true, owner,
    logicalProjectId: fixtureIdentitySchemas.LogicalProjectIdSchema.parse(crypto.randomUUID()),
    location: { daemonId: fixtureIdentitySchemas.DaemonIdSchema.parse(crypto.randomUUID()),
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") },
    selection: () => owner.draft(draftId)?.selection ?? selection,
    materialize: () => { navigations.push(draftId); }, dematerialize: () => {},
  };
  return { records, navigations, owner, target };
}

const autosave = { reason: "autosave", detached: false } as const;

test("saved presentation draft keeps its owner location when a queued save captured an older folder", async () => {
  const draftId = fixtureIdentitySchemas.DraftIdSchema.parse(crypto.randomUUID());
  const logicalProjectId = fixtureIdentitySchemas.LogicalProjectIdSchema.parse(crypto.randomUUID());
  const oldLocation = {
    daemonId: fixtureIdentitySchemas.DaemonIdSchema.parse(crypto.randomUUID()),
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("old"),
  };
  const currentLocation = {
    daemonId: fixtureIdentitySchemas.DaemonIdSchema.parse(crypto.randomUUID()),
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("current"),
  };
  const selection = { kind: "custom" as const, settings: {
    agentPath: null, agentSource: null, harness: "codex" as const, model: "model",
    reasoningEffort: null, serviceTier: null, contextWindowTokens: null,
  } };
  const saved = {
    id: draftId, logicalProjectId, target: currentLocation, prompt: "first words", selection,
    updatedAt: 1, revision: 1, phase: "unsent" as const, pinned: false, snoozed: false,
    launchId: null, acceptedThreadId: null, attachments: [],
  };
  const writes: Array<{ target: typeof currentLocation; prompt: string }> = [];
  const owner = {
    draft: () => saved,
    putDraft: async (input: { target: typeof currentLocation; prompt: string }) => {
      writes.push(input);
    },
    attachmentUrl: () => "",
  } as unknown as WorkbenchPresentationClient;
  const target: ComposerDraftTarget = {
    kind: "presentation", draftId, isNew: false, logicalProjectId,
    location: oldLocation, owner, selection: () => selection, materialize: () => {}, dematerialize: () => {},
  };
  await saveComposerDraft(new WorkbenchClientStateController(), target,
    draft => ({ ...draft, text: "edited words" }), autosave);
  assert.deepEqual(writes.map(write => write.target), [currentLocation]);
  assert.deepEqual(writes.map(write => write.prompt), ["edited words"]);
});

test("new drafts reuse their reserved identity and preserve existing metadata through late updates", async () => {
  const state = new WorkbenchClientStateController();
  const store = presentationFixture();
  await saveComposerDraft(state, store.target, (draft) => ({ ...draft, text: "enough words to save this draft" }), autosave);
  assert.equal(store.records.size, 1);
  const original = store.owner.draft(store.target.draftId);
  assert.ok(original);
  store.records.set(original.id, { ...original, pinned: true,
    selection: { kind: "profile", profileId: "new profile", settings: { ...original.selection.settings, model: "updated model" } } });
  await saveComposerDraft(state, store.target, (draft) => ({
    ...draft, attachments: [...draft.attachments, { id: "image", url: "image:pasted" }],
  }), { ...autosave, detached: true });
  assert.equal(store.records.size, 1);
  const latest = store.owner.draft(store.target.draftId);
  assert.ok(latest);
  assert.equal(latest.prompt, original.prompt);
  assert.equal(latest.selection.settings.model, "updated model");
  assert.equal(latest.selection.kind === "profile" ? latest.selection.profileId : null, "new profile");
  assert.equal(latest.pinned, true);
  assert.deepEqual(latest.attachments.map(item => item.id), ["image"]);
  assert.deepEqual(store.navigations, [store.target.draftId]);
});

test("existing app drafts disappear only after their last content is cleared", async () => {
  const state = new WorkbenchClientStateController();
  const store = presentationFixture();
  await saveComposerDraft(state, store.target, (draft) => ({ ...draft, text: "materialised draft content" }), autosave);
  await saveComposerDraft(state, store.target, (draft) => ({ ...draft, text: " " }), autosave);
  assert.equal(store.records.size, 0);

  await saveComposerDraft(state, store.target, (draft) => ({
    ...draft,
    attachments: [{ id: "shot", url: "image:shot" }],
    text: "materialised yet again",
  }), autosave);
  await saveComposerDraft(state, store.target, (draft) => ({ ...draft, text: "" }), autosave);
  assert.deepEqual(store.owner.draft(store.target.draftId)?.attachments.map(item => item.id), ["shot"]);
});

test("clearing the last app draft content dematerialises its current route only after deletion", async () => {
  const draftId = fixtureIdentitySchemas.DraftIdSchema.parse(crypto.randomUUID());
  const logicalProjectId = fixtureIdentitySchemas.LogicalProjectIdSchema.parse(crypto.randomUUID());
  const oldLocation = {
    daemonId: fixtureIdentitySchemas.DaemonIdSchema.parse(crypto.randomUUID()),
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  };
  const selection = { kind: "custom" as const, settings: {
    agentPath: null, agentSource: null, harness: "codex" as const, model: "model",
    reasoningEffort: null, serviceTier: null, contextWindowTokens: null,
  } };
  const events: string[] = [];
  let stored: { id: typeof draftId; phase: "unsent"; prompt: string; attachments: []; updatedAt: number } | null = {
    id: draftId, phase: "unsent", prompt: "saved draft", attachments: [], updatedAt: 1,
  };
  const owner = {
    draft: () => stored,
    removeDraft: async () => { events.push("removed"); stored = null; },
  } as unknown as WorkbenchPresentationClient;
  const target: ComposerDraftTarget = {
    kind: "presentation", draftId, isNew: false, logicalProjectId,
    location: oldLocation, owner, selection: () => selection,
    materialize: () => {}, dematerialize: () => { events.push("route"); },
  };
  await saveComposerDraft(new WorkbenchClientStateController(), target,
    draft => ({ ...draft, text: "" }), autosave);
  assert.deepEqual(events, ["removed", "route"]);
  const failedOwner = {
    draft: () => ({ id: draftId, phase: "unsent", prompt: "still saved", attachments: [], updatedAt: 1 }),
    removeDraft: async () => { throw new Error("delete failed"); },
  } as unknown as WorkbenchPresentationClient;
  await assert.rejects(saveComposerDraft(new WorkbenchClientStateController(),
    { ...target, owner: failedOwner }, draft => ({ ...draft, text: "" }), autosave), /delete failed/u);
  assert.deepEqual(events, ["removed", "route"]);
});

test("a still-new presentation view retries its draft handoff after later successful saves", async () => {
  const draftId = fixtureIdentitySchemas.DraftIdSchema.parse(crypto.randomUUID());
  const logicalProjectId = fixtureIdentitySchemas.LogicalProjectIdSchema.parse(crypto.randomUUID());
  const location = {
    daemonId: fixtureIdentitySchemas.DaemonIdSchema.parse(crypto.randomUUID()),
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  };
  const selection = { kind: "custom" as const, settings: {
    agentPath: null, agentSource: null, harness: "codex" as const, model: "model",
    reasoningEffort: null, serviceTier: null, contextWindowTokens: null,
  } };
  let stored: { id: typeof draftId; logicalProjectId: typeof logicalProjectId;
    target: typeof location; prompt: string; attachments: []; updatedAt: number } | null = null;
  const prompts: string[] = [];
  let handoffs = 0;
  const owner = {
    draft: () => stored,
    putDraft: async (input: NonNullable<typeof stored>) => {
      stored = input;
      prompts.push(input.prompt);
    },
    attachmentUrl: () => "",
  } as unknown as WorkbenchPresentationClient;
  const target: ComposerDraftTarget = {
    kind: "presentation", draftId, isNew: true, logicalProjectId, location, owner,
    selection: () => selection, materialize: () => { handoffs++; }, dematerialize: () => {},
  };
  await saveComposerDraft(new WorkbenchClientStateController(), target,
    draft => ({ ...draft, text: "first saved words" }), autosave);
  await saveComposerDraft(new WorkbenchClientStateController(), target,
    draft => ({ ...draft, text: "later saved words" }), autosave);
  assert.deepEqual(prompts, ["first saved words", "later saved words"]);
  assert.equal(handoffs, 2);
});

test("detached creation never navigates and clearing uses the original draft identity", async () => {
  const state = new WorkbenchClientStateController();
  const store = presentationFixture();
  await saveComposerDraft(state, store.target, (draft) => ({ ...draft, text: "save this detached draft safely" }), { ...autosave, detached: true });
  assert.equal(store.navigations.length, 0);
  const otherProject = { ...store.target, draftId: fixtureIdentitySchemas.DraftIdSchema.parse(crypto.randomUUID()),
    logicalProjectId: fixtureIdentitySchemas.LogicalProjectIdSchema.parse(crypto.randomUUID()) };
  await saveComposerDraft(state, otherProject, (draft) => ({ ...draft, text: "another project's draft" }), autosave);
  await clearComposerDraft(state, store.target);
  assert.equal(store.owner.draft(store.target.draftId), null);
  assert.ok(store.owner.draft(otherProject.draftId));
});

test("an image materialises a new draft below the text threshold", async () => {
  const state = new WorkbenchClientStateController();
  const store = presentationFixture();
  const session = new DraftSessionController<WorkbenchComposerInputDraft>({ text: "", attachments: [], updatedAt: 0 }, {
    empty: () => ({ text: "", attachments: [], updatedAt: 0 }),
    save: (update, options) => saveComposerDraft(state, store.target, update, options),
    schedule: () => 1,
    cancelSchedule: () => {},
  });
  session.attach();
  session.edit((draft) => ({ ...draft, text: "hi" }));
  await session.flush();
  session.edit((draft) => ({ ...draft, attachments: [{ id: "shot", url: "image:shot" }] }));
  await session.flush();
  assert.equal(store.records.size, 1);
  const saved = [...store.records.values()][0];
  assert.deepEqual(saved.attachments.map(item => item.id), ["shot"]);
  assert.equal(saved.prompt, "hi");
  assert.deepEqual(store.navigations, [store.target.draftId]);
  session.detach();
});

test("questionnaire updates merge into latest content and isolate project and request identities", async () => {
  const state = new WorkbenchClientStateController();
  const identity = { daemonRegistrationId: "memory", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("one"), threadId: fixtureIdentitySchemas.ThreadReferenceSchema.parse("thread"), requestKey: "request" };
  await saveQuestionnaireDraft(state, () => identity, (draft) => ({ ...draft, customValues: { answer: "newer text" } }));
  await saveQuestionnaireDraft(state, () => ({ ...identity, requestKey: "other request" }), (draft) => ({ ...draft, customValues: { answer: "other request" } }));
  await saveQuestionnaireDraft(state, () => ({ ...identity, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("two") }), (draft) => ({ ...draft, customValues: { answer: "other project" } }));
  const saved = await saveQuestionnaireDraft(state, () => identity, (draft) => ({
    ...draft, attachments: [...draft.attachments, { id: "shot", url: "image:shot" }],
  }));
  assert.equal(saved.customValues.answer, "newer text");
  assert.equal(saved.attachments.length, 1);
  await clearQuestionnaireDraft(state, () => identity);
  assert.deepEqual(state.records("questionnaireDraft").map((record) => record.value.customValues.answer).sort(), ["other project", "other request"]);
});

test("questionnaire draft saves resolve the owner at action time and keep one write address", async () => {
  const state = new WorkbenchClientStateController();
  const first = { daemonRegistrationId: "first", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("one"),
    threadId: fixtureIdentitySchemas.ThreadReferenceSchema.parse("thread"), requestKey: "request" };
  const second = { ...first, daemonRegistrationId: "second" };
  let available: typeof first | null = null;
  const owner = () => available;
  await assert.rejects(saveQuestionnaireDraft(state, owner, draft => draft), /unavailable/u);
  available = first;
  await saveQuestionnaireDraft(state, owner, draft => {
    available = second;
    return { ...draft, customValues: { answer: "kept with first owner" } };
  });
  assert.equal(state.records("questionnaireDraft").length, 1);
  assert.equal(state.records("questionnaireDraft")[0]?.daemonRegistrationId, first.daemonRegistrationId);
});

test("composer changes use latest client-state content and clearing leaves other records alone", async () => {
  const state = new WorkbenchClientStateController();
  const target: ComposerDraftTarget = { kind: "thread", daemonRegistrationId: "memory", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("one"), threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread") };
  await saveComposerDraft(state, target, (draft) => ({ ...draft, text: "new text" }), autosave);
  const latest = await saveComposerDraft(state, target, (draft) => ({
    ...draft, attachments: [{ id: "shot", url: "image:shot" }],
  }), { ...autosave, detached: true });
  assert.ok(latest);
  assert.equal(latest.text, "new text");
  await saveComposerDraft(state, { ...target, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("two") }, (draft) => ({ ...draft, text: "keep this" }), autosave);
  await clearComposerDraft(state, target);
  assert.deepEqual(state.records("composerDraft").map((record) => record.value.text), ["keep this"]);
});

test("reference-only composer drafts persist for an existing thread", async () => {
  const state = new WorkbenchClientStateController();
  const target: ComposerDraftTarget = { kind: "thread", daemonRegistrationId: "memory",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("one"),
    threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread") };
  const feedback: WorkbenchThreadAddressedFeedback = {
    kind: "feedback", id: 7, daemonId: "daemon-a", category: "bug", title: "Stats action fails",
    author: "GPT-5.5 high", thread: "Fix stats", createdAt: 1_760_050_000_000, report: "The stats action fails.",
  };

  await saveComposerDraft(state, target, draft => ({ ...draft, references: [feedback] }), autosave);

  assert.deepEqual(state.records("composerDraft").map(record => record.value.references), [[feedback]]);
});

test("attaching feedback preserves composer content and deduplicates its reference identity", () => {
  const feedback: WorkbenchThreadAddressedFeedback = {
    kind: "feedback", id: 7, daemonId: "daemon-a", category: "bug", title: "Stats action fails",
    author: "GPT-5.5 high", thread: "Fix stats", createdAt: 1_760_050_000_000, report: "The stats action fails.",
  };
  const existing = { kind: "updateIssue" as const, text: "Keep this issue." };
  const draft: WorkbenchComposerInputDraft = {
    attachments: [{ id: "shot", url: "image:shot" }],
    references: [existing],
    text: "keep this text",
    updatedAt: 1,
  };

  const once = attachComposerDraftReference(draft, feedback);
  const twice = attachComposerDraftReference(once, feedback);

  assert.deepEqual(twice, {
    ...draft,
    references: [existing, feedback],
  });
  assert.equal(twice, once);
});

test("composer draft projection follows the UUID owner across daemon registrations", async () => {
  const state = new WorkbenchClientStateController();
  const attached: ComposerDraftTarget = { kind: "thread", daemonRegistrationId: "attached",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("one"),
    threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread") };
  const remote: ComposerDraftTarget = { ...attached, daemonRegistrationId: "remote" };
  await saveComposerDraft(state, attached, draft => ({ ...draft, text: "attached" }), autosave);
  await saveComposerDraft(state, remote, draft => ({ ...draft, text: "remote" }), autosave);
  const resolve = () => remote;
  assert.equal(projectComposerDrafts(state.getSnapshot().records, resolve)[attached.threadId]?.text, "remote");
  assert.deepEqual(projectComposerDrafts(state.getSnapshot().records, () => null), {});
});
