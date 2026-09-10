/*
 * No production exports. Tests exercise actual draft adapters with client-state storage and sidebar owner ports.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchThreadDraft } from "workbench-shared/workbench/thread/thread-state";
import DraftSessionController from "../../components/workbench/thread-view/DraftSessionController";
import WorkbenchClientStateController from "./WorkbenchClientStateController";
import {
  clearComposerDraft, clearQuestionnaireDraft, saveComposerDraft, saveQuestionnaireDraft, sidebarDraftToInput,
  type ComposerDraftTarget, type SidebarDraftPersistence,
} from "./draft-persistence";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

function sidebarFixture() {
  const records = new Map<string, WorkbenchThreadDraft>();
  const navigations: string[] = [];
  const owner: SidebarDraftPersistence = {
    read: (projectId, draftId) => records.get(`${projectId}:${draftId}`) ?? null,
    create: (projectId, draftId) => ({
      attachments: [], clientUpdatedAt: 0, createdAt: 1, draftId,
      composerSettings: { agentPath: null, agentSource: null, harness: "codex", model: "model", reasoningEffort: null, serviceTier: null },
      profileId: "profile", projectId, prompt: "", updatedAt: 1,
    }),
    write: (draft) => { records.set(`${draft.projectId}:${draft.draftId}`, draft); },
    remove: async (projectId, draftId) => { records.delete(`${projectId}:${draftId}`); },
    materialize: (draft) => { navigations.push(draft.draftId); },
  };
  const target: ComposerDraftTarget = { kind: "sidebar", draftId: fixtureIdentitySchemas.DraftIdSchema.parse(crypto.randomUUID()), projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), isNew: true, owner };
  return { records, navigations, owner, target };
}

const autosave = { reason: "autosave", detached: false } as const;

test("new drafts reuse their reserved identity and preserve existing metadata through late updates", async () => {
  const state = new WorkbenchClientStateController();
  const store = sidebarFixture();
  await saveComposerDraft(state, store.target, (draft) => ({ ...draft, text: "enough words to save this draft" }), autosave);
  assert.equal(store.records.size, 1);
  const original = store.owner.read(store.target.projectId, store.target.draftId);
  assert.ok(original);
  store.records.set(`${original.projectId}:${original.draftId}`, { ...original, composerSettings: { ...original.composerSettings, model: "updated model" }, profileId: "new profile" });
  await saveComposerDraft(state, store.target, (draft) => ({
    ...draft, attachments: [...draft.attachments, { id: "image", url: "image:pasted" }],
  }), { ...autosave, detached: true });
  assert.equal(store.records.size, 1);
  const latest = store.owner.read(store.target.projectId, store.target.draftId);
  assert.ok(latest);
  assert.equal(latest.prompt, original.prompt);
  assert.equal(latest.composerSettings.model, "updated model");
  assert.equal(latest.profileId, "new profile");
  assert.equal(latest.createdAt, original.createdAt);
  assert.deepEqual(latest.attachments, [{ id: "image", url: "image:pasted" }]);
  assert.deepEqual(store.navigations, [store.target.draftId]);
});

test("detached creation never navigates and clearing uses the original project identity", async () => {
  const state = new WorkbenchClientStateController();
  const store = sidebarFixture();
  await saveComposerDraft(state, store.target, (draft) => ({ ...draft, text: "save this detached draft safely" }), { ...autosave, detached: true });
  assert.equal(store.navigations.length, 0);
  const otherProject = { ...store.target, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("other") };
  await saveComposerDraft(state, otherProject, (draft) => ({ ...draft, text: "another project's draft" }), autosave);
  await clearComposerDraft(state, store.target);
  assert.equal(store.owner.read(fixtureIdentitySchemas.ProjectIdSchema.parse("project"), store.target.draftId), null);
  assert.ok(store.owner.read(fixtureIdentitySchemas.ProjectIdSchema.parse("other"), store.target.draftId));
});

test("below-threshold edits remain buffered until materialisation, including screenshots", async () => {
  const state = new WorkbenchClientStateController();
  const store = sidebarFixture();
  const session = new DraftSessionController(sidebarDraftToInput(null), {
    empty: () => sidebarDraftToInput(null),
    save: (update, options) => saveComposerDraft(state, store.target, update, options),
    schedule: () => 1,
    cancelSchedule: () => {},
  });
  session.attach();
  session.edit((draft) => ({ ...draft, text: "hi" }));
  await session.flush();
  session.edit((draft) => ({ ...draft, attachments: [{ id: "shot", url: "image:shot" }] }));
  await session.flush();
  assert.equal(store.records.size, 0);
  session.edit((draft) => ({ ...draft, text: "now this has enough words to persist" }));
  await session.flush();
  const saved = [...store.records.values()][0];
  assert.deepEqual(saved.attachments, [{ id: "shot", url: "image:shot" }]);
  session.detach();
});

test("questionnaire updates merge into latest content and isolate project and request identities", async () => {
  const state = new WorkbenchClientStateController();
  const identity = { daemonRegistrationId: "memory", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("one"), threadId: fixtureIdentitySchemas.ThreadReferenceSchema.parse("thread"), requestKey: "request" };
  await saveQuestionnaireDraft(state, identity, (draft) => ({ ...draft, customValues: { answer: "newer text" } }));
  await saveQuestionnaireDraft(state, { ...identity, requestKey: "other request" }, (draft) => ({ ...draft, customValues: { answer: "other request" } }));
  await saveQuestionnaireDraft(state, { ...identity, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("two") }, (draft) => ({ ...draft, customValues: { answer: "other project" } }));
  const saved = await saveQuestionnaireDraft(state, identity, (draft) => ({
    ...draft, attachments: [...draft.attachments, { id: "shot", url: "image:shot" }],
  }));
  assert.equal(saved.customValues.answer, "newer text");
  assert.equal(saved.attachments.length, 1);
  await clearQuestionnaireDraft(state, identity);
  assert.deepEqual(state.records("questionnaireDraft").map((record) => record.value.customValues.answer).sort(), ["other project", "other request"]);
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
