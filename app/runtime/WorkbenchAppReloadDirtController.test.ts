/*
 * No production exports. Tests protect ignored runtime churn, missing watcher filenames, scoped app/shared/static/tray dirt, partial advancement, and watcher disposal.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs, { type FSWatcher } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import WorkbenchAppReloadDirtController from "./WorkbenchAppReloadDirtController.ts";

const run = promisify(execFile);

async function fixture(context: test.TestContext) {
  const repositoryRootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "workbench-app-reload-dirt-"));
  const git = async (...args: string[]) => await run("git", args, { cwd: repositoryRootPath });
  await git("init");
  await git("config", "user.email", "workbench@example.invalid");
  await git("config", "user.name", "Workbench test");
  await fsp.mkdir(path.join(repositoryRootPath, "app", "runtime"), { recursive: true });
  await fsp.mkdir(path.join(repositoryRootPath, "shared"), { recursive: true });
  await fsp.mkdir(path.join(repositoryRootPath, "static"), { recursive: true });
  await fsp.mkdir(path.join(repositoryRootPath, "tray", "src"), { recursive: true });
  await fsp.mkdir(path.join(repositoryRootPath, "tray", "target"), { recursive: true });
  await fsp.writeFile(path.join(repositoryRootPath, ".gitignore"), ".workbench/\n", "utf8");
  await fsp.writeFile(path.join(repositoryRootPath, "app", "runtime", "http.ts"), "export const http = 1;\n", "utf8");
  await fsp.writeFile(path.join(repositoryRootPath, "shared", "owner.ts"), "export const shared = 1;\n", "utf8");
  await fsp.writeFile(path.join(repositoryRootPath, "static", "index.html"), "<main>app</main>\n", "utf8");
  await fsp.writeFile(path.join(repositoryRootPath, "tray", "src", "main.rs"), "fn main() {}\n", "utf8");
  await fsp.writeFile(path.join(repositoryRootPath, "tray", "target", "ignored.exe"), "ignored\n", "utf8");
  await git("add", ".");
  await git("commit", "-m", "initial");

  let closed = 0;
  let observe: ((event: string, filename: string | Buffer | null) => void) | null = null;
  const watcher = {
    close: () => { closed += 1; },
    on: () => watcher,
  } as unknown as FSWatcher;
  const controller = new WorkbenchAppReloadDirtController({
    getCatalog: () => [
      { access: "operator", description: "HTTP", safeAll: false, scope: "client:http" },
      { access: "operator", description: "Compiler", safeAll: false, scope: "client:compiler" },
      { access: "operator", description: "Process", destructive: true, safeAll: false, scope: "client:process" },
    ],
    getScopesForPaths: (paths) => {
      const scopes = new Set<string>();
      for (const sourcePath of paths) {
        if (sourcePath.startsWith("app/runtime/") && sourcePath.endsWith(".ts")) scopes.add("client:http");
        if (sourcePath.startsWith("static/")) scopes.add("client:compiler");
        if (sourcePath.startsWith("tray/") && !sourcePath.startsWith("tray/target/")) scopes.add("client:process");
        if (sourcePath === "shared/owner.ts") {
          scopes.add("client:http");
        }
      }
      return [...scopes];
    },
    repositoryRootPath,
    watchSource: ((_root, _options, listener) => {
      observe = listener as typeof observe;
      return watcher;
    }) as typeof fs.watch,
  });
  context.after(async () => {
    await controller.dispose();
    await fsp.rm(repositoryRootPath, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 });
  });
  await controller.start();
  return {
    controller,
    get closed() { return closed; },
    observe: (filename: string | null) => observe?.("change", filename),
    repositoryRootPath,
  };
}

test("ignored runtime writes and missing filenames reconcile clean instead of dirtying every scope", async (context) => {
  const target = await fixture(context);
  await fsp.mkdir(path.join(target.repositoryRootPath, ".workbench"), { recursive: true });
  await fsp.writeFile(path.join(target.repositoryRootPath, ".workbench", "runtime.json"), "{}\n", "utf8");
  target.observe(".workbench/runtime.json");
  target.observe(null);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual((await target.controller.refresh()).dirtyScopes, []);
});

test("real app, shared, static, and tray edits dirty only actual owners and advance independently", async (context) => {
  const target = await fixture(context);
  const httpPath = path.join(target.repositoryRootPath, "app", "runtime", "http.ts");
  await fsp.writeFile(httpPath, "export const http = 2;\n", "utf8");
  target.observe("app/runtime/http.ts");
  assert.deepEqual((await target.controller.refresh()).dirtyScopes.map(({ scope }) => scope), ["client:http"]);
  await target.controller.completeReload(["client:http"]);
  assert.deepEqual(target.controller.getSnapshot().dirtyScopes, []);

  const sharedPath = path.join(target.repositoryRootPath, "shared", "owner.ts");
  const staticPath = path.join(target.repositoryRootPath, "static", "index.html");
  const trayPath = path.join(target.repositoryRootPath, "tray", "src", "main.rs");
  await fsp.writeFile(sharedPath, "export const shared = 2;\n", "utf8");
  await fsp.writeFile(staticPath, "<main>changed</main>\n", "utf8");
  await fsp.writeFile(trayPath, "fn main() { println!(\"changed\"); }\n", "utf8");
  target.observe("shared/owner.ts");
  target.observe("static/index.html");
  target.observe("tray/src/main.rs");
  assert.deepEqual(
    (await target.controller.refresh()).dirtyScopes.map(({ scope }) => scope),
    ["client:http", "client:compiler", "client:process"],
  );
  await target.controller.completeReload(["client:http"]);
  assert.deepEqual(target.controller.getSnapshot().dirtyScopes.map(({ scope }) => scope), ["client:compiler", "client:process"]);
  await target.controller.completeReload(["client:compiler", "client:process"]);
  assert.deepEqual(target.controller.getSnapshot().dirtyScopes, []);

  await fsp.writeFile(path.join(target.repositoryRootPath, "tray", "target", "ignored.exe"), "changed\n", "utf8");
  target.observe("tray/target/ignored.exe");
  assert.deepEqual((await target.controller.refresh()).dirtyScopes, []);

  await fsp.writeFile(path.join(target.repositoryRootPath, "app", "runtime", "ignored.test.ts"), "export {};\n", "utf8");
  target.observe("app/runtime/ignored.test.ts");
  assert.deepEqual((await target.controller.refresh()).dirtyScopes, []);
  await target.controller.dispose();
  assert.equal(target.closed, 1);
});
