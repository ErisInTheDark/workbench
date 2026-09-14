/*
 * No production exports. Tests protect ignored runtime churn, missing watcher filenames, scoped app/shared/static/tray dirt, partial advancement, and watcher disposal.
 */
import assert from "node:assert/strict";
import fs, { type FSWatcher } from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import WorkbenchAppReloadDirtController from "./WorkbenchAppReloadDirtController.ts";
import { APP_RELOAD_DIRT_FIXTURE } from "./AppReloadDirt.test.fixtures.ts";

const { default: GitTestFixtureCache } = createRequire(import.meta.url)(
  "../../../daemon/server/lib/workbench/git/GitTestFixtureCache.ts",
) as typeof import("../../../daemon/server/lib/workbench/git/GitTestFixtureCache");

async function fixture(context: test.TestContext) {
  const { root: repositoryRootPath, dispose } = await new GitTestFixtureCache().copy(APP_RELOAD_DIRT_FIXTURE);

  let closed = 0;
  let observe: ((event: string, filename: string | Buffer | null) => void) | null = null;
  const watcher = {
    close: () => { closed += 1; },
    on: () => watcher,
  } as unknown as FSWatcher;
  const controller = new WorkbenchAppReloadDirtController({
    getSourceState: () => ({
      descriptors: [
        { access: "operator", description: "HTTP", safeAll: false, scope: "client:http", paths: ["shared/owner.ts"], boundaryPatterns: ["app/server/runtime/*.ts", "!**/*.test.*"] },
        { access: "operator", description: "Compiler", safeAll: false, scope: "client:compiler", paths: [], boundaryPatterns: ["app/client/static/**"] },
        { access: "operator", description: "Process", destructive: true, safeAll: false, scope: "client:process", paths: [], boundaryPatterns: ["app/tray/**", "!app/tray/target/**"] },
      ],
      dependantClosure: (scopes) => scopes.includes("client:process")
      ? ["client:http", "client:compiler", "client:process"]
      : scopes.includes("client:http")
        ? ["client:http", "client:compiler"]
        : [...scopes],
    }),
    repositoryRootPath,
    watchSource: ((_root, _options, listener) => {
      observe = listener as typeof observe;
      return watcher;
    }) as typeof fs.watch,
  });
  context.after(async () => {
    await controller.dispose();
    await dispose();
  });
  await controller.start();
  return {
    controller,
    get closed() { return closed; },
    observe: (filename: string | null) => observe?.("change", filename),
    observeRefresh: async (...filenames: Array<string | null>) => {
      const completed = Promise.withResolvers<Awaited<ReturnType<typeof controller.refresh>>>();
      const originalRefresh = controller.refresh.bind(controller);
      const refresh = context.mock.method(controller, "refresh", async (signal?: AbortSignal) => {
        try {
          const snapshot = await originalRefresh(signal);
          completed.resolve(snapshot);
          return snapshot;
        } catch (error) {
          completed.reject(error);
          throw error;
        }
      }, { times: 1 });
      try {
        for (const filename of filenames) observe?.("change", filename);
        return await completed.promise;
      } finally {
        refresh.mock.restore();
      }
    },
    repositoryRootPath,
  };
}

async function checkIgnoredRuntime(target: Awaited<ReturnType<typeof fixture>>) {
  await fsp.mkdir(path.join(target.repositoryRootPath, ".workbench"), { recursive: true });
  await fsp.writeFile(path.join(target.repositoryRootPath, ".workbench", "runtime.json"), "{}\n", "utf8");
  assert.deepEqual((await target.observeRefresh(".workbench/runtime.json", null)).dirtyScopes, []);
}

async function checkSourceOwners(target: Awaited<ReturnType<typeof fixture>>) {
  const httpPath = path.join(target.repositoryRootPath, "app", "server", "runtime", "http.ts");
  await fsp.writeFile(httpPath, "export const http = 2;\n", "utf8");
  assert.deepEqual((await target.observeRefresh("app/server/runtime/http.ts")).dirtyScopes.map(({ scope }) => scope), ["client:http"]);
  assert.deepEqual(target.controller.getSnapshot().dirtyScopes[0]?.dependantScopes, ["client:compiler"]);
  await target.controller.completeReload(["client:http"]);
  assert.deepEqual(target.controller.getSnapshot().dirtyScopes, []);

  const sharedPath = path.join(target.repositoryRootPath, "shared", "owner.ts");
  const staticPath = path.join(target.repositoryRootPath, "app", "client", "static", "index.html");
  const trayPath = path.join(target.repositoryRootPath, "app", "tray", "src", "main.rs");
  await fsp.writeFile(sharedPath, "export const shared = 2;\n", "utf8");
  await fsp.writeFile(staticPath, "<main>changed</main>\n", "utf8");
  await fsp.writeFile(trayPath, "fn main() { println!(\"changed\"); }\n", "utf8");
  assert.deepEqual(
    (await target.observeRefresh("shared/owner.ts", "app/client/static/index.html", "app/tray/src/main.rs")).dirtyScopes.map(({ scope }) => scope),
    ["client:http", "client:compiler", "client:process"],
  );
  assert.deepEqual(
    target.controller.getSnapshot().dirtyScopes.find(({ scope }) => scope === "client:process")?.dependantScopes,
    ["client:http", "client:compiler"],
  );
  await target.controller.completeReload(["client:http"]);
  assert.deepEqual(target.controller.getSnapshot().dirtyScopes.map(({ scope }) => scope), ["client:process"]);
  await target.controller.completeReload(["client:process"]);
  assert.deepEqual(target.controller.getSnapshot().dirtyScopes, []);

  await fsp.writeFile(path.join(target.repositoryRootPath, "app", "tray", "target", "ignored.exe"), "changed\n", "utf8");
  target.observe("app/tray/target/ignored.exe");
  assert.deepEqual((await target.controller.refresh()).dirtyScopes, []);

  await fsp.writeFile(path.join(target.repositoryRootPath, "app", "server", "runtime", "ignored.test.ts"), "export {};\n", "utf8");
  target.observe("app/server/runtime/ignored.test.ts");
  assert.deepEqual((await target.controller.refresh()).dirtyScopes, []);
  await target.controller.dispose();
  assert.equal(target.closed, 1);
}

test("app reload dirt shares one source and baseline history", async (context) => {
  const target = await fixture(context);
  await context.test("ignored runtime writes and missing filenames reconcile clean", () => checkIgnoredRuntime(target));
  await context.test("real source edits preserve owner boundaries, partial advancement and disposal", () => checkSourceOwners(target));
});
