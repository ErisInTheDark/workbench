/*
 * No production exports. Tests setup process argument and failure boundaries.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import WorkbenchTemporaryDirectory from "../shared/WorkbenchTemporaryDirectory";
import SetupCommand from "./SetupCommand.mjs";

const windowsOnly = { skip: process.platform !== "win32" && "Git Bash lookup is Windows-only" };

/** A fake Windows machine: listed executables exist, and only `Path` (Windows' own casing) reaches PATH. */
async function machine(context: test.TestContext, executables: string[], pathDirectories: string[]) {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-bash-");
  context.after(() => temporary.dispose());
  const at = (relative: string) => path.join(temporary.path, relative);
  for (const executable of executables) {
    await fs.mkdir(path.dirname(at(executable)), { recursive: true });
    await fs.writeFile(at(executable), "");
  }
  const environment = {
    Path: pathDirectories.map(at).join(path.delimiter),
    SystemRoot: at("Windows"),
    ProgramFiles: at("Program Files"),
    LOCALAPPDATA: at("Local"),
  };
  return { at, command: new SetupCommand({ environment }) };
}

test("WSL's bash launcher is skipped in favour of the Git Bash beside git", windowsOnly, async context => {
  const m = await machine(context,
    ["Windows/System32/bash.exe", "Local/Microsoft/WindowsApps/bash.exe", "Git/cmd/git.exe", "Git/bin/bash.exe"],
    ["Windows/System32", "Local/Microsoft/WindowsApps", "Git/cmd"]);
  assert.deepEqual(await m.command.resolve("bash"), [m.at("Git/bin/bash.exe")]);
});

test("a usable bash already on PATH keeps winning", windowsOnly, async context => {
  const m = await machine(context,
    ["msys64/usr/bin/bash.exe", "Windows/System32/bash.exe", "Git/cmd/git.exe", "Git/bin/bash.exe"],
    ["msys64/usr/bin", "Windows/System32", "Git/cmd"]);
  assert.deepEqual(await m.command.resolve("bash"), [m.at("msys64/usr/bin/bash.exe")]);
});

test("Git Bash is found in its standard install location when git is not on PATH", windowsOnly, async context => {
  const m = await machine(context, ["Program Files/Git/bin/bash.exe"], []);
  assert.deepEqual(await m.command.resolve("bash"), [m.at("Program Files/Git/bin/bash.exe")]);
});

test("only WSL's bash explains that Workbench needs Git Bash", windowsOnly, async context => {
  const m = await machine(context, ["Windows/System32/bash.exe"], ["Windows/System32"]);
  await assert.rejects(m.command.resolve("bash"), error =>
    error.code === undefined && /Git Bash/u.test(error.message) && /WSL/u.test(error.message));
});

test("setup forwards literal arguments without shell interpretation", async () => {
  const output = new PassThrough();
  let text = "";
  output.on("data", chunk => { text += chunk.toString(); });
  const command = new SetupCommand({ output, errorOutput: output });
  await command.run(process.execPath, [
    "-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
    "has spaces", "$(not-a-command)", "a&b", 'a"b', "tail\\",
  ]);
  assert.deepEqual(JSON.parse(text), ["has spaces", "$(not-a-command)", "a&b", 'a"b', "tail\\"]);
});

test("setup preserves process failures and does not run cancelled commands", async () => {
  const command = new SetupCommand();
  await assert.rejects(command.run(process.execPath, ["-e", "process.exit(7)"]), /7/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(command.run(process.execPath, ["-e", "process.exit(0)"], {
    signal: controller.signal,
  }), { name: "AbortError" });
  await assert.rejects(command.run("workbench-nonexistent-command-for-test", []), error =>
    error.code === "ENOENT" && /workbench-nonexistent-command-for-test.*PATH/i.test(error.message));
});

test("interactive handoff releases signal forwarding after child exit and startup failure", async () => {
  const command = new SetupCommand();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const before = signals.map(signal => process.listenerCount(signal));
  await command.run(process.execPath, ["-e", "process.exit(0)"], { interactive: true });
  assert.deepEqual(signals.map(signal => process.listenerCount(signal)), before);
  await assert.rejects(command.run("workbench-nonexistent-interactive-test", [], { interactive: true }), error =>
    error.code === "ENOENT" && /workbench-nonexistent-interactive-test.*PATH/i.test(error.message));
  assert.deepEqual(signals.map(signal => process.listenerCount(signal)), before);
});
