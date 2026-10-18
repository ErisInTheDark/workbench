/* No production exports. Mounted tests protect that closing reports only after its exit animations finish, and never once reopened. */
import "../../../workbench/testing/jsdom-environment";

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import SurfacePanels from "./SurfacePanels";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

/** Each close starts one exit animation the test finishes by hand. */
function controlExitAnimations() {
  const finishers: Array<() => void> = [];
  const original = Element.prototype.getAnimations;
  Element.prototype.getAnimations = () => [{
    finished: new Promise<Animation>(resolve => { finishers.push(() => resolve({} as Animation)); }),
  } as Animation];
  return { finishers, restore: () => { Element.prototype.getAnimations = original; } };
}

async function mountPanels() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let closed = 0;
  const render = (activeKey: string | null) => act(async () => {
    root.render(createElement(SurfacePanels, {
      activeKey,
      children: createElement(SurfacePanels.Panel, { active: activeKey === "a", children: "a" }),
      onClosed: () => { closed++; },
    }));
  });
  return { closed: () => closed, render, unmount: () => act(async () => { root.unmount(); container.remove(); }) };
}

test("closing reports once its exit animations finish", async () => {
  const animations = controlExitAnimations();
  const panels = await mountPanels();
  try {
    await panels.render("a");
    await panels.render(null);
    assert.equal(panels.closed(), 0, "content stays while it animates out");

    await act(async () => { animations.finishers.at(-1)!(); });
    assert.equal(panels.closed(), 1);
  } finally {
    animations.restore();
    await panels.unmount();
  }
});

test("reopening before the exit finishes keeps content", async () => {
  const animations = controlExitAnimations();
  const panels = await mountPanels();
  try {
    await panels.render("a");
    await panels.render(null);
    await panels.render("a");
    await act(async () => { for (const finish of animations.finishers) finish(); });
    assert.equal(panels.closed(), 0);
  } finally {
    animations.restore();
    await panels.unmount();
  }
});
