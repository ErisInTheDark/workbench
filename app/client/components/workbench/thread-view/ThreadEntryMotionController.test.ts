/*
 * No production exports. Tests protect one-time thread entry motion across initial render and remounts, and finding a
 * mounted entry for an entry absorbing it.
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

test("history landing above seen entries never animates, while entries after them still do", () => {
  const controller = new ThreadEntryMotionController(["item:b", "item:c"]);
  controller.admit(["item:a0", "item:a1", "item:b", "item:c", "item:d"]);
  assert.equal(controller.shouldAnimate("item:a0"), false);
  assert.equal(controller.shouldAnimate("item:a1"), false);
  assert.equal(controller.shouldAnimate("item:d"), true);
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

test("an absorbing entry finds a tracked entry where it is now, and nothing once it unmounted", () => {
  const controller = new ThreadEntryMotionController();
  let top = 480;
  const element = { getBoundingClientRect: () => ({ top }) as DOMRect };
  const untrack = controller.track("item:started", element);
  assert.equal(controller.topOf("item:started"), 480);
  top = 300;
  assert.equal(controller.topOf("item:started"), 300);
  // A remount tracks its new element before the old one's cleanup runs; that cleanup must not drop the new one.
  const remounted = { getBoundingClientRect: () => ({ top: 90 }) as DOMRect };
  const untrackRemount = controller.track("item:started", remounted);
  untrack();
  assert.equal(controller.topOf("item:started"), 90);
  untrackRemount();
  assert.equal(controller.topOf("item:started"), null);
});

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
