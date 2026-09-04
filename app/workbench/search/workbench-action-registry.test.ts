/*
 * No production exports. Tests protect workspace action shortcut matching and live handler delegation. Keywords: search, action, shortcut, keyboard.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  handleWorkbenchActionShortcut,
  runWorkbenchAction,
  type WorkbenchActionContext,
} from "./workbench-action-registry";

function context() {
  const calls: string[] = [];
  const value: WorkbenchActionContext = {
    createThread: () => calls.push("create"),
    getSidebarThreadLinks: () => Array.from({ length: 10 }, (_, index) => ({
      click: () => calls.push(`thread:${index + 1}`),
    })),
    hasProject: true,
    home: () => calls.push("home"),
    openSearch: () => calls.push("search"),
    openSettings: () => calls.push("settings"),
    toggleSidebar: () => calls.push("sidebar"),
    zoomIn: () => calls.push("zoom-in"),
    zoomOut: () => calls.push("zoom-out"),
  };
  return { calls, value };
}

function key(keyValue: string, options: Partial<KeyboardEvent> = {}) {
  let prevented = false;
  return {
    altKey: false,
    code: "",
    ctrlKey: true,
    defaultPrevented: false,
    key: keyValue,
    metaKey: false,
    preventDefault: () => { prevented = true; },
    repeat: false,
    shiftKey: false,
    ...options,
    wasPrevented: () => prevented,
  } as KeyboardEvent & { wasPrevented(): boolean };
}

test("every requested control chord invokes its registered owner", () => {
  const { calls, value } = context();
  for (const event of [
    key("p"), key("b"), key("+", { shiftKey: true }), key("-"),
    key("1"), key("0"), key("m"), key("h"), key("o"),
  ]) {
    assert.equal(handleWorkbenchActionShortcut(event, value), true);
    assert.equal(event.wasPrevented(), true);
  }
  assert.deepEqual(calls, [
    "search", "sidebar", "zoom-in", "zoom-out",
    "thread:1", "thread:10", "create", "home", "settings",
  ]);
});

test("unavailable actions do not consume browser shortcuts", () => {
  const { value } = context();
  value.hasProject = false;
  const create = key("m");
  assert.equal(handleWorkbenchActionShortcut(create, value), false);
  assert.equal(create.wasPrevented(), false);
  assert.equal(runWorkbenchAction("view-thread-10", { ...value, getSidebarThreadLinks: () => [] }), false);
});
