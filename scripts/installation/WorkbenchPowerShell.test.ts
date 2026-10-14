/*
 * No production exports. Tests protect managed PowerShell receipt ownership, atomic repair and platform boundaries.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import WorkbenchTemporaryDirectory from "../../shared/WorkbenchTemporaryDirectory";
import { WORKBENCH_POWERSHELL_VERSION } from "../../shared/windows-powershell-runtime.mjs";
import WorkbenchPowerShell from "./WorkbenchPowerShell.mjs";

async function fixture(context: test.TestContext) {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-powershell-");
  context.after(() => temporary.dispose());
  let installs = 0;
  const commands = {
    run: async (executable: string, _args: string[], config: { output?: { write(bytes: Buffer): unknown } }) => {
      try { await fs.access(executable); }
      catch (error) { throw Object.assign(new Error("missing runtime"), { code: (error as NodeJS.ErrnoException).code }); }
      config.output?.write(Buffer.from(`${WORKBENCH_POWERSHELL_VERSION}\n`));
    },
  };
  const powerShell = new WorkbenchPowerShell({
    dataRoot: temporary.path,
    platform: "win32",
    arch: "x64",
    commands,
    install: async ({ destination }: { destination: string }) => {
      installs++;
      await fs.mkdir(destination, { recursive: true });
      await fs.writeFile(path.join(destination, "pwsh.exe"), "fixture");
    },
  });
  return { temporary, powerShell, installs: () => installs };
}

test("managed PowerShell is installed once, recorded ready and reused by absolute path", async context => {
  const f = await fixture(context);
  const executable = await f.powerShell.ensure();
  assert.equal(path.isAbsolute(executable!), true);
  assert.equal(f.installs(), 1);
  assert.equal(await f.powerShell.ensure(), executable);
  assert.equal(f.installs(), 1);
  assert.equal(await f.powerShell.resolve(), executable);
  assert.equal(JSON.parse(await fs.readFile(f.powerShell.receipt, "utf8")).ready, true);
});

test("missing or wrong managed runtime is repaired at the same pinned path", async context => {
  const f = await fixture(context);
  const executable = await f.powerShell.ensure();
  await fs.unlink(executable!);
  assert.equal(await f.powerShell.ensure(), executable);
  assert.equal(f.installs(), 2);
});

test("a valid older receipt upgrades to the current pin and retires its managed architecture", async context => {
  const f = await fixture(context);
  const oldExecutable = path.join(f.temporary.path, "toolchain", "powershell", "7.5.0", "x64", "pwsh.exe");
  await fs.mkdir(path.dirname(oldExecutable), { recursive: true });
  await fs.writeFile(oldExecutable, "old");
  await fs.mkdir(path.dirname(f.powerShell.receipt), { recursive: true });
  await fs.writeFile(f.powerShell.receipt, JSON.stringify({
    version: 1, ready: true, release: "7.5.0", arch: "x64", executable: oldExecutable,
  }));
  assert.equal(await f.powerShell.ensure(), f.powerShell.executable());
  await assert.rejects(fs.access(path.dirname(oldExecutable)), { code: "ENOENT" });
  assert.equal(f.installs(), 1);
});

test("failed setup remains incomplete and resolve directs the user to repair", async context => {
  const f = await fixture(context);
  f.powerShell.install = async () => { throw new Error("download failed"); };
  await assert.rejects(f.powerShell.ensure(), /download failed/u);
  assert.equal(JSON.parse(await fs.readFile(f.powerShell.receipt, "utf8")).ready, false);
  await assert.rejects(f.powerShell.resolve(), /wb repair/u);
});

test("non-Windows systems neither provision nor resolve PowerShell", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-powershell-linux-");
  context.after(() => temporary.dispose());
  const powerShell = new WorkbenchPowerShell({ dataRoot: temporary.path, platform: "linux" });
  assert.equal(await powerShell.ensure(), null);
  assert.equal(await powerShell.resolve(), null);
  await assert.rejects(fs.access(powerShell.receipt), { code: "ENOENT" });
});
