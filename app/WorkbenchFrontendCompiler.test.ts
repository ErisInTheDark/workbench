/*
 * No production exports. Node tests protect real Workbench browser-graph compilation without Next runtime or browser refresh machinery.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type * as esbuild from "esbuild";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import WorkbenchProcessLogger from "workbench-shared/process/WorkbenchProcessLogger";
import WorkbenchFrontendCompiler from "./WorkbenchFrontendCompiler.ts";

async function assertFile(filePath: string) {
  assert.equal((await stat(filePath)).isFile(), true, `${filePath} should be a file`);
}

function quietLogger() {
  return new WorkbenchProcessLogger({
    color: false,
    writeError: () => undefined,
    writeOutput: () => undefined,
  });
}

function compilerTools() {
  let onStart: () => void | Promise<void> = () => {};
  let onEnd: (result: esbuild.BuildResult) => void | Promise<void> = () => {};
  let outputPath = "";
  let watches = 0;
  let disposals = 0;
  const context = {
    async rebuild() {
      await onStart();
      const result = { errors: [], warnings: [], metafile: undefined, mangleCache: undefined, outputFiles: [{
        path: outputPath, contents: Buffer.from("fresh javascript"), hash: "", text: "fresh javascript",
      }] };
      await onEnd(result);
      return result;
    },
    async watch() { watches++; },
    async dispose() { disposals++; },
    async cancel() {},
    async serve() { throw new Error("HTTP serving is not owned by the compiler."); },
  } as esbuild.BuildContext;
  return {
    context,
    get watches() { return watches; },
    get disposals() { return disposals; },
    async createContext(options: esbuild.BuildOptions) {
      outputPath = options.outfile!;
      const build: Pick<esbuild.PluginBuild, "onStart" | "onEnd" | "onResolve" | "onLoad"> = {
        onStart(callback) { onStart = callback as typeof onStart; },
        onEnd(callback) { onEnd = callback as typeof onEnd; },
        onResolve() {}, onLoad() {},
      };
      for (const plugin of options.plugins ?? []) await plugin.setup(build as esbuild.PluginBuild);
      return context;
    },
    spawnTailwind(args: readonly string[]) {
      const child = Object.assign(new EventEmitter(), {
        exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, killed: false,
        kill() {
          this.killed = true;
          this.signalCode = "SIGTERM";
          child.emit("exit", null, "SIGTERM");
          return true;
        },
      });
      if (!args.includes("--watch=always")) {
        void Promise.all([
          writeFile(args[args.indexOf("--output") + 1]!, "body { color: red; }"),
          writeFile(args[args.indexOf("--map") + 1]!, "{}"),
        ]).then(() => { child.exitCode = 0; child.emit("exit", 0, null); }, error => child.emit("error", error));
      }
      return child as unknown as ChildProcess;
    },
  };
}

test("terminal compiler shutdown completes even when stopping the service leaves disposal unanswered", async t => {
  const outputDirectoryPath = await mkdtemp(path.join(os.tmpdir(), "workbench-compiler-shutdown-"));
  const tools = compilerTools();
  let release!: () => void;
  let stopped = false;
  const pending = new Promise<void>(resolve => { release = resolve; });
  t.signal.addEventListener("abort", release, { once: true });
  tools.context.dispose = () => pending;
  const compiler = new WorkbenchFrontendCompiler({
    logger: quietLogger(), outputDirectoryPath, createContext: tools.createContext,
    spawnTailwind: tools.spawnTailwind,
    stopService: () => { stopped = true; },
  });
  await compiler.startWatching();
  try {
    await compiler.shutdown();
    assert.equal(stopped, true);
  } finally {
    t.signal.removeEventListener("abort", release);
    release();
    await compiler.close();
  }
});

test("suspended compiler output stays private until its owner resumes publication", async context => {
  const outputDirectoryPath = await mkdtemp(path.join(os.tmpdir(), "workbench-compiler-publication-"));
  await mkdir(path.join(outputDirectoryPath, "assets"));
  const javascriptPath = path.join(outputDirectoryPath, "assets", "app.js");
  await writeFile(javascriptPath, "last successful javascript");
  const tools = compilerTools();
  const compiler = new WorkbenchFrontendCompiler({
    logger: quietLogger(), outputDirectoryPath, createContext: tools.createContext, spawnTailwind: tools.spawnTailwind,
  });
  context.after(async () => await compiler.close());
  await compiler.suspend();
  await compiler.startWatching();
  assert.equal(await readFile(javascriptPath, "utf8"), "last successful javascript");
  await compiler.resumeAfterFailedReload();
  assert.equal(await readFile(javascriptPath, "utf8"), "fresh javascript");
});

test("retirement fences context creation that completes after the compiler was replaced", async context => {
  const outputDirectoryPath = await mkdtemp(path.join(os.tmpdir(), "workbench-compiler-late-context-"));
  const tools = compilerTools();
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const compiler = new WorkbenchFrontendCompiler({
    logger: quietLogger(), outputDirectoryPath, spawnTailwind: tools.spawnTailwind,
    createContext: async options => { const created = await tools.createContext(options); enter(); await gate; return created; },
  });
  context.after(async () => { release(); await compiler.close(); });
  await compiler.suspend();
  const starting = compiler.startWatching();
  const rejected = assert.rejects(starting, /retired/);
  await entered;
  compiler.retire();
  release();
  await rejected;
  assert.equal(tools.watches, 0);
  assert.equal(tools.disposals, 1);
});

test("installation roots isolate generated output from shared library configuration", () => {
  const repositoryRootPath = path.join(os.tmpdir(), "workbench-source-root");
  const workbenchLibraryRoot = path.join(os.tmpdir(), "workbench-library-root");
  const compiler = new WorkbenchFrontendCompiler({
    environment: { WORKBENCH_LIBRARY_ROOT: workbenchLibraryRoot },
    logger: quietLogger(),
    repositoryRootPath,
  });

  const other = new WorkbenchFrontendCompiler({
    environment: { WORKBENCH_LIBRARY_ROOT: workbenchLibraryRoot },
    logger: quietLogger(),
    repositoryRootPath: `${repositoryRootPath}-other`,
  });
  assert.notEqual(compiler.outputDirectoryPath, other.outputDirectoryPath);
  const relative = path.relative(repositoryRootPath, compiler.outputDirectoryPath);
  assert.equal(relative.startsWith("..") || path.isAbsolute(relative), false);
  const explicit = new WorkbenchFrontendCompiler({
    logger: quietLogger(), repositoryRootPath, outputDirectoryPath: workbenchLibraryRoot,
  });
  assert.equal(explicit.outputDirectoryPath, workbenchLibraryRoot);
});

test("watches the real browser app into static output without Next runtime imports", async (context) => {
  const outputDirectoryPath = await mkdtemp(path.join(os.tmpdir(), "workbench-app-build-"));
  const diagnostics: string[] = [];
  const compiler = new WorkbenchFrontendCompiler({
    logger: quietLogger(),
    onDiagnostic: (message) => diagnostics.push(message),
    outputDirectoryPath,
  });
  context.after(async () => await compiler.shutdown());

  assert.equal(await compiler.startWatching(), outputDirectoryPath);

  await Promise.all([
    assertFile(path.join(outputDirectoryPath, "index.html")),
    assertFile(path.join(outputDirectoryPath, "manifest.webmanifest")),
    assertFile(path.join(outputDirectoryPath, "assets", "app.js")),
    assertFile(path.join(outputDirectoryPath, "assets", "app.js.map")),
    assertFile(path.join(outputDirectoryPath, "assets", "app.css")),
    assertFile(path.join(outputDirectoryPath, "assets", "app.css.map")),
    assertFile(path.join(outputDirectoryPath, "tab-icons", "active.png")),
    assertFile(path.join(outputDirectoryPath, "tab-icons", "default.png")),
    assertFile(path.join(outputDirectoryPath, "tab-icons", "default-256.png")),
    assertFile(path.join(outputDirectoryPath, "tab-icons", "questionnaire.png")),
  ]);

  const html = await readFile(path.join(outputDirectoryPath, "index.html"), "utf8");
  const mobileWebAppCapabilities = Object.fromEntries(
    [...html.matchAll(/<meta content="([^"]+)" name="((?:apple-)?mobile-web-app-capable)">/gu)]
      .map(([, content, name]) => [name, content]),
  );
  assert.deepEqual(mobileWebAppCapabilities, {
    "apple-mobile-web-app-capable": "yes",
    "mobile-web-app-capable": "yes",
  });

  const javascript = await readFile(path.join(outputDirectoryPath, "assets", "app.js"), "utf8");
  const stylesheet = await readFile(path.join(outputDirectoryPath, "assets", "app.css"), "utf8");
  const frontendGeneration = compiler.getFrontendGeneration();
  assert.ok(frontendGeneration);
  assert.match(javascript, new RegExp(frontendGeneration.javascript, "u"));
  assert.match(
    stylesheet,
    new RegExp(`--workbench-frontend-stylesheet-generation:${frontendGeneration.stylesheet}`, "u"),
  );
  assert.doesNotMatch(javascript, /from\s+["']next\/navigation["']/u);
  assert.doesNotMatch(javascript, /webpack-hmr/u);
  const sourceMap = JSON.parse(
    await readFile(path.join(outputDirectoryPath, "assets", "app.js.map"), "utf8"),
  ) as { sources?: unknown };
  assert.ok(Array.isArray(sourceMap.sources));
  assert.equal(sourceMap.sources.some((source) => (
    typeof source === "string" && /react(?:-dom)?(?:-client)?\.development\.js$/u.test(source)
  )), false);
  assert.equal(sourceMap.sources.some((source) => (
    typeof source === "string" && /react-dom-client\.production\.js$/u.test(source)
  )), true);
  await compiler.close();
  assert.deepEqual(diagnostics, []);
});
