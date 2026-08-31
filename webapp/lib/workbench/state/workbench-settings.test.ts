/*
 * No production exports. Tests protect relational project-setting and sidebar projection, isolation, and writes. Keywords: settings, sidebar, project, app state.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultProjectWorkbenchSettings,
  createDefaultWorkbenchProjectSidebarPreferences,
  readProjectWorkbenchSettings,
  readWorkbenchProjectSidebarPreferences,
  setWorkbenchProjectSidebarFolderOpen,
  writeGlobalWorkbenchSetting,
  writeProjectWorkbenchSetting,
  writeWorkbenchProjectSidebarPreference,
} from "./workbench-settings";
import WorkbenchClientStateController from "./WorkbenchClientStateController";

test("each focused setting intent writes one app-state identity", async () => {
  const controller = new WorkbenchClientStateController({ mode: "memory" });
  await writeGlobalWorkbenchSetting(controller, "theme", "winter");
  assert.equal(controller.getSnapshot().records.length, 1);
  await writeProjectWorkbenchSetting(controller, "alpha", "theme", {
    enabled: true,
    value: "magical-girl",
  });
  assert.equal(controller.getSnapshot().records.length, 2);
  await writeWorkbenchProjectSidebarPreference(controller, "alpha", "threadsOpen", false);
  assert.equal(controller.getSnapshot().records.length, 3);
});

test("sidebar preferences project scalar and collection records without crossing projects", async () => {
  const controller = new WorkbenchClientStateController({ mode: "memory" });
  const alpha = {
    ...createDefaultWorkbenchProjectSidebarPreferences(),
    pinnedFolderIds: ["one", "two"],
    threadsOpen: false,
  };
  await writeWorkbenchProjectSidebarPreference(controller, "alpha", "threadsOpen", false);
  await setWorkbenchProjectSidebarFolderOpen(controller, "alpha", "pinned", "one", true);
  await setWorkbenchProjectSidebarFolderOpen(controller, "alpha", "pinned", "two", true);
  await writeWorkbenchProjectSidebarPreference(controller, "beta", "projectsOpen", true);

  assert.deepEqual(
    readWorkbenchProjectSidebarPreferences("memory", "alpha", controller.getSnapshot().records),
    alpha,
  );
  assert.deepEqual(readWorkbenchProjectSidebarPreferences(
    "memory",
    "beta",
    controller.getSnapshot().records,
  ), {
    ...createDefaultWorkbenchProjectSidebarPreferences(),
    projectsOpen: true,
  });
});

test("sidebar and ordinary project settings coexist as separate app-state records", async () => {
  const controller = new WorkbenchClientStateController({ mode: "memory" });
  const sidebar = {
    ...createDefaultWorkbenchProjectSidebarPreferences(),
    settledThreadItemLimit: 150,
  };
  const settings = createDefaultProjectWorkbenchSettings();
  settings.showUnopenableFiles = { enabled: true, value: true };
  settings.theme = { enabled: true, value: "magical-girl" };

  await writeWorkbenchProjectSidebarPreference(controller, "alpha", "settledThreadItemLimit", 150);
  await writeProjectWorkbenchSetting(controller, "alpha", "showUnopenableFiles", settings.showUnopenableFiles);
  await writeProjectWorkbenchSetting(controller, "alpha", "theme", settings.theme);

  assert.deepEqual(
    readWorkbenchProjectSidebarPreferences("memory", "alpha", controller.getSnapshot().records),
    sidebar,
  );
  assert.deepEqual(
    readProjectWorkbenchSettings("memory", "alpha", controller.getSnapshot().records),
    settings,
  );
});
