/* No production exports. Protect where a control's value lives: local without a store or an id, the store's otherwise, and only real changes written to the store. */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControlStateContext, useControlState, type ControlStateStore } from "./control-state";

function fakeStore(values: Record<string, unknown>) {
  const writes: Array<[string, unknown]> = [];
  const store: ControlStateStore = {
    get: id => values[id],
    set: (id, value) => { writes.push([id, value]); values[id] = value; },
    subscribe: () => () => {},
  };
  return { store, writes };
}

/** Renders one control and hands back what it read, its setter and whether it is synced. */
function render(id: string | undefined, store: ControlStateStore | null) {
  let seen: ReturnType<typeof useControlState<string>> | null = null;
  function Control() {
    seen = useControlState(id, "first");
    return null;
  }
  const tree: ReactNode = createElement(Control);
  renderToStaticMarkup(store ? createElement(ControlStateContext.Provider, { value: store }, tree) : tree);
  return seen!;
}

test("without a store, or without an id, a control keeps local state", () => {
  const { store, writes } = fakeStore({ tab: "card" });
  const [alone, , aloneSynced] = render("tab", null);
  assert.deepEqual([alone, aloneSynced], ["first", false]);
  const [value, set, synced] = render(undefined, store);
  assert.deepEqual([value, synced], ["first", false]);
  set("step");
  assert.deepEqual(writes, []);
});

test("an id'd control under a store reads and writes the store, skipping unchanged values", () => {
  const { store, writes } = fakeStore({ tab: "card" });
  const [value, set, synced] = render("tab", store);
  assert.deepEqual([value, synced], ["card", true]);
  set("card");
  set("step");
  assert.deepEqual(writes, [["tab", "step"]]);
  assert.equal(render("other", store)[0], "first", "an unset control starts from its initial value");
});
