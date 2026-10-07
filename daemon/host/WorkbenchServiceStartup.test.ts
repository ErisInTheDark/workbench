/*
 * No production exports. Tests on-demand startup independence from boot enablement and systemd unit encoding.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import WorkbenchTemporaryDirectory from "../../shared/WorkbenchTemporaryDirectory.ts";
import test, { type TestContext } from "node:test";
import WorkbenchServiceStartup from "./WorkbenchServiceStartup.ts";

async function fixture(context: TestContext) {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-startup-");
  const home = temporary.path;
  context.after(() => temporary.dispose());
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

/** Decodes `%` specifiers the way systemd does; any specifier other than `%%` would be expanded by systemd. */
function decodeSpecifiers(value: string) {
  return value.replace(/%(.)/gu, (_match, next: string) => {
    if (next !== "%") throw new Error(`Unescaped systemd specifier %${next}.`);
    return "%";
  });
}

test("linux unit directives decode to the exact checkout and data paths", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-startup-");
  context.after(() => temporary.dispose());
  const root = path.join(temporary.path, "odd $HOME 100% \"dir\"", "checkout");
  const dataRoot = path.join(temporary.path, "data $USER 50%");
  const configDirectory = path.join(temporary.path, ".config");
  const startup = new WorkbenchServiceStartup({
    root, dataRoot, home: temporary.path, platform: "linux", configDirectory,
    nodePath: "/usr/bin/node",
    run: async (_command, args) => args.includes("show") ? "InvocationID=fixture\nActiveState=inactive\n" : "",
  });
  await startup.start(false);
  const unit = await fs.readFile(path.join(configDirectory, "systemd", "user", "workbench-host.service"), "utf8");
  const directive = (name: string) => {
    const line = unit.split("\n").find(item => item.startsWith(`${name}=`) && item.includes("WORKBENCH_DATA_ROOT") === (name === "Environment"));
    assert.ok(line, `${name} directive missing`);
    return line.slice(name.length + 1);
  };
  // WorkingDirectory= is literal apart from specifiers; systemd never unquotes it.
  assert.equal(decodeSpecifiers(directive("WorkingDirectory")), root);
  // Environment= unquotes and C-unescapes but does not expand `$`.
  const environment = directive("Environment");
  assert.match(environment, /^".*"$/u);
  const decoded = decodeSpecifiers(environment.slice(1, -1).replace(/\\(.)/gu, "$1"));
  assert.equal(decoded, `WORKBENCH_DATA_ROOT=${dataRoot}`);
});

test("platform registration failure cannot be reported as successful startup", async context => {
  const { startup, state } = await fixture(context);
  state.registrationFails = true;
  await assert.rejects(startup.start(false), /registration refused/);
  assert.equal(state.running, false);
});
