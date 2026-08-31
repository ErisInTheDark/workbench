/*
 * No production exports. Tests protect the thin process boundary and app source ownership.
 */
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import WorkbenchAppLogger from "../WorkbenchAppLogger.ts";
import type WorkbenchFrontendCompiler from "../WorkbenchFrontendCompiler.ts";
import type WorkbenchAppStateRepository from "../state/WorkbenchAppStateRepository.ts";
import WorkbenchAppRuntime from "./WorkbenchAppRuntime.ts";

const appDirectoryPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nonServerSourcePaths = new Set([
  "app/browser-entry.tsx",
  "app/browser-navigation.ts",
  "app/desktop.ts",
  "app/WorkbenchBrowserApp.tsx",
  "app/WorkbenchBrowserLogForwarder.ts",
  "app/WorkbenchDesktopLauncher.ts",
]);

function runtime() {
  const compiler = {
    close: async () => {},
    outputDirectoryPath: "C:/workbench-output",
    startWatching: async () => "C:/workbench-output",
  } as WorkbenchFrontendCompiler;
  const database = {
    close: () => {},
    start: () => "registration",
  } as WorkbenchAppStateRepository;
  return new WorkbenchAppRuntime({
    appPort: {
      read: () => ({
        appOrigin: "http://127.0.0.1:43210",
        currentPort: 43_210,
        editable: true,
        source: "random",
      }),
      update: async () => ({
        appOrigin: "http://127.0.0.1:43210",
        currentPort: 43_210,
        editable: true,
        source: "setting",
      }),
    },
    createCompiler: () => compiler,
    createDatabase: () => database,
    legacyOrigin: "http://127.0.0.1:3002",
    logger: new WorkbenchAppLogger({ color: false, writeError: () => {}, writeOutput: () => {} }),
    outputDirectoryPath: "C:/workbench-output",
    repositoryRootPath: "C:/repo",
  });
}

async function appProductionSourcePaths() {
  const sourcePaths: string[] = [];
  const visit = async (directoryPath: string, relativeDirectoryPath = ""): Promise<void> => {
    for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const relativePath = path.posix.join(relativeDirectoryPath, entry.name);
      if (entry.isDirectory()) {
        await visit(path.join(directoryPath, entry.name), relativePath);
      } else if (/\.(?:ts|tsx)$/u.test(entry.name) && !entry.name.includes(".test.")) {
        sourcePaths.push(`app/${relativePath}`);
      }
    }
  };
  await visit(appDirectoryPath);
  return sourcePaths.sort();
}

test("assigns every app server source to a reloadable node or the explicit process shell", async () => {
  const target = runtime();
  const owners = (path: string) => target.getReloadScopesForPaths([path]).sort();
  const sourcePaths = await appProductionSourcePaths();
  const unownedServerSources = sourcePaths
    .filter((sourcePath) => !nonServerSourcePaths.has(sourcePath))
    .filter((sourcePath) => owners(sourcePath).length === 0);
  assert.deepEqual(unownedServerSources, []);
  assert.deepEqual(
    sourcePaths.filter((sourcePath) => nonServerSourcePaths.has(sourcePath) && owners(sourcePath).length > 0),
    [],
  );

  assert.deepEqual(owners("app/state/WorkbenchAppStateRepository.ts"), ["client:database"]);
  assert.deepEqual(owners("app/state/WorkbenchAppStateController.ts"), ["client:state"]);
  assert.deepEqual(owners("app/runtime/WorkbenchAppHttpRouter.ts"), ["client:http"]);
  assert.deepEqual(owners("app/WorkbenchFrontendCompiler.ts"), ["client:compiler"]);
  assert.deepEqual(owners("app/runtime/AppHttpNode.ts"), ["client:http", "client:topology"]);
  assert.deepEqual(owners("app/index.ts"), ["client:process"]);
  assert.deepEqual(owners("app/package.json"), ["client:process"]);
  assert.deepEqual(owners("app/tsconfig.json"), ["client:process"]);
  assert.deepEqual(owners("shared/http/StaticHttpRequestController.ts"), ["client:http"]);
  assert.deepEqual(owners("shared/http/workbench-app-port.ts"), ["client:http"]);
  assert.deepEqual(owners("shared/http/HttpServer.ts"), ["client:process"]);
  assert.deepEqual(owners("shared/package.json"), ["client:process"]);
});
