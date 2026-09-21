/*
 * No production exports. Tests checkout setup and optional first-run actions.
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import WorkbenchSetup from "./WorkbenchSetup.mjs";

function fixture(answers = [], tailscale = false) {
  const calls = [];
  const prompts = [];
  const output = [];
  const root = path.resolve("test-checkout");
  const setup = new WorkbenchSetup({
    root,
    commands: { run: async (command, args) => { calls.push({ command, args }); } },
    shellInstall: {
      preflight: async () => {},
      install: async () => { calls.push({ command: "shell-install", args: [] }); },
    },
    prompt: { choose: async (question, choices) => { prompts.push(question); return answers.shift() ?? choices.at(-1); } },
    detectTailscale: async () => tailscale,
    write: text => output.push(text),
  });
  return { setup, calls, prompts, output, root };
}

test("repository setup builds frontend but never requires native artifacts", async () => {
  const f = fixture();
  await f.setup.prepare();
  assert.ok(f.calls.some(call => call.command === "pnpm" && call.args[0] === "install"));
  assert.ok(f.calls.some(call => call.args.includes("build:app")));
  assert.ok(!f.calls.some(call => ["cargo", "go"].includes(call.command)));
  assert.equal(f.prompts.length, 0);
});

test("first launch can skip wake and shortcut independently", async () => {
  const f = fixture(["Skip", "Skip"], true);
  await f.setup.welcome();
  const dispatches = f.calls.filter(call => call.args.some(arg => arg.endsWith("dispatch.mjs")));
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].args.length, 1);
  assert.equal(f.prompts.length, 2);
  assert.ok(f.output.join("").includes("wb shortcut"));
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
    "shortcut", path.join(f.root, "package", "dispatch.mjs"),
  ]);
  assert.ok(!f.output.join("").includes("wb shortcut"));
});
