/*
 * No production exports. Protect immediate draft launch presentation, admission, retry, and view-independent ownership.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DraftIdSchema } from "workbench-shared/workbench/identity";
import type { ThreadPayload } from "workbench-shared/types";
import type { UserInput } from "workbench-shared/workbench/thread/workbench-thread-items";
import { getWorkbenchInputState } from "workbench-shared/workbench/thread/thread-input-item";
import createDraftThreadSource from "./DraftThreadSource";
import ThreadStore from "./ThreadStore";
import { getLiveThreadActivity } from "../../components/workbench/thread-view/thread-live-activity";
import { ThreadTurnDetails } from "../../components/workbench/thread-view/thread-view-items";

function fixture(id = "draft") {
  const draftId = DraftIdSchema.parse(id);
  const draft: ThreadPayload = {
    id: draftId, isDraft: true, harness: "codex", name: "Create new thread", preview: "",
    model: null, reasoningEffort: null, serviceTier: null, agentPath: null,
    createdAt: 1, updatedAt: 1, status: "idle", cwd: "C:/project", source: "codex", path: null,
    agentNickname: null, agentRole: null, tokenUsage: null, turnHistory: [], turns: [],
  };
  const listeners = new Set<() => void>();
  const store = new ThreadStore("project", { kind: "draft", draftId }, publish => createDraftThreadSource({
    draftId,
    readDraft: () => draft,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    readRateLimits: () => null,
    watchRateLimits: () => {},
    controls: {
      setCurrentThreadAgent: () => {}, setCurrentThreadModel: () => {},
      setCurrentThreadReasoningEffort: () => {}, setCurrentThreadServiceTier: () => {},
      setCurrentThreadComposerSettings: () => {},
    },
  }, publish));
  return { store, changed: () => { for (const listener of listeners) listener(); } };
}

const input: UserInput[] = [
  { type: "text", text: "launch preview words", text_elements: [] },
  { type: "image", url: "data:image/png;base64,aW1hZ2U=" },
];

test("submission immediately renders the initial input and connecting activity before acceptance", async context => {
  const { store } = fixture();
  context.after(() => store.dispose());
  const admission = Promise.withResolvers<boolean>();
  let submissions = 0;
  const sending = store.actions.submitDraft(input, () => {
    submissions++;
    assert.equal(store.getSlice("turns").turns.length, 1, "publish before saving or dispatching");
    return admission.promise;
  });
  const pending = store.getSlice("turns");
  const turn = pending.turns[0]!;
  assert.equal(pending.liveTurnId, turn.id);
  assert.equal(turn.items.length, 1);
  const message = turn.items[0]!;
  assert.equal(message.type, "userMessage");
  assert.deepEqual(message.content, input);
  assert.deepEqual(getWorkbenchInputState(message), { kind: "optimistic", placement: "initial", status: "pending" });
  assert.equal(getLiveThreadActivity({ pendingUserInputRequest: null, turn })?.title, "Connecting");
  const html = renderToStaticMarkup(createElement(ThreadTurnDetails, { threadId: store.threadId, turn }));
  assert.ok(html.includes("launch preview words"), "the shared renderer can show the submitted input");
  assert.equal(await store.actions.submitDraft(input, async () => { submissions++; return true; }), false);
  assert.equal(submissions, 1);
  admission.resolve(true);
  assert.equal(await sending, true);
  const accepted = store.getSlice("turns").turns[0]!;
  assert.equal(accepted.items[0]!.id, message.id, "acceptance retains the same message");
  assert.deepEqual(getWorkbenchInputState(accepted.items[0]!), { kind: "optimistic", placement: "initial", status: "sent" });
  assert.equal(await store.actions.submitDraft(input, async () => { submissions++; return true; }), false);
  assert.equal(submissions, 1, "an accepted draft cannot launch again");
});

test("leaving, reopening, and draft updates retain one pending launch without affecting another draft", async context => {
  const first = fixture("first");
  const second = fixture("second");
  context.after(() => { first.store.dispose(); second.store.dispose(); });
  const admission = Promise.withResolvers<boolean>();
  const release = first.store.acquire("view");
  const sending = first.store.actions.submitDraft(input, () => admission.promise);
  const turn = first.store.getSlice("turns").turns[0];
  release();
  first.changed();
  const reopen = first.store.acquire("view");
  assert.equal(first.store.getSlice("turns").turns[0], turn);
  assert.equal(second.store.getSlice("turns").turns.length, 0);
  reopen();
  admission.resolve(true);
  assert.equal(await sending, true);
  assert.equal(first.store.getSlice("turns").turns.length, 1);
});

for (const failure of ["rejected", "not-sent"] as const) {
  test(`${failure} submission restores the draft view and allows a fresh retry`, async context => {
    const { store } = fixture();
    context.after(() => store.dispose());
    const admission = Promise.withResolvers<boolean>();
    const sending = store.actions.submitDraft(input, () => admission.promise);
    const original = store.getSlice("turns").turns[0]!;
    if (failure === "rejected") {
      const rejected = assert.rejects(sending, /save failed/);
      admission.reject(new Error("save failed"));
      await rejected;
    } else {
      admission.resolve(false);
      assert.equal(await sending, false);
    }
    assert.equal(store.getSlice("turns").turns.length, 0);
    assert.equal(store.getSlice("turns").liveTurnId, null);
    assert.equal(store.getSlice("summary").draftDocument?.isDraft, true);
    assert.equal(await store.actions.submitDraft(input, async () => true), true);
    assert.notEqual(store.getSlice("turns").turns[0]!.id, original.id);
  });
}
