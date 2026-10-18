/* No production exports. Mounted tests protect when the status row opens panels by itself and when it leaves them to the user. */
import "../../../workbench/testing/jsdom-environment";

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import ThreadStatusRow, { type ThreadStatusPanel } from "./ThreadStatusRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout or animations; nothing here measures or waits on them.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.getAnimations ??= () => [];

function panel(id: string): ThreadStatusPanel {
  return { id, label: id, segments: [{ key: id, content: id }], render: () => id };
}

const panels = [panel("arc"), panel("todos")];

async function mountRow() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (props: Partial<ComponentProps<typeof ThreadStatusRow>>) => act(async () => {
    root.render(createElement(ThreadStatusRow, { live: null, panels, ...props }));
  });
  const open = () => container.querySelector("[data-thread-status-panel][data-active=true]")?.getAttribute("data-thread-status-panel") ?? null;
  const click = (id: string) => act(async () => {
    container.querySelector<HTMLButtonElement>(`button[aria-label="${id}"]`)!.click();
  });
  return { click, open, render, unmount: () => act(async () => { root.unmount(); container.remove(); }) };
}

test("an idle thread opens its attention panel once per key, never holding it open", async () => {
  const row = await mountRow();
  try {
    await row.render({ attention: { key: "proposals:a", panel: "arc" } });
    assert.equal(row.open(), "arc", "fresh open shows the attention panel");

    await row.click("arc");
    await row.render({ attention: { key: "proposals:a", panel: "arc" } });
    assert.equal(row.open(), null, "an unchanged key leaves the user's close alone");

    await row.render({ attention: { key: "todos:1:0", panel: "todos" } });
    assert.equal(row.open(), "todos", "new work opens its panel");
  } finally {
    await row.unmount();
  }
});

test("a busy thread opens panels only by user action", async () => {
  const row = await mountRow();
  try {
    await row.render({ attention: { key: "proposals:a", panel: "arc" }, busy: true });
    assert.equal(row.open(), null);

    await row.render({ attention: { key: "todos:1:0", panel: "todos" }, busy: true });
    assert.equal(row.open(), null, "new work waits while busy");

    await row.click("arc");
    assert.equal(row.open(), "arc");
  } finally {
    await row.unmount();
  }
});

test("getting busy closes auto-opened panels but keeps user-opened ones, and going idle reopens attention", async () => {
  const row = await mountRow();
  const attention = { key: "proposals:a", panel: "arc" };
  try {
    await row.render({ attention });
    assert.equal(row.open(), "arc");
    await row.render({ attention, busy: true });
    assert.equal(row.open(), null, "the auto-opened panel yields to the busy thread");

    await row.render({ attention });
    assert.equal(row.open(), "arc", "the turn ending reopens unchanged attention");

    await row.click("todos");
    await row.render({ attention, busy: true });
    assert.equal(row.open(), "todos", "a panel the user opened stays open");
  } finally {
    await row.unmount();
  }
});
