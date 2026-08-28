/*
 * No production exports. Node tests protect project-local sidebar preference repair, isolation, and coexistence with ordinary Workbench settings. Keywords: settings, sidebar, project, localStorage, conformance.
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

const PROJECT_SETTINGS_STORAGE_KEY = "workbench:settings:projects";

function withLocalStorage(run: (storage: Map<string, string>) => void) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
      },
    },
  });

  try {
    run(storage);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

test("sidebar preferences repair schema drift without losing valid values or project isolation", () => {
  withLocalStorage((storage) => {
    storage.set(PROJECT_SETTINGS_STORAGE_KEY, JSON.stringify({
      alpha: {
        sidebarPreferences: {
          explorerOpen: "old",
          pinnedFolderIds: ["one", 2, "two"],
          projectTimeGroupCount: 0,
          threadsOpen: false,
        },
      },
      beta: {
        sidebarPreferences: {
          projectsOpen: true,
        },
      },
    }));

    assert.deepEqual(readWorkbenchProjectSidebarPreferences("alpha"), {
      ...createDefaultWorkbenchProjectSidebarPreferences(),
      pinnedFolderIds: ["one", "two"],
      threadsOpen: false,
    });
    assert.deepEqual(readWorkbenchProjectSidebarPreferences("beta"), {
      ...createDefaultWorkbenchProjectSidebarPreferences(),
      projectsOpen: true,
    });
    assert.deepEqual(
      readWorkbenchProjectSidebarPreferences("missing"),
      createDefaultWorkbenchProjectSidebarPreferences(),
    );
  });
});

test("sidebar and ordinary project settings preserve each other in the shared project record", () => {
  withLocalStorage(() => {
    const alphaSidebarPreferences = {
      ...createDefaultWorkbenchProjectSidebarPreferences(),
      browseSessionsOpen: false,
      pinnedFolderIds: ["cross-project-folder"],
      settledThreadItemLimit: 150,
    };
    writeWorkbenchProjectSidebarPreferences("alpha", alphaSidebarPreferences);

    const alphaProjectSettings = createDefaultProjectWorkbenchSettings();
    alphaProjectSettings.showUnopenableFiles = { enabled: true, value: true };
    alphaProjectSettings.theme = { enabled: true, value: "magical-girl" };
    writeProjectWorkbenchSettings("alpha", alphaProjectSettings);

    assert.deepEqual(readWorkbenchProjectSidebarPreferences("alpha"), alphaSidebarPreferences);
    assert.deepEqual(readProjectWorkbenchSettings("alpha"), alphaProjectSettings);

    const updatedAlphaSidebarPreferences = {
      ...alphaSidebarPreferences,
      browseSessionsOpen: true,
      projectStatusCountsExpanded: false,
      threadFolderIds: ["ordinary-folder"],
    };
    writeWorkbenchProjectSidebarPreferences("alpha", updatedAlphaSidebarPreferences);
    writeWorkbenchProjectSidebarPreferences("beta", {
      ...createDefaultWorkbenchProjectSidebarPreferences(),
      explorerOpen: false,
    });

    assert.deepEqual(readProjectWorkbenchSettings("alpha"), alphaProjectSettings);
    assert.deepEqual(readWorkbenchProjectSidebarPreferences("alpha"), updatedAlphaSidebarPreferences);
    assert.deepEqual(readWorkbenchProjectSidebarPreferences("beta"), {
      ...createDefaultWorkbenchProjectSidebarPreferences(),
      explorerOpen: false,
    });
  });
});
