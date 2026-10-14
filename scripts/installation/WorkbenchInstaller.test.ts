/*
 * No production exports. Tests pinned checkout installation and optional first-run actions.
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import WorkbenchInstaller from "./WorkbenchInstaller.mjs";

function fixture(answers = [], tailscale = false, nodeVersion = process.versions.node) {
  const calls = [];
  const prompts = [];
  const output = [];
  const root = path.resolve(import.meta.dirname, "../..");
  const commands = { run: async (command, args, config) => { calls.push({ command, args, config }); } };
  const setup = new WorkbenchInstaller({
    root,
    nodeVersion,
    commands,
    powerShell: { ensure: async () => { calls.push({ command: "powershell-runtime", args: [], config: {} }); } },
    toolchain: {
      ensure: async () => {},
      run: (args, config) => commands.run("vp", args, config),
      runNode: (_root, entry, args, config) => commands.run("vp", ["node", entry, ...args], config),
    },
    prompt: { choose: async (question, choices) => { prompts.push(question); return answers.shift() ?? choices.at(-1); } },
    detectTailscale: async () => tailscale,
    write: text => output.push(text),
  });
  return { setup, calls, prompts, output, root };
}

test("repository handoff installs the runtime and relaunches under pinned Node", async () => {
  const f = fixture();
  await f.setup.prepare();
  assert.deepEqual(f.calls.map(({ command, args }) => [command, ...args]), [
    ["powershell-runtime"],
    ["vp", "env", "install"],
    ["vp", "node", path.join(f.root, "scripts", "install.mjs"), "--prepare-pinned"],
  ]);
});

test("pinned repository setup builds without registering a public CLI through its private toolchain", async () => {
  const f = fixture();
  await f.setup.preparePinned();
  assert.deepEqual(f.calls.map(({ command, args }) => [command, ...args]), [
    ["vp", "install"],
    ["vp", "run", "build:app"],
  ]);
  assert.ok(!f.calls.some(call => ["cargo", "go"].includes(call.command)));
  assert.equal(f.prompts.length, 0);
});

test("native tool failure remains visible and does not register the CLI", async () => {
  const f = fixture();
  f.setup.commands.run = async (command, args, config) => {
    f.calls.push({ command, args, config });
    config?.onOutput?.("gyp ERR! find Python Could not find any Python installation to use");
    throw new Error("vp failed with status 1.");
  };
  await assert.rejects(f.setup.preparePinned(), /Python/);
  assert.equal(f.calls.length, 1);
});

test("an incorrect checkout Node stops before dependency scripts", async () => {
  const f = fixture([], false, "24.21.0");
  await assert.rejects(f.setup.preparePinned(), /26\.9\.0.*24\.21\.0/);
  assert.equal(f.calls.length, 0);
});

test("first launch can skip wake and shortcut independently", async () => {
  const f = fixture(["Skip", "Skip"], true);
  await f.setup.welcome();
  const dispatches = f.calls.filter(call => call.args.some(arg => arg.endsWith("dispatch.mjs")));
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].args.length, 2);
  assert.equal(f.prompts.length, 2);
  assert.ok(f.output.join("").includes("wb shortcut"));
});

test("cancelling a later questionnaire step performs no optional actions", async () => {
  const f = fixture([], true);
  let question = 0;
  f.setup.prompt.choose = async (label) => {
    f.prompts.push(label);
    if (question++ === 0) return "Enable wake service";
    throw new DOMException("Setup cancelled.", "AbortError");
  };
  await assert.rejects(f.setup.welcome(), { name: "AbortError" });
  assert.equal(f.prompts.length, 2);
  assert.deepEqual(f.calls, []);
});

test("connect setup does not ask about or launch the app", async () => {
  const f = fixture();
  await f.setup.connect();
  assert.equal(f.prompts.length, 0);
  assert.deepEqual(f.calls.map(call => call.args.at(-1)), ["connect"]);
});

test("welcome only offers wake with tailscale and omits completed shortcut help", async () => {
  const f = fixture(["Add shortcut"], false);
  await f.setup.welcome();
  assert.equal(f.prompts.length, 1);
  assert.deepEqual(f.calls.map(call => call.args.at(-1)), [
    "shortcut", path.join(f.root, "cli", "dispatch.mjs"),
  ]);
  assert.ok(!f.output.join("").includes("wb shortcut"));
});
