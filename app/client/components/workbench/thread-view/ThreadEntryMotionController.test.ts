/*
 * No production exports. Tests protect one-time thread entry motion across initial render and remounts.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";

import ThreadEntryMotionController, {
  getThreadEntryMotionIdentities,
  getThreadEntryMotionIdentity,
  getThreadFileChangeMotionIdentity,
} from "./ThreadEntryMotionController";

const user = (id: string, clientId: string | null): ThreadItem => ({
  clientId, content: [], id, type: "userMessage",
});

test("selected-thread items seed without motion and new entries animate only once", () => {
  const existing = user("history-user", "history-client");
  const controller = new ThreadEntryMotionController(getThreadEntryMotionIdentities(existing));

  assert.equal(controller.shouldAnimate(getThreadEntryMotionIdentity(existing)), false);
  assert.equal(controller.shouldAnimate("new-agent"), true);

  controller.commit("new-agent");
  assert.equal(controller.shouldAnimate("new-agent"), false);
  assert.equal(controller.shouldAnimate("new-tool"), true);
});

test("presentation remounts share the logical entry admission", () => {
  const controller = new ThreadEntryMotionController();

  assert.equal(controller.shouldAnimate("turn:item:user-message"), true);
  controller.commit("turn:item:user-message");

  assert.equal(controller.shouldAnimate("turn:item:user-message"), false);
});

for (const inputKind of ["initial message", "steer"] as const) {
  test(`optimistic and canonical ${inputKind} presentations share client identity`, () => {
    const controller = new ThreadEntryMotionController();
    const optimistic = user("optimistic-item", `client-${inputKind}`);
    const canonical = user("canonical-item", `client-${inputKind}`);

    const optimisticIdentity = getThreadEntryMotionIdentity(optimistic);
    const canonicalIdentity = getThreadEntryMotionIdentity(canonical);
    assert.equal(controller.shouldAnimate(optimisticIdentity), true);
    controller.commit(optimisticIdentity);
    assert.equal(controller.shouldAnimate(canonicalIdentity), false);
  });
}

test("file rows seed independently and a later row remains eligible", () => {
  const item: ThreadItem = {
    changes: [
      { diff: "", kind: { type: "add" }, path: "first.ts" },
      { diff: "", kind: { move_path: null, type: "update" }, path: "second.ts" },
    ],
    id: "file-item",
    status: "inProgress",
    type: "fileChange",
  };
  const controller = new ThreadEntryMotionController(getThreadEntryMotionIdentities(item));

  assert.equal(controller.shouldAnimate(getThreadFileChangeMotionIdentity(item.id, 0)), false);
  assert.equal(controller.shouldAnimate(getThreadFileChangeMotionIdentity(item.id, 1)), false);
  assert.equal(controller.shouldAnimate(getThreadFileChangeMotionIdentity(item.id, 2)), true);
});
