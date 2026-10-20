/*
 * No production exports. Tests protect folder disclosure persistence through the sidebar owner.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { FolderIdSchema } from "workbench-shared/workbench/identity";
import { getWorkbenchHomeFolderKey } from "workbench-shared/workbench/thread/home-thread-display-order";
import WorkbenchClientStateController from "../../workbench/state/WorkbenchClientStateController";
import { WorkbenchClientStateContext } from "./workbench-client-state-context";
import { useWorkbenchSidebarPreferences, type WorkbenchSidebarPreferencesValue } from "./workbench-sidebar-preferences-context";
import WorkbenchSidebarPreferencesProvider from "./WorkbenchSidebarPreferencesProvider";

const FOLDER_ID = FolderIdSchema.parse("0b5c2a52-34f6-4c39-9f7c-4c1d1f3d2a10");

function renderPreferences(controller: WorkbenchClientStateController, projectId: string) {
  const captured: { value?: WorkbenchSidebarPreferencesValue } = {};
  function Capture() {
    captured.value = useWorkbenchSidebarPreferences();
    return null;
  }
  renderToStaticMarkup(
    <WorkbenchClientStateContext.Provider value={controller}>
      <WorkbenchSidebarPreferencesProvider projectId={projectId}>
        <Capture />
      </WorkbenchSidebarPreferencesProvider>
    </WorkbenchClientStateContext.Provider>,
  );
  if (!captured.value) throw new Error("Sidebar preferences did not render.");
  return captured.value;
}

test("a folder opened from multi-project home stays open under its own project in every view", async () => {
  const controller = new WorkbenchClientStateController({ mode: "memory" });

  renderPreferences(controller, "").setFolderOpen("logical-alpha", FOLDER_ID, true);
  await Promise.resolve();

  // The app-state schema rejects an empty project address, so the record must carry the folder's project.
  assert.deepEqual(controller.records("sidebarFolder").map(record => record.projectId), ["logical-alpha"]);
  const key = getWorkbenchHomeFolderKey("logical-alpha", FOLDER_ID);
  assert.equal(renderPreferences(controller, "").openFolderKeys.has(key), true);
  assert.equal(renderPreferences(controller, "logical-alpha").openFolderKeys.has(key), true);

  renderPreferences(controller, "logical-alpha").setFolderOpen("logical-alpha", FOLDER_ID, false);
  await Promise.resolve();
  assert.equal(renderPreferences(controller, "").openFolderKeys.has(key), false);
});
