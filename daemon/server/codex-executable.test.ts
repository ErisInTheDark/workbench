/* Exports: none. Protect that Codex runs from a staged data-root copy that outlives checkout dependency changes. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import stageCodexRuntime from "./codex-executable";

const TRIPLE = "x86_64-unknown-linux-musl";

async function checkout(context: TestContext, version: string) {
  const temporary = await WorkbenchTemporaryDirectory.create("codex-runtime-");
  context.after(() => temporary.dispose());
  const modules = path.join(temporary.path, "checkout", "node_modules", "@openai");
  const manifest = path.join(modules, "codex", "package.json");
  const tree = path.join(modules, "codex-linux-x64", "vendor", TRIPLE);
  await mkdir(path.dirname(manifest), { recursive: true });
  await writeFile(manifest, JSON.stringify({ name: "@openai/codex", version }));
  await mkdir(path.join(tree, "bin"), { recursive: true });
  await mkdir(path.join(tree, "codex-path"), { recursive: true });
  await writeFile(path.join(modules, "codex-linux-x64", "package.json"), JSON.stringify({ name: "@openai/codex-linux-x64", version }));
  await writeFile(path.join(tree, "bin", "codex"), `codex ${version}`);
  await writeFile(path.join(tree, "codex-path", "rg"), "rg");
  const probes: string[] = [];
  const warnings: string[] = [];
  const stage = () => stageCodexRuntime({
    dataRoot: path.join(temporary.path, "data"),
    platform: "linux", arch: "x64",
    resolveManifest: () => {
      if (!existsSync(manifest)) throw Object.assign(new Error("missing"), { code: "MODULE_NOT_FOUND" });
      return manifest;
    },
    probe: async executable => { probes.push(executable); return `codex-cli ${version}`; },
    warn: message => { warnings.push(message); },
  });
  return { tree, modules, probes, warnings, stage };
}

test("staged Codex and its helpers keep resolving after the checkout package is removed", async context => {
  const { tree, modules, warnings, stage } = await checkout(context, "1.2.3");
  const resolve = await stage();
  const executable = resolve();
  assert.notEqual(path.dirname(path.dirname(executable)), tree);
  await rm(modules, { recursive: true, force: true });
  assert.equal(await readFile(resolve(), "utf8"), "codex 1.2.3");
  assert.equal(await readFile(path.join(path.dirname(path.dirname(executable)), "codex-path", "rg"), "utf8"), "rg");
  assert.deepEqual(warnings, []);
});

test("an already staged version is reused without copying or probing again", async context => {
  const { probes, stage } = await checkout(context, "1.2.3");
  const first = (await stage())();
  const second = (await stage())();
  assert.equal(second, first);
  assert.equal(probes.length, 1);
});

test("the staged Codex binary is the pinned dependency's version", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("codex-runtime-real-");
  context.after(() => temporary.dispose());
  const pinned = (require("../package.json") as { dependencies: Record<string, string> }).dependencies["@openai/codex"];
  const resolve = await stageCodexRuntime({ dataRoot: temporary.path, warn: assert.fail });
  const { stdout } = await promisify(execFile)(resolve(), ["--version"], { windowsHide: true });
  assert.equal(stdout.trim(), `codex-cli ${pinned}`);
});

test("a missing Codex package fails at spawn as a missing installation", async context => {
  const { modules, stage } = await checkout(context, "1.2.3");
  await rm(modules, { recursive: true, force: true });
  const resolve = await stage();
  assert.throws(resolve, (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});
