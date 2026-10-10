/* Exports: none. Tests protect press-drag confirmation and cancellation semantics. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { transitionPressDragMenu, type PressDragMenuState } from "./press-drag-menu-state";

const closed: PressDragMenuState = { kind: "closed" };
const press = () => transitionPressDragMenu(closed, { kind: "press", pointerId: 1, x: 10, y: 100 }).state;

test("selector clicks keep the menu open rather than activating a separate editor", () => {
  const result = transitionPressDragMenu(press(), {
    kind: "release", pointerId: 1, x: 10, y: 100, id: null, onTrigger: true,
  }, "menu");
  assert.equal(result.state.kind, "open");
  assert.equal(result.activate, false);
  assert.equal(transitionPressDragMenu(result.state, { kind: "select", id: "model" }, "menu").selectedId, "model");
});

test("pointing only previews and release confirms exactly once", () => {
  const moved = transitionPressDragMenu(press(), { kind: "move", pointerId: 1, x: 10, y: 50, id: "profile" });
  assert.equal(moved.selectedId, null);
  assert.equal(moved.state.kind !== "closed" && moved.state.activeId, "profile");
  const release = { kind: "release" as const, pointerId: 1, x: 10, y: 50, id: "profile", onTrigger: false };
  const confirmed = transitionPressDragMenu(moved.state, release);
  assert.equal(confirmed.selectedId, "profile");
  assert.equal(confirmed.state.kind, "closed");
  assert.equal(transitionPressDragMenu(confirmed.state, release).selectedId, null);
});

test("foreign pointers cannot select and outside release or cancellation discards preview", () => {
  const dragging = press();
  assert.deepEqual(transitionPressDragMenu(dragging, { kind: "release", pointerId: 2, x: 10, y: 50, id: "edit", onTrigger: false }).state, dragging);
  for (const event of [
    { kind: "cancel" as const },
    { kind: "release" as const, pointerId: 1, x: 500, y: 50, id: null, onTrigger: false },
  ]) {
    const result = transitionPressDragMenu(dragging, event);
    assert.equal(result.state.kind, "closed");
    assert.equal(result.selectedId, null);
  }
});

test("a trigger click activates its primary action exactly once", () => {
  const release = { kind: "release" as const, pointerId: 1, x: 10, y: 100, id: null, onTrigger: true };
  const result = transitionPressDragMenu(press(), release);
  assert.equal(result.state.kind, "closed");
  assert.equal(result.activate, true);
  assert.equal(transitionPressDragMenu(result.state, release).activate, false);
});

test("the keyboard quick menu still navigates and selects", () => {
  let state = transitionPressDragMenu(closed, { kind: "open", activeId: null }).state;
  const ids = ["edit", "older", "newer", "custom"];
  state = transitionPressDragMenu(state, { kind: "key", key: "End", ids }).state;
  state = transitionPressDragMenu(state, { kind: "key", key: "ArrowUp", ids }).state;
  assert.equal(transitionPressDragMenu(state, { kind: "key", key: "Enter", ids }).selectedId, "newer");
  assert.equal(transitionPressDragMenu(state, { kind: "select", id: "older" }).selectedId, "older");
  assert.equal(transitionPressDragMenu(state, { kind: "key", key: "Escape", ids }).state.kind, "closed");
});

test("a drag returning to the trigger cancels rather than becoming a click", () => {
  const moved = transitionPressDragMenu(press(), { kind: "move", pointerId: 1, x: 10, y: 50, id: "profile" }).state;
  const result = transitionPressDragMenu(moved, { kind: "release", pointerId: 1, x: 10, y: 100, id: null, onTrigger: true });
  assert.equal(result.state.kind, "closed");
  assert.equal(result.activate, false);
});
