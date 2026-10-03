/*
 * No production exports. Runs the npm-installed wb bootstrap through a real install inside an InstallSandbox.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import InstallSandbox from "./InstallSandbox.ts";

type Call = { command: string; args: readonly string[] };
type RunOptions = { cwd?: string; output?: { write(bytes: unknown): unknown }; errorOutput?: { write(bytes: unknown): unknown } };

test("a fresh sandboxed install clones the working tree, builds it and hands later runs to the checkout", async context => {
  const log: string[] = [];
  const sandbox = await InstallSandbox.create({ write: text => log.push(text) });
  context.after(() => sandbox.dispose());

  const { default: Bootstrap } = await import(pathToFileURL(path.join(sandbox.packageRoot, "WorkbenchBootstrap.mjs")).href);
  const { default: SetupCommand } = await import(pathToFileURL(path.join(sandbox.packageRoot, "SetupCommand.mjs")).href);
  const sink = { write: (bytes: unknown) => { log.push(String(bytes)); return true; } };
  const real = new SetupCommand({ environment: sandbox.environment, output: sink, errorOutput: sink });
  const calls: Call[] = [];
  const commands = {
    async run(command: string, args: readonly string[], options: RunOptions = {}) {
      calls.push({ command, args });
      // The welcome prompts need a terminal; `pnpm sandbox:install` covers that experience.
      if (args.includes("--welcome")) return;
      return await real.run(command, args, { ...options, output: options.output ?? sink, errorOutput: options.errorOutput ?? sink });
    },
  };
  const prompts: string[] = [];
  const bootstrap = new Bootstrap({
    home: sandbox.home,
    environment: sandbox.environment,
    write: (text: string) => { log.push(text); },
    commands,
    prompt: {
      choose: async (question: string) => { prompts.push(question); return "Let's go!"; },
      location: async (_label: string, initial: string) => initial,
    },
  });

  try { await bootstrap.run([]); }
  catch (error) {
    throw new Error(`Sandboxed install failed in ${sandbox.root}\n${log.join("").slice(-8000)}`, { cause: error });
  }

  const record = JSON.parse(await fs.readFile(path.join(sandbox.home, ".workbench", "installation.json"), "utf8"));
  assert.deepEqual(record, { version: 1, root: sandbox.defaultCheckout, phase: "ready" });
  assert.equal(prompts.length, 1, "a fresh install asks for consent once");
  const head = async (cwd: string) => (await sandbox.run("git", ["rev-parse", "HEAD"], { cwd })).trim();
  assert.equal(await head(sandbox.defaultCheckout), await head(sandbox.repository), "the checkout is the sandbox snapshot");
  assert.ok(calls.some(call => call.args.includes("--welcome")), "setup hands off to the welcome flow");

  // `vp install -g` registered the checkout CLI inside the sandbox VP_HOME, not the host's.
  const globalWb = path.join(sandbox.vpBin, process.platform === "win32" ? "wb.exe" : "wb");
  await fs.access(globalWb);
  const shortcut = await sandbox.run(globalWb, ["shortcut"]);
  assert.match(shortcut, /pretending: adding a desktop shortcut/u);

  calls.length = 0;
  const launched: string[] = [];
  const delegated = new Bootstrap({
    home: sandbox.home,
    environment: sandbox.environment,
    commands: { run: async (command: string, args: readonly string[]) => {
      calls.push({ command, args });
      launched.push(await sandbox.run(command, args));
    } },
    prompt: { choose: async () => assert.fail("installed runs never prompt"), location: async () => assert.fail("installed runs never prompt") },
  });
  await delegated.run([]);
  assert.equal(calls.filter(call => call.command === "git").length, 0, "installed runs never clone");
  assert.match(launched.join(""), /pretending: launching the Workbench app/u);
});
