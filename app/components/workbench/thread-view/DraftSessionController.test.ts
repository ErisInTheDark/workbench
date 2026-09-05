/*
 * Keywords: draft, composer, questionnaire, hydration, navigation, attachment, submission.
 * No production exports. Tests protect the shared lifecycle with explicit save and scheduler boundaries.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchComposerInputDraft, WorkbenchQuestionnaireDraft } from "workbench-shared/types";

import DraftSessionController, { type DraftSessionContent, type DraftSessionPorts } from "./DraftSessionController";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function fixture<Draft extends DraftSessionContent>(initial: Draft, empty: () => Draft) {
  let saved = initial;
  let writes = 0;
  const scheduled = new Map<number, () => void>();
  let nextHandle = 0;
  const ports: DraftSessionPorts<Draft> = {
    empty,
    save(update) {
      writes += 1;
      saved = update(saved);
      return saved;
    },
    schedule(callback) { const handle = ++nextHandle; scheduled.set(handle, callback); return handle; },
    cancelSchedule(handle) { scheduled.delete(handle); },
  };
  return {
    create() { const session = new DraftSessionController(saved, ports); session.attach(); return session; },
    get saved() { return saved; },
    get writes() { return writes; },
    set saved(value: Draft) { saved = value; },
    ports,
    scheduled,
  };
}

const emptyComposer = (): WorkbenchComposerInputDraft => ({ text: "", attachments: [], updatedAt: 0 });
const emptyQuestionnaire = (): WorkbenchQuestionnaireDraft => ({ customValues: {}, selectedValues: {}, attachments: [], updatedAt: 0 });

for (const kind of ["composer", "questionnaire"] as const) {
  test(`${kind} drafts accept newer hydration after saving and unchanged views never write`, async () => {
    const initial = kind === "composer" ? emptyComposer() : emptyQuestionnaire();
    const store = fixture(initial, () => initial);
    const oldView = store.create();
    oldView.receive(initial);
    assert.equal(store.writes, 0);
    oldView.edit((draft) => "text" in draft ? { ...draft, text: "edited" } : { ...draft, customValues: { answer: "edited" } });
    await oldView.flush();
    const newer = "text" in initial ? { ...initial, text: "newer" } : { ...initial, customValues: { answer: "newer" } };
    store.saved = newer;
    oldView.receive(newer);
    assert.deepEqual(oldView.getSnapshot().draft, newer);
    oldView.detach();
    await oldView.flush();
    assert.equal(store.saved, newer);
    assert.equal(store.writes, 1);
    assert.equal(store.scheduled.size, 0);
  });
}

test("questionnaire edits and screenshots survive repeated navigation and unchanged teardown", async () => {
  const store = fixture(emptyQuestionnaire(), emptyQuestionnaire);
  const first = store.create();
  first.edit((draft) => ({ ...draft, customValues: { answer: "first" }, attachments: [{ id: "first", url: "image:first" }] }));
  first.detach();
  await first.flush();
  const untouched = store.create();
  const second = store.create();
  second.edit((draft) => ({
    ...draft,
    customValues: { answer: "edited" },
    selectedValues: { choice: ["selected"] },
    attachments: [...draft.attachments, { id: "second", url: "image:second" }],
  }));
  second.detach();
  await second.flush();
  untouched.detach();
  await untouched.flush();
  assert.deepEqual(store.create().getSnapshot().draft, {
    ...emptyQuestionnaire(), customValues: { answer: "edited" }, selectedValues: { choice: ["selected"] },
    attachments: [{ id: "first", url: "image:first" }, { id: "second", url: "image:second" }],
  });
});

test("late images append to the originating draft's latest content after leaving", async () => {
  const store = fixture(emptyComposer(), emptyComposer);
  const original = store.create();
  const image = deferred<string>();
  const attaching = original.attachImages(async () => [{ url: await image.promise }]);
  original.detach();
  const reopened = store.create();
  reopened.edit((draft) => ({ ...draft, text: "newer text" }));
  await reopened.flush();
  image.resolve("image:pasted");
  await attaching;
  await original.flush();
  assert.equal(store.saved.text, "newer text");
  assert.deepEqual(store.saved.attachments.map(({ url }) => url), ["image:pasted"]);
  assert.equal(original.getSnapshot().isAttaching, false);
});

test("a save acknowledgement cannot replace newer hydration received while saving", async () => {
  const store = fixture(emptyComposer(), emptyComposer);
  const completion = deferred<WorkbenchComposerInputDraft>();
  store.ports.save = () => completion.promise;
  const session = store.create();
  session.edit((draft) => ({ ...draft, text: "first" }));
  const saving = session.flush();
  const latest = { ...emptyComposer(), text: "newer canonical draft" };
  session.receive(latest);
  completion.resolve({ ...emptyComposer(), text: "first" });
  await saving;
  assert.equal(session.getSnapshot().draft.text, latest.text);
});

test("navigation drains edits made during an in-flight save without losing later fields", async () => {
  const store = fixture(emptyComposer(), emptyComposer);
  const completion = deferred<void>();
  const save = store.ports.save;
  let firstSave = true;
  store.ports.save = async (update, options) => {
    if (firstSave) { firstSave = false; await completion.promise; }
    return await save(update, options);
  };
  const session = store.create();
  session.edit((draft) => ({ ...draft, text: "first" }));
  const first = session.flush();
  session.edit((draft) => ({ ...draft, text: "second" }));
  session.detach();
  const drained = session.flush();
  completion.resolve();
  await first;
  await drained;
  assert.equal(store.saved.text, "second");
  assert.equal(store.writes, 2);
  assert.equal(store.scheduled.size, 0);
});

test("save failure retains edits, reports failure and does not spin retries", async (t) => {
  t.mock.method(console, "error", () => {});
  const store = fixture(emptyComposer(), emptyComposer);
  const save = store.ports.save;
  store.ports.save = () => { throw new Error("storage unavailable"); };
  const session = store.create();
  session.edit((draft) => ({ ...draft, text: "keep me" }));
  assert.equal(await session.flush(), false);
  assert.equal(session.getSnapshot().draft.text, "keep me");
  assert.match(session.getSnapshot().error, /storage unavailable/u);
  assert.equal(store.scheduled.size, 0);
  store.ports.save = save;
  assert.equal(await session.flush(), true);
  assert.equal(store.saved.text, "keep me");
});

test("reset is a real edit, not stale hydration overwriting content", async () => {
  const store = fixture({ ...emptyComposer(), text: "remove me" }, emptyComposer);
  const session = store.create();
  session.edit(emptyComposer);
  session.receive({ ...emptyComposer(), text: "old saved content" });
  await session.flush();
  assert.equal(store.saved.text, "");
});

test("submission waits for earlier saves and success cannot resurrect a cleared draft", async () => {
  const store = fixture(emptyComposer(), emptyComposer);
  const saved = deferred<WorkbenchComposerInputDraft>();
  store.ports.save = () => saved.promise;
  const session = store.create();
  session.edit((draft) => ({ ...draft, text: "send this" }));
  const saving = session.flush();
  let sent = false;
  const submitting = session.submit(async (draft) => {
    assert.equal(draft.text, "send this");
    sent = true;
    store.saved = emptyComposer();
    return true;
  });
  assert.equal(sent, false);
  saved.resolve({ ...emptyComposer(), text: "send this" });
  await saving;
  assert.equal(await submitting, true);
  session.receive({ ...emptyComposer(), text: "stale echo" });
  session.detach();
  await session.flush();
  assert.equal(session.getSnapshot().draft.text, "");
  assert.equal(store.saved.text, "");
});

test("a new screenshot can start the next draft after successful submission", async () => {
  const store = fixture(emptyComposer(), emptyComposer);
  const session = store.create();
  session.edit((draft) => ({ ...draft, text: "first message" }));
  await session.submit(async () => {
    store.saved = emptyComposer();
    return true;
  });
  session.receive({ ...emptyComposer(), text: "stale echo" });
  await session.attachImages(async () => [{ url: "image:next-message" }]);
  await session.flush();
  assert.equal(store.saved.text, "");
  assert.deepEqual(store.saved.attachments.map(({ url }) => url), ["image:next-message"]);
});

test("failed submission retains input and attachment failure unblocks submission", async (t) => {
  t.mock.method(console, "error", () => {});
  const store = fixture(emptyComposer(), emptyComposer);
  const session = store.create();
  session.edit((draft) => ({ ...draft, text: "keep after rejection" }));
  assert.equal(await session.submit(async () => false), false);
  assert.equal(session.getSnapshot().draft.text, "keep after rejection");
  const image = deferred<string>();
  const reading = session.attachImages(async () => [{ url: await image.promise }]);
  assert.equal(await session.submit(async () => true), false);
  image.reject(new Error("image read failed"));
  await reading;
  assert.equal(session.getSnapshot().isAttaching, false);
  assert.match(session.getSnapshot().error, /image read failed/u);
  session.detach();
  await session.flush();
});

test("reset invalidates an unfinished screenshot read", async () => {
  const store = fixture(emptyComposer(), emptyComposer);
  const session = store.create();
  const image = deferred<string>();
  const reading = session.attachImages(async () => [{ url: await image.promise }]);
  await session.reset();
  image.resolve("image:cancelled");
  await reading;
  await session.flush();
  assert.deepEqual(store.saved.attachments, []);
});

test("retrying after a lost acknowledgement does not append the same screenshot twice", async (t) => {
  t.mock.method(console, "error", () => {});
  const store = fixture(emptyComposer(), emptyComposer);
  const save = store.ports.save;
  store.ports.save = async (update, options) => {
    await save(update, options);
    throw new Error("acknowledgement lost");
  };
  const session = store.create();
  await session.attachImages(async () => [{ url: "image:once" }]);
  assert.equal(await session.flush(), false);
  store.ports.save = save;
  await session.flush();
  assert.equal(store.saved.attachments.length, 1);
});

test("an explicit flush waits for the follow-up save, not just the older in-flight write", async () => {
  const store = fixture(emptyComposer(), emptyComposer);
  const first = deferred<void>();
  const second = deferred<void>();
  const secondStarted = deferred<void>();
  const save = store.ports.save;
  let writes = 0;
  store.ports.save = async (update, options) => {
    if (++writes === 1) await first.promise;
    else { secondStarted.resolve(); await second.promise; }
    return await save(update, options);
  };
  const session = store.create();
  session.edit((draft) => ({ ...draft, text: "first" }));
  const initialFlush = session.flush();
  session.edit((draft) => ({ ...draft, text: "second" }));
  session.detach();
  let drained = false;
  const finalFlush = session.flush().then(() => { drained = true; });
  first.resolve();
  await secondStarted.promise;
  await Promise.resolve();
  const settledBeforeAcknowledgement = drained;
  second.resolve();
  await initialFlush;
  await finalFlush;
  await session.flush();
  assert.equal(settledBeforeAcknowledgement, false);
  assert.equal(store.saved.text, "second");
});
