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
  writeProjectWorkbenchSettings,
  writeWorkbenchProjectSidebarPreferences,
} from "./workbench-settings";
import WorkbenchClientStateController from "./WorkbenchClientStateController";

test("sidebar preferences project scalar and collection records without crossing projects", async () => {
  const controller = new WorkbenchClientStateController({ mode: "memory" });
  const alpha = {
    ...createDefaultWorkbenchProjectSidebarPreferences(),
    pinnedFolderIds: ["one", "two"],
    threadsOpen: false,
  };
  await writeWorkbenchProjectSidebarPreferences(controller, "alpha", alpha);
  await writeWorkbenchProjectSidebarPreferences(controller, "beta", {
    ...createDefaultWorkbenchProjectSidebarPreferences(),
    projectsOpen: true,
  });

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

  await writeWorkbenchProjectSidebarPreferences(controller, "alpha", sidebar);
  await writeProjectWorkbenchSettings(controller, "alpha", settings);

  assert.deepEqual(
    readWorkbenchProjectSidebarPreferences("memory", "alpha", controller.getSnapshot().records),
    sidebar,
  );
  assert.deepEqual(
    readProjectWorkbenchSettings("memory", "alpha", controller.getSnapshot().records),
    settings,
  );
});
