/* No production exports. Mounted tests protect that an added todo's card acts on the thread's live todo, and only while the thread lists it. */
import "../../../workbench/testing/jsdom-environment";

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import type { WorkbenchThreadTodo } from "workbench-shared/workbench/thread/thread-todo";
import ThreadTodoCommandItem from "./ThreadTodoCommandItem";
import { ThreadTodoControlsContext, type ThreadTodoControls } from "./thread-todo-controls";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.getAnimations ??= () => [];
// jsdom has no layout, so the todo's editable text reads as its plain text content.
if (!("innerText" in HTMLElement.prototype)) {
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get(this: HTMLElement) { return this.textContent ?? ""; },
    set(this: HTMLElement, value: string) { this.textContent = value; },
  });
}

const TEXT = "Give recall rows the step-row line — they still use the old disclosure";
const todo: WorkbenchThreadTodo = { createdAt: 1, id: 3, required: false, text: TEXT };

function controlsFor(todos: readonly WorkbenchThreadTodo[], calls: string[]): ThreadTodoControls {
  return {
    todos,
    selection: { deselect: () => {}, isSelected: () => false, selected: [], toggle: reference => { calls.push(`pick ${reference.kind}`); } },
    remove: async (id) => { calls.push(`remove ${id}`); },
    setRequired: async (id, required) => { calls.push(`required ${id} ${required}`); },
    setText: async (id, text) => { calls.push(`text ${id} ${text}`); },
  };
}

async function mount(controls: ThreadTodoControls | null) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (value: ThreadTodoControls | null) => act(async () => {
    root.render(createElement(ThreadTodoControlsContext.Provider, { value }, createElement(ThreadTodoCommandItem, {
      durationMs: 12, operation: { action: "add", required: false, text: TEXT }, outcome: "completed", output: "Added todo 3.",
    })));
  });
  await render(controls);
  await act(async () => { container.querySelector("summary")!.click(); });
  const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  return { button, container, render, unmount: () => act(async () => { root.unmount(); container.remove(); }) };
}

test("an added todo's line is its id and title, and opening it acts on the live todo", async () => {
  const calls: string[] = [];
  const card = await mount(controlsFor([todo], calls));
  try {
    const line = card.container.querySelector("summary")!.textContent ?? "";
    assert.match(line, /#3/u);
    assert.match(line, /Give recall rows the step-row line/u);
    assert.doesNotMatch(line, /old disclosure/u);

    await act(async () => { card.button("Attach todo 3")!.click(); });
    await act(async () => { card.button("Optional")!.click(); });
    await act(async () => { card.button("Remove todo 3")!.click(); });
    assert.deepEqual(calls, ["pick todo", "required 3 true", "remove 3"]);

    await card.render(controlsFor([], calls));
    assert.equal(card.button("Remove todo 3"), null);
    assert.match(card.container.textContent ?? "", /No longer on the list/u);
  } finally {
    await card.unmount();
  }
});

test("outside a live thread view the todo opens read-only", async () => {
  const card = await mount(null);
  try {
    assert.match(card.container.textContent ?? "", /they still use the old disclosure/u);
    assert.equal(card.container.querySelector("button"), null);
  } finally {
    await card.unmount();
  }
});
