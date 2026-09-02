/*
 * No production exports. Node tests protect real Workbench browser-graph compilation without Next runtime or browser refresh machinery.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import WorkbenchAppLogger from "./WorkbenchAppLogger.ts";
import WorkbenchFrontendCompiler from "./WorkbenchFrontendCompiler.ts";

async function assertFile(filePath: string) {
  assert.equal((await stat(filePath)).isFile(), true, `${filePath} should be a file`);
}

function quietLogger() {
  return new WorkbenchAppLogger({
    color: false,
    writeError: () => undefined,
    writeOutput: () => undefined,
  });
}

test("keeps generated output outside the repository source watch root", () => {
  const repositoryRootPath = path.join(os.tmpdir(), "workbench-source-root");
  const workbenchLibraryRoot = path.join(os.tmpdir(), "workbench-library-root");
  const compiler = new WorkbenchFrontendCompiler({
    environment: { WORKBENCH_LIBRARY_ROOT: workbenchLibraryRoot },
    logger: quietLogger(),
    repositoryRootPath,
  });

  assert.equal(
    compiler.outputDirectoryPath,
    path.join(workbenchLibraryRoot, "runtime", "app"),
  );
  assert.equal(path.relative(repositoryRootPath, compiler.outputDirectoryPath).startsWith(".."), true);
});

test("watches the real browser app into static output without Next runtime imports", async (context) => {
  const outputDirectoryPath = await mkdtemp(path.join(os.tmpdir(), "workbench-app-build-"));
  const diagnostics: string[] = [];
  const compiler = new WorkbenchFrontendCompiler({
    logger: quietLogger(),
    onDiagnostic: (message) => diagnostics.push(message),
    outputDirectoryPath,
  });
  context.after(async () => await compiler.close());

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
