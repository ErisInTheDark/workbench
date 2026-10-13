/*
 * No production exports. Protect official-installer failure and child-environment isolation.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import WorkbenchTemporaryDirectory from "../shared/WorkbenchTemporaryDirectory";
import WorkbenchBootstrapCommand from "./WorkbenchBootstrapCommand.mjs";
import installVitePlus from "./vite-plus-installer.mjs";

test("installer choices stay in its child and inherited preview configuration cannot redirect setup", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-vp-installer-");
  context.after(() => temporary.dispose());
  const environment = { VP_HOME: "/user-owned", VP_PR_VERSION: "unexpected-preview", CI: "false" };
  const commands = new WorkbenchBootstrapCommand({ environment });
  let calls = 0;
  commands.run = async (_command, args, options) => {
    calls++;
    const child = commands.environmentFor(options.environment);
    assert.equal(child.VP_HOME, path.join(temporary.path, "toolchain"));
    assert.equal(child.VP_PR_VERSION, undefined);
    assert.equal(child.VP_SELF_SETUP_NO_MODIFY_PATH, "1");
    assert.equal(child.CI, "true");
    assert.equal(await fs.readFile(args.at(-1), "utf8"), "official script fixture");
  };
  await installVitePlus({
    home: path.join(temporary.path, "toolchain"), directory: temporary.path, commands,
    fetchInstaller: async () => new Response("official script fixture"),
  });
  assert.equal(calls, 1);
  assert.equal(environment.VP_HOME, "/user-owned");
  assert.equal(environment.CI, "false");
  assert.deepEqual(await fs.readdir(temporary.path), []);
});

test("failed downloads never execute, and command failures retain their cause and remove only the fetched script", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-vp-failure-");
  context.after(() => temporary.dispose());
  const commands = new WorkbenchBootstrapCommand({ environment: {} });
  commands.run = async () => { assert.fail("failed download cannot execute"); };
  const options = { home: path.join(temporary.path, "toolchain"), directory: temporary.path, commands };
  await assert.rejects(installVitePlus({ ...options, fetchInstaller: async () => new Response("unavailable", { status: 503 }) }), /503/u);
  const failure = new Error("installer failed");
  commands.run = async () => { throw failure; };
  await fs.writeFile(path.join(temporary.path, "keep"), "user data");
  await assert.rejects(installVitePlus({ ...options, fetchInstaller: async () => new Response("script") }), error => error === failure);
  assert.deepEqual(await fs.readdir(temporary.path), ["keep"]);
  const cleanupFailure = new Error("script cleanup failed");
  await assert.rejects(installVitePlus({
    ...options, fetchInstaller: async () => new Response("script"),
    files: { ...fs, unlink: async () => { throw cleanupFailure; } },
  }), error => error instanceof AggregateError && error.errors.includes(failure) && error.errors.includes(cleanupFailure));
});
