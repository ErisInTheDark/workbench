/*
 * No production exports. Tests protect which preference decides whether code-mode executions show as steps.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import WorkbenchClientStateController from "../../../workbench/state/WorkbenchClientStateController";
import { writeGlobalWorkbenchSetting } from "../../../workbench/state/workbench-settings";
import { WorkbenchClientStateContext } from "../workbench-client-state-context";
import { useThreadCodeDetails, WorkbenchThreadDisplaySettingsContext } from "./WorkbenchThreadDisplaySettingsContext";

function Probe() {
  return String(useThreadCodeDetails());
}

test("code details follow the owning pane's preference, falling back to the global setting", async () => {
  const controller = new WorkbenchClientStateController({ mode: "memory" });
  const read = (pane: boolean | null) => renderToStaticMarkup(createElement(WorkbenchClientStateContext.Provider, { value: controller },
    createElement(WorkbenchThreadDisplaySettingsContext.Provider, { value: pane }, createElement(Probe))));
  assert.equal(read(null), "false");
  await writeGlobalWorkbenchSetting(controller, "threadCodeDetails", true);
  assert.equal(read(null), "true");
  assert.equal(read(false), "false");
  assert.equal(read(true), "true");
});
