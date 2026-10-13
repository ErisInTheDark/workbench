/*
 * No production exports. Protect toolchain ownership, interrupted provisioning and pinned child execution.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import WorkbenchTemporaryDirectory from "../shared/WorkbenchTemporaryDirectory";
import WorkbenchBootstrapCommand from "./WorkbenchBootstrapCommand.mjs";
import WorkbenchToolchain from "./WorkbenchToolchain.mjs";

async function fixture(context: test.TestContext) {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-toolchain-");
  context.after(() => temporary.dispose());
  const dataRoot = path.join(temporary.path, "data with spaces");
  const root = path.join(temporary.path, "checkout");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    devEngines: { runtime: { name: "node", version: "24.4.0" }, packageManager: { name: "pnpm", version: "10.8.1" } },
  }));
  const environment = { PATH: "", VP_NODE_VERSION: "99.0.0", VP_PACKAGE_MANAGER: "npm@99" };
  const commands = new WorkbenchBootstrapCommand({ environment });
  const calls = [];
  commands.run = async (command, args, options = {}) => {
    calls.push({ command, args, environment: commands.environmentFor(options.environment), cwd: options.cwd });
    await fs.access(command);
  };
  let installs = 0;
  const install = async ({ home }) => {
    installs++;
    await fs.mkdir(path.join(home, "bin"), { recursive: true });
    await fs.writeFile(path.join(home, "bin", process.platform === "win32" ? "vp.exe" : "vp"), "fixture");
  };
  const toolchain = new WorkbenchToolchain({ dataRoot, environment, commands, install });
  return { temporary, dataRoot, root, environment, commands, calls, install, toolchain, installs: () => installs };
}

test("managed selection survives PATH and inherited overrides without moving the runtime", async context => {
  const f = await fixture(context);
  const first = await f.toolchain.ensure();
  assert.equal(f.installs(), 1);
  assert.equal(first.environment.VP_HOME, path.join(f.dataRoot, "toolchain"));
  f.commands.environment = { PATH: "/another-toolchain", VP_HOME: "/wrong-home", VP_NODE_VERSION: "99.0.0" };
  const next = new WorkbenchToolchain({ dataRoot: f.dataRoot, environment: {}, commands: f.commands, install: f.install });
  await next.ensure();
  await next.run(["install"], { cwd: f.root });
  const call = f.calls.at(-1);
  assert.equal(call.command, first.executable);
  assert.equal(call.environment.VP_HOME, first.environment.VP_HOME);
  assert.equal(call.environment.VP_NODE_VERSION, "24.4.0");
  assert.equal(call.environment.VP_PACKAGE_MANAGER, "pnpm@10.8.1");
  assert.equal(f.installs(), 1);
  await next.runNode(f.root, "entry.mjs", ["has spaces"], { cwd: f.temporary.path });
  assert.equal(f.calls.at(-1).cwd, f.temporary.path, "runtime selection must not change caller cwd");
  assert.ok(f.calls.at(-1).args.includes("24.4.0"));
  assert.ok(f.calls.at(-1).args.includes("pnpm@10.8.1"));
  assert.equal(f.calls.at(-1).args.at(-1), "has spaces");
});

test("external custom homes are retained and missing external executables are never replaced", async context => {
  const f = await fixture(context);
  const external = path.join(f.temporary.path, "external vp");
  await fs.writeFile(external, "fixture");
  const externalHome = path.join(f.temporary.path, "external data");
  f.commands.environment = { PATH: "", VP_HOME: externalHome };
  f.commands.findExecutable = async () => external;
  const selected = await f.toolchain.ensure();
  assert.equal(selected.environment.VP_HOME, externalHome);
  assert.equal(f.installs(), 0);
  await fs.unlink(external);
  await assert.rejects(f.toolchain.ensure(), /user-owned/u);
  assert.equal(f.installs(), 0);
  assert.equal((await f.toolchain.read()).executable, external);
});

test("interrupted setup is not ready even if its executable was already unpacked", async context => {
  const f = await fixture(context);
  f.toolchain.install = async options => {
    await f.install(options);
    throw new Error("download interrupted");
  };
  await assert.rejects(f.toolchain.ensure(), /interrupted/u);
  await assert.rejects(f.toolchain.resolve(), /incomplete/u);
  f.toolchain.install = f.install;
  await f.toolchain.ensure();
  assert.equal(f.installs(), 2);
  assert.equal((await f.toolchain.resolve()).ready, true);
});

test("a failed restoration cannot leave a previously ready receipt pointing at a partial install", async context => {
  const f = await fixture(context);
  const record = await f.toolchain.ensure();
  await fs.unlink(record.executable);
  f.toolchain.install = async options => {
    await f.install(options);
    throw new Error("restoration interrupted");
  };
  await assert.rejects(f.toolchain.ensure(), /restoration interrupted/u);
  await assert.rejects(f.toolchain.resolve(), /incomplete/u);
});

test("initialisation lock excludes another installer and releases after failure", async context => {
  const f = await fixture(context);
  let entered!: () => void;
  let finish!: () => void;
  const installing = new Promise<void>(resolve => { entered = resolve; });
  const release = new Promise<void>(resolve => { finish = resolve; });
  f.toolchain.install = async () => { entered(); await release; throw new Error("interrupted"); };
  const pending = assert.rejects(f.toolchain.ensure(), /interrupted/u);
  await installing;
  await assert.rejects(new WorkbenchToolchain({
    dataRoot: f.dataRoot, environment: {}, commands: f.commands, install: f.install,
  }).ensure(), /Another Workbench/u);
  finish();
  await pending;
  f.toolchain.install = f.install;
  await f.toolchain.ensure();
});

test("invalid receipts stop rather than falling back to PATH or overwriting evidence", async context => {
  const f = await fixture(context);
  await fs.mkdir(path.dirname(f.toolchain.receipt), { recursive: true });
  await fs.writeFile(f.toolchain.receipt, '{"version":1,"executable":"relative"}');
  await assert.rejects(f.toolchain.ensure(), /Invalid toolchain receipt/u);
  assert.equal(f.installs(), 0);
  assert.equal(await fs.readFile(f.toolchain.receipt, "utf8"), '{"version":1,"executable":"relative"}');
});

test("an unready external receipt never authorises installing into managed storage", async context => {
  const f = await fixture(context);
  const executable = path.join(f.temporary.path, "external");
  await fs.writeFile(executable, "fixture");
  f.commands.findExecutable = async () => executable;
  const record = await f.toolchain.ensure();
  await fs.writeFile(f.toolchain.receipt, JSON.stringify({ ...record, ready: false }));
  await assert.rejects(f.toolchain.ensure(), /Invalid toolchain receipt/u);
  assert.equal(f.installs(), 0);
});
