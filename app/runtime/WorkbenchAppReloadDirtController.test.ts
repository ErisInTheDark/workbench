/*
 * No production exports. Tests protect path ownership and source changes that race a reload.
 */
import assert from "node:assert/strict";
import type { FSWatcher } from "node:fs";
import test from "node:test";

import WorkbenchAppReloadDirtController from "./WorkbenchAppReloadDirtController.ts";

test("keeps a scope dirty when its source changes during replacement", () => {
  let observe: ((event: string, filename: string | Buffer | null) => void) | null = null;
  const watcher = { close: () => {}, on: () => watcher } as unknown as FSWatcher;
  const controller = new WorkbenchAppReloadDirtController({
    getCatalog: () => [{ access: "operator", description: "HTTP", safeAll: true, scope: "client:http" }],
    getScopesForPaths: (paths) => paths.some((path) => path === "app/runtime/WorkbenchAppHttpRouter.ts") ? ["client:http"] : [],
    repositoryRootPath: "C:/repo",
    watchSource: ((_path, _options, listener) => {
      observe = listener as typeof observe;
      return watcher;
    }) as typeof import("node:fs").watch,
  });
  controller.start();
  observe?.("change", "app/runtime/WorkbenchAppHttpRouter.ts");
  assert.deepEqual(controller.getSnapshot().dirtyScopes.map(({ scope }) => scope), ["client:http"]);
  controller.beginReload(["client:http"]);
  observe?.("change", "app/runtime/WorkbenchAppHttpRouter.ts");
  controller.completeReload(["client:http"]);
  assert.deepEqual(controller.getSnapshot().dirtyScopes.map(({ scope }) => scope), ["client:http"]);
  controller.dispose();
});
