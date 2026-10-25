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
type RunOptions = { cwd?: string; output?: { write(bytes: unknown): unknown }; errorOutput?: { write(bytes: unknown): unknown }; environment?: NodeJS.ProcessEnv };

for (const toolchain of ["existing", "missing"] as const) test(`a sandboxed install with ${toolchain} Vite+ registers through ${toolchain === "existing" ? "pnpm" : "npm"} and works without private tools on PATH`, async context => {
  const log: string[] = [];
  const sandbox = await InstallSandbox.create({ toolchain, write: text => log.push(text) });
  context.after(() => sandbox.dispose());
  const publicBin = toolchain === "existing"
    ? (await sandbox.run("pnpm", ["bin", "--global"])).trim()
    : path.join(sandbox.npmPrefix, ...(process.platform === "win32" ? [] : ["bin"]));
  if (toolchain === "existing") {
    sandbox.environment.npm_config_user_agent = `pnpm/${(await sandbox.run("pnpm", ["--version"])).trim()}`;
    sandbox.environment.PATH = `${publicBin}${path.delimiter}${sandbox.environment.PATH}`;
  }

  const { default: Bootstrap } = await import(pathToFileURL(path.join(sandbox.packageRoot, "WorkbenchBootstrap.mjs")).href);
  const { default: WorkbenchBootstrapCommand } = await import(
    pathToFileURL(path.join(sandbox.packageRoot, "WorkbenchBootstrapCommand.mjs")).href,
  );
  const sink = { write: (bytes: unknown) => { log.push(String(bytes)); return true; } };
  const real = new WorkbenchBootstrapCommand({ environment: sandbox.environment, output: sink, errorOutput: sink });
  const calls: Call[] = [];
  const commands = new WorkbenchBootstrapCommand({ environment: sandbox.environment, output: sink, errorOutput: sink });
  commands.run = async (command: string, args: readonly string[], options: RunOptions = {}) => {
    calls.push({ command, args });
    // The welcome prompts need a terminal; `pnpm sandbox:install` covers that experience.
    if (args.includes("--welcome")) return;
    return await real.run(command, args, { ...options, output: options.output ?? sink, errorOutput: options.errorOutput ?? sink });
  };
  const profile = path.join(sandbox.home, ".bashrc");
  await fs.writeFile(profile, "# sandbox profile must stay unchanged\n");
  const userPath = process.platform === "win32"
    ? await sandbox.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetEnvironmentVariable('Path', 'User')"])
    : null;
  const prompts: string[] = [];
  const bootstrap = new Bootstrap({
    home: sandbox.home,
    environment: sandbox.environment,
    write: (text: string) => { log.push(text); },
    commands,
    prompt: {
      choose: async (question: string) => { prompts.push(question); return "Let's go!"; },
      location: async (_label: string, initial: string) => initial,
      withHeader: <T>(task: () => Promise<T>) => task(),
    },
  });

  try { await bootstrap.run([]); }
  catch (error) {
    throw new Error(`Sandboxed install failed in ${sandbox.root}\n${log.join("").slice(-8000)}`, { cause: error });
  }

  const record = JSON.parse(await fs.readFile(path.join(sandbox.dataRoot, "installation", "installation.json"), "utf8"));
  assert.deepEqual(record, { version: 1, root: sandbox.defaultCheckout, phase: "ready" });
  assert.equal(prompts.length, 1, "a fresh install asks for consent once");
  const head = async (cwd: string) => (await sandbox.run("git", ["rev-parse", "HEAD"], { cwd })).trim();
  assert.equal(await head(sandbox.defaultCheckout), await head(sandbox.repository), "the checkout is the sandbox snapshot");
  assert.ok(calls.some(call => call.args.includes("--welcome")), "setup hands off to the welcome flow");

  assert.equal(await fs.readFile(profile, "utf8"), "# sandbox profile must stay unchanged\n");
  if (userPath !== null) assert.equal(
    await sandbox.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetEnvironmentVariable('Path', 'User')"]),
    userPath,
  );
  const selection = JSON.parse(await fs.readFile(path.join(sandbox.dataRoot, "installation", "toolchain.json"), "utf8"));
  assert.equal(selection.kind, toolchain === "existing" ? "external" : "managed");
  assert.equal(selection.environment.VP_HOME, sandbox.vpHome);
  if (process.platform === "win32") {
    const powerShell = JSON.parse(await fs.readFile(path.join(sandbox.dataRoot, "installation", "powershell.json"), "utf8"));
    assert.equal(powerShell.ready, true);
    assert.equal((await sandbox.run(powerShell.executable, [
      "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()",
    ])).trim(), powerShell.release);
  }
  const freshEnvironment = { ...sandbox.environment };
  delete freshEnvironment.VP_HOME;
  freshEnvironment.PATH = freshEnvironment.PATH.split(path.delimiter).filter(directory => directory !== sandbox.vpBin).join(path.delimiter);
  const globalWb = path.join(publicBin, "wb");
  await fs.access(globalWb);
  const shortcut = await sandbox.run("bash", [globalWb, "shortcut"], { environment: freshEnvironment });
  assert.match(shortcut, /pretending: adding a desktop shortcut/u);
  const { default: Toolchain } = await import(pathToFileURL(path.join(sandbox.packageRoot, "WorkbenchToolchain.mjs")).href);
  let nodeVersion = "";
  const selected = new Toolchain({
    environment: freshEnvironment, home: sandbox.home,
    commands: new WorkbenchBootstrapCommand({ environment: freshEnvironment, output: { write: (bytes: string | Uint8Array) => { nodeVersion += String(bytes); } } }),
  });
  await selected.runNode(sandbox.defaultCheckout, "process.versions.node", [], { cwd: sandbox.home, nodeOptions: ["-p"] });
  const manifest = JSON.parse(await fs.readFile(path.join(sandbox.defaultCheckout, "package.json"), "utf8"));
  assert.equal(nodeVersion.trim(), manifest.devEngines.runtime.version);
  if (toolchain === "missing") {
    const repaired = await sandbox.run("bash", [globalWb, "repair"], { environment: freshEnvironment });
    assert.match(repaired, /dependency repair complete/u);
  }

  calls.length = 0;
  const launched: string[] = [];
  const delegated = new Bootstrap({
    home: sandbox.home,
    environment: freshEnvironment,
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
