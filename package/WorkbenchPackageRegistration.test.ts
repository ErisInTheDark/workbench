/*
 * No production exports. Protect original-manager selection and reachable global registration.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import WorkbenchTemporaryDirectory from "../shared/WorkbenchTemporaryDirectory";
import WorkbenchBootstrapCommand from "./WorkbenchBootstrapCommand.mjs";
import WorkbenchPackageRegistration from "./WorkbenchPackageRegistration.mjs";

async function fixture(context: test.TestContext, manager = "npm") {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-register-");
  context.after(() => temporary.dispose());
  const prefix = path.join(temporary.path, "public packages");
  const bin = manager === "npm" && process.platform !== "win32" ? path.join(prefix, "bin") : prefix;
  const packageRoot = path.join(temporary.path, "bootstrap");
  const managerEntry = path.join(temporary.path, manager === "npm" ? "npm-cli.js" : "pnpm.cjs");
  const installed = path.join(prefix, ...(manager === "pnpm" ? ["isolated-package-group"] : []), "node_modules", "@inthedark", "wb");
  await fs.mkdir(packageRoot);
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(packageRoot, "wb"), "bootstrap");
  await fs.writeFile(managerEntry, "manager fixture");
  const environment = { PATH: bin, npm_execpath: managerEntry, npm_config_user_agent: `${manager}/11.0.0` };
  const commands = new WorkbenchBootstrapCommand({ environment });
  const calls = [];
  commands.run = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (args.includes("prefix") || args.includes("bin")) options.output.write(prefix);
    else if (args.includes("root")) options.output.write(path.join(prefix, "node_modules"));
    else if (args.includes("list")) options.output.write(`${prefix}\n${installed}`);
    else if (args.includes("install") || args.includes("add")) {
      await fs.writeFile(path.join(bin, process.platform === "win32" ? "wb.cmd" : "wb"), "registered");
      await fs.mkdir(installed, { recursive: true });
      await fs.writeFile(path.join(installed, "package.json"), JSON.stringify({ name: "@inthedark/wb", bin: { wb: "wb" } }));
      await fs.writeFile(path.join(installed, "wb"), "entry");
    }
  };
  const registration = new WorkbenchPackageRegistration({
    commands, environment, packageRoot, home: temporary.path, nodePath: process.execPath,
  });
  return { temporary, prefix, bin, environment, managerEntry, commands, calls, registration };
}

for (const manager of ["npm", "pnpm"]) {
  test(`${manager} registers through the captured host manager, not the checkout's toolchain`, async context => {
    const f = await fixture(context, manager);
    await f.registration.prepare();
    await f.registration.register(path.join(f.temporary.path, "checkout"));
    const install = f.calls.find(call => call.args.includes("install") || call.args.includes("add"));
    assert.equal(install.command, process.execPath);
    assert.equal(install.args[0], f.managerEntry);
    assert.equal(install.options.cwd, f.temporary.path);
    assert.equal(install.args.at(-1), path.join(f.temporary.path, "checkout", "package"));
  });
}

test("unreachable global bins and conflicting manager identity stop before installation", async context => {
  const f = await fixture(context);
  f.commands.environment.PATH = path.join(f.temporary.path, "elsewhere");
  await assert.rejects(f.registration.prepare(), /not on PATH/u);
  assert.equal(f.calls.some(call => call.args.includes("install")), false);
  f.commands.environment.npm_config_user_agent = "pnpm/11.0.0";
  await assert.rejects(f.registration.prepare(), /metadata conflicts/u);
});

test("a different wb ahead of the global bin is preserved and blocks misleading registration", async context => {
  const f = await fixture(context);
  const other = path.join(f.temporary.path, "other");
  await fs.mkdir(other);
  const entry = path.join(other, process.platform === "win32" ? "wb.cmd" : "wb");
  await fs.writeFile(entry, "unrelated wb");
  f.commands.environment.PATH = `${other}${path.delimiter}${f.bin}`;
  await assert.rejects(f.registration.prepare(), /Another wb command/u);
  assert.equal(await fs.readFile(entry, "utf8"), "unrelated wb");
});

test("an unrelated wb already in the selected global bin is rejected before the build", async context => {
  const f = await fixture(context);
  const entry = path.join(f.bin, process.platform === "win32" ? "wb.cmd" : "wb");
  await fs.writeFile(entry, "unrelated global command");
  await assert.rejects(f.registration.prepare(), /already contains|conflict/u);
  assert.equal(await fs.readFile(entry, "utf8"), "unrelated global command");
  assert.equal(f.calls.some(call => call.args.includes("install")), false);
});

test("changed global destination is detected before any global install", async context => {
  const f = await fixture(context);
  await f.registration.prepare();
  f.commands.run = async (_command, _args, options) => { options.output.write(path.join(f.temporary.path, "changed")); };
  await assert.rejects(f.registration.register(f.temporary.path), /destination changed/u);
});
