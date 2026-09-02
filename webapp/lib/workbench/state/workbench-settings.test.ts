/*
 * No production exports. Tests protect global shell and project-local sidebar projection, isolation, and writes. Keywords: settings, sidebar, global, project, home, app state.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultProjectWorkbenchSettings,
  createDefaultWorkbenchGlobalSidebarPreferences,
  createDefaultWorkbenchProjectSidebarPreferences,
  readGlobalWorkbenchSettings,
  readProjectWorkbenchSettings,
  readWorkbenchGlobalSidebarPreferences,
  readWorkbenchProjectSidebarPreferences,
  resolveWorkbenchSettings,
  setWorkbenchProjectSidebarFolderOpen,
  writeGlobalWorkbenchSetting,
  writeProjectWorkbenchSetting,
  writeWorkbenchGlobalSidebarPreference,
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
  await writeWorkbenchGlobalSidebarPreference(controller, 4, "projectsOpen", true);
  assert.equal(controller.getSnapshot().records.length, 4);
});

test("selected-project pin placement defaults safely and resolves project overrides", async () => {
  const controller = new WorkbenchClientStateController({ mode: "memory" });
  assert.equal(readGlobalWorkbenchSettings().selectedProjectPinPlacement, "pinned-section");
  assert.equal(readGlobalWorkbenchSettings([{
    kind: "globalPreference",
    preference: { key: "selectedProjectPinPlacement", value: "haunted" },
  } as never]).selectedProjectPinPlacement, "pinned-section");

  await writeGlobalWorkbenchSetting(controller, "selectedProjectPinPlacement", "threads-section");
  const globalSettings = readGlobalWorkbenchSettings(controller.getSnapshot().records);
  let projectSettings = readProjectWorkbenchSettings("memory", "alpha", controller.getSnapshot().records);
  assert.equal(resolveWorkbenchSettings(globalSettings, projectSettings).selectedProjectPinPlacement, "threads-section");

  await writeProjectWorkbenchSetting(controller, "alpha", "selectedProjectPinPlacement", {
    enabled: true,
    value: "pinned-section",
  });
  projectSettings = readProjectWorkbenchSettings("memory", "alpha", controller.getSnapshot().records);
  assert.equal(resolveWorkbenchSettings(globalSettings, projectSettings).selectedProjectPinPlacement, "pinned-section");
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
  await writeWorkbenchProjectSidebarPreference(controller, "beta", "threadsOpen", false);

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
    threadsOpen: false,
  });
});

test("global sidebar preferences prefer canonical rows and ignore project copies", async () => {
  const controller = new WorkbenchClientStateController({ mode: "memory" });
  await controller.put({
    daemonRegistrationId: controller.daemonRegistrationId,
    kind: "sidebarPreference",
    preference: { key: "projectsOpen", value: false },
    projectId: "alpha",
  });
  await controller.put({
    daemonRegistrationId: controller.daemonRegistrationId,
    kind: "sidebarPreference",
    preference: { key: "projectsOpen", value: false },
    projectId: "",
  });
  await writeWorkbenchGlobalSidebarPreference(controller, 4, "projectsOpen", true);
  await writeWorkbenchGlobalSidebarPreference(controller, 4, "reloadNecessaryOpen", false);
  await writeWorkbenchGlobalSidebarPreference(controller, 4, "projectTimeGroupCount", 999);

  assert.deepEqual(readWorkbenchGlobalSidebarPreferences(
    controller.daemonRegistrationId,
    controller.getSnapshot().records,
  ), {
    ...createDefaultWorkbenchGlobalSidebarPreferences(),
    projectTimeGroupCount: 100,
    projectsOpen: true,
    reloadNecessaryOpen: false,
  });
  assert.deepEqual(
    readWorkbenchProjectSidebarPreferences("memory", "alpha", controller.getSnapshot().records),
    createDefaultWorkbenchProjectSidebarPreferences(),
  );
});

test("global sidebar preferences use compatible fallback rows for old app-state schemas", async () => {
  const controller = new WorkbenchClientStateController({ mode: "memory" });
  await writeWorkbenchGlobalSidebarPreference(controller, 0, "projectsOpen", true);

  assert.deepEqual(controller.getSnapshot().records, [{
    daemonRegistrationId: "memory",
    kind: "sidebarPreference",
    preference: { key: "projectsOpen", value: true },
    projectId: "",
  }]);
  assert.equal(
    readWorkbenchGlobalSidebarPreferences("memory", controller.getSnapshot().records).projectsOpen,
    true,
  );
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
