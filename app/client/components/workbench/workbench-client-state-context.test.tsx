/* No production exports. Mounted tests protect that a client-state selection re-renders only when what it selected changes. */
import "../../workbench/testing/jsdom-environment";

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import WorkbenchClientStateController from "../../workbench/state/WorkbenchClientStateController";
import { useWorkbenchClientState, WorkbenchClientStateContext } from "./workbench-client-state-context";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("an inline selection re-renders on its own fact, not on unrelated writes", async () => {
  const controller = new WorkbenchClientStateController({ mode: "memory" });
  const renders: string[] = [];
  function Probe() {
    const harness = useWorkbenchClientState(state => state.records.flatMap(record =>
      record.kind === "globalPreference" && record.preference.key === "harness" ? [String(record.preference.value)] : []));
    renders.push(harness.join(","));
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(WorkbenchClientStateContext.Provider, { value: controller }, createElement(Probe)));
    });
    const settled = renders.length;
    await act(async () => { await controller.put({ kind: "globalPreference", preference: { key: "userName", value: "Chiri" } }); });
    assert.equal(renders.length, settled, "an unrelated preference write re-rendered the selection");
    await act(async () => { await controller.put({ kind: "globalPreference", preference: { key: "harness", value: "claude" } }); });
    assert.equal(renders.at(-1), "claude");
  } finally {
    await act(async () => { root.unmount(); });
  }
});
