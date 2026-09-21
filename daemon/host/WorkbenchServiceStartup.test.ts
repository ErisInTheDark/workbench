/*
 * No production exports. Tests on-demand startup remains independent of boot enablement.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import WorkbenchServiceStartup from "./WorkbenchServiceStartup.ts";

async function fixture(context: TestContext) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "wb-startup-"));
  context.after(() => fs.rm(home, { recursive: true, force: true }));
  const state = { enabled: false, running: false, linger: false, registrationFails: false };
  const run = async (command: string, args: readonly string[]) => {
    if (state.registrationFails) throw new Error("registration refused");
    if (command === "loginctl") {
      if (args[0] === "enable-linger") state.linger = true;
      return state.linger ? "yes\n" : "no\n";
    }
    if (args.includes("enable")) state.enabled = true;
    if (args.includes("disable")) state.enabled = false;
    if (args.includes("start")) state.running = true;
    if (args.includes("stop")) state.running = false;
    if (args.includes("show")) return `InvocationID=fixture\nActiveState=${state.running ? "active" : "inactive"}\nResult=success\n`;
    return "";
  };
  const startup = new WorkbenchServiceStartup({
    root: path.join(home, "checkout"), home, platform: "linux", run,
    nodePath: "/usr/bin/node", configDirectory: path.join(home, ".config"),
  });
  return { startup, state, home };
}

test("on-demand platform startup does not silently enable boot startup", async context => {
  const { startup, state } = await fixture(context);
  await startup.start(false);
  assert.equal(state.running, true);
  assert.equal(state.enabled, false);
  assert.equal(state.linger, false);
});

test("ordinary app startup preserves an already enabled wake service", async context => {
  const { startup, state } = await fixture(context);
  await startup.setEnabled(true);
  state.running = false;
  await startup.start();
  assert.equal(state.enabled, true);
  assert.equal(state.running, true);
});

test("disabling wake removes boot enablement but leaves current consumers running", async context => {
  const { startup, state } = await fixture(context);
  await startup.setEnabled(true);
  assert.equal(state.enabled, true);
  assert.equal(state.linger, true);
  await startup.setEnabled(false);
  assert.equal(state.enabled, false);
  assert.equal(state.running, true);
});

test("platform registration failure cannot be reported as successful startup", async context => {
  const { startup, state } = await fixture(context);
  state.registrationFails = true;
  await assert.rejects(startup.start(false), /registration refused/);
  assert.equal(state.running, false);
});
