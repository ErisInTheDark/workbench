/*
 * No production exports. Tests protect home folder disclosure persistence through the sidebar owner.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import WorkbenchClientStateController from "../../workbench/state/WorkbenchClientStateController";
import { WorkbenchClientStateContext } from "./workbench-client-state-context";
import type { WorkbenchSidebarPreferencesValue } from "./workbench-sidebar-preferences-context";
import WorkbenchSidebarPreferencesProvider from "./WorkbenchSidebarPreferencesProvider";

function renderPreferences(controller: WorkbenchClientStateController) {
  const captured: { value?: WorkbenchSidebarPreferencesValue } = {};
  renderToStaticMarkup(
    <WorkbenchClientStateContext.Provider value={controller}>
      <WorkbenchSidebarPreferencesProvider projectId="">
        {(preferences) => {
          captured.value = preferences;
          return null;
        }}
      </WorkbenchSidebarPreferencesProvider>
    </WorkbenchClientStateContext.Provider>,
  );
  if (!captured.value) throw new Error("Sidebar preferences did not render.");
  return captured.value;
}

test("home folder disclosure saves and restores thread and pinned folders", async () => {
  const controller = new WorkbenchClientStateController({ mode: "memory" });
  const preferences = renderPreferences(controller);

  preferences.setFolderOpen("threads", "thread-folder", true);
  preferences.setFolderOpen("pinned", "pinned-folder", true);
  await Promise.resolve();

  const restored = renderPreferences(controller).preferences;
  assert.deepEqual(restored.threadFolderIds, ["thread-folder"]);
  assert.deepEqual(restored.pinnedFolderIds, ["pinned-folder"]);
});
