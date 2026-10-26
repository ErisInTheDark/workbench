/*
 * No production exports. Tests protect Workbench-owned npm installs of stdio MCP servers: the launched command is the
 * package's own bin run with the user's arguments, a missing install is restored at its pinned version, and failed
 * installs leave nothing behind.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import McpPackageInstaller from "./McpPackageInstaller";

const run = promisify(execFile);
const ECHO_ARGV = "console.log(JSON.stringify(process.argv.slice(2)));\n";

/** Fake registry: each package name maps to the files `npm install` would unpack for it, at version 1.4.2. */
async function harness(context: TestContext, packages: Record<string, { bin?: unknown; files?: Record<string, string> }>) {
  const temporary = await WorkbenchTemporaryDirectory.create("mcp-package-installer-");
  context.after(() => temporary.dispose());
  const installs: string[] = [];
  let failure: Error | null = null;
  const installer = new McpPackageInstaller({
    root: temporary.path,
    warn: message => assert.fail(message),
    runNpm: async args => {
      const spec = args.at(-1)!;
      installs.push(spec);
      if (failure) throw failure;
      const name = spec.slice(0, spec.lastIndexOf("@"));
      const entry = packages[name];
      if (!entry) throw new Error(`404 ${name}`);
      const root = path.join(args[args.indexOf("--prefix") + 1]!, "node_modules", ...name.split("/"));
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, "package.json"), JSON.stringify({ name, version: "1.4.2", bin: entry.bin }));
      for (const [file, content] of Object.entries(entry.files ?? {})) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), content);
      }
    },
  });
  context.after(() => installer.dispose());
  return { root: temporary.path, installer, installs, fail: (error: Error | null) => { failure = error; } };
}

test("the launched command runs the package's bin with the user's arguments, choosing the bin npx would", async context => {
  const { installer } = await harness(context, {
    "@azure-devops/mcp": { bin: { "mcp-helper": "dist/helper.js", mcp: "dist/index" }, files: { "dist/index": `#!/usr/bin/env node\n${ECHO_ARGV}` } },
  });
  const version = await installer.install("server-1", "@azure-devops/mcp");
  assert.equal(version, "1.4.2");
  const launch = await installer.launch("server-1", { package: "@azure-devops/mcp", version, args: ["contoso", "two words"] });
  // An extensionless Node script still runs under the daemon's own Node, so PATH never decides which Node starts it.
  assert.equal(launch.command, process.execPath);
  const { stdout } = await run(launch.command, launch.args, { cwd: launch.cwd });
  assert.deepEqual(JSON.parse(stdout), ["contoso", "two words"]);
});

test("a missing install is restored at the pinned version before launching", async context => {
  const { root, installer, installs } = await harness(context, { server: { bin: "index.js", files: { "index.js": ECHO_ARGV } } });
  await installer.install("server-1", "server", "^1");
  await rm(path.join(root, "server-1"), { recursive: true, force: true });
  const launch = await installer.launch("server-1", { package: "server", version: "1.4.2", args: [] });
  assert.deepEqual(installs, ["server@^1", "server@1.4.2"]);
  assert.deepEqual(JSON.parse((await run(launch.command, launch.args, { cwd: launch.cwd })).stdout), []);
});

test("a failed install or a package with no command leaves nothing installed", async context => {
  const { root, installer, fail } = await harness(context, {
    library: { files: { "index.js": "" } },
    tools: { bin: { one: "one.js", two: "two.js" }, files: { "one.js": "", "two.js": "" } },
  });
  await assert.rejects(installer.install("server-1", "library"), /has no command to run/u);
  await assert.rejects(installer.install("server-1", "tools"), /several commands \(one, two\)/u);
  // npm's exec error leads with its whole command line; only npm's own explanation is worth showing.
  fail(Object.assign(new Error("Command failed: C:/node.exe npm-cli.js install --prefix C:/staging missing@latest"), {
    stderr: "npm warn Unknown user config\nnpm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/missing\nnpm error\n",
  }));
  await assert.rejects(installer.install("server-1", "missing"),
    { message: "npm couldn't install missing@latest: code E404; 404 Not Found - GET https://registry.npmjs.org/missing" });
  assert.deepEqual(await readdir(root), []);
});
