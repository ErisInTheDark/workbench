/* No production exports. Protect that an Options set shows exactly one option's preview: the synced pick, or the first. */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControlStateContext, type ControlStateStore } from "../ui/control-state";
import Options, { Option } from "./Options";

const set = (stored: Record<string, unknown>) => {
  const store: ControlStateStore = { get: id => stored[id], set: () => {}, subscribe: () => () => {} };
  const children = [
    createElement(Option, { key: "keep", title: "keep" }, createElement("p", null, "keep preview")),
    createElement(Option, { key: "card", title: "card" }, createElement("p", null, "card preview")),
  ];
  return renderToStaticMarkup(createElement(ControlStateContext.Provider, { value: store }, createElement(Options, { children, label: "git arc" })));
};

test("the user's synced pick is the one preview shown, and an unpicked set shows its first option", () => {
  const picked = set({ "git arc": "card" });
  assert.match(picked, /card preview/u);
  assert.doesNotMatch(picked, /keep preview/u);
  const fresh = set({});
  assert.match(fresh, /keep preview/u);
  assert.doesNotMatch(fresh, /card preview/u);
});
