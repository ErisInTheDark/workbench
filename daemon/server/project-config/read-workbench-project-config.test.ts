/* No production exports. Protect that an invalid or unknown `.wb.json` entry is dropped and named without disabling the valid ones. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import { readWorkbenchProjectConfig } from "./read-workbench-project-config";

async function root(context: TestContext, contents?: string) {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-json-");
  context.after(() => temporary.dispose());
  if (contents !== undefined) await writeFile(path.join(temporary.path, ".wb.json"), contents);
  return temporary.path;
}

test("valid entries survive beside invalid and unknown ones, which are named", async context => {
  const { config, ignored } = await readWorkbenchProjectConfig(await root(context, JSON.stringify({
    future: { anything: true },
    vis: { css: { command: [] }, build: { command: ["node", "build.mjs", "{file}"] } },
  })));
  assert.deepEqual(config.vis?.build?.command, ["node", "build.mjs", "{file}"]);
  assert.equal(config.vis?.css, undefined);
  assert.ok(ignored.some((entry) => entry.startsWith("vis.css")));
  assert.ok(ignored.includes("future"));
});

test("a missing file is empty and unreadable JSON is reported, not thrown", async context => {
  assert.deepEqual(await readWorkbenchProjectConfig(await root(context)), { config: {}, ignored: [] });
  assert.deepEqual((await readWorkbenchProjectConfig(await root(context, "{ nope"))).config, {});
});
