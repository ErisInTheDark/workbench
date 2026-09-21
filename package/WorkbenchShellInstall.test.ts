/*
 * No production exports. Tests shell shim ownership and literal checkout delegation.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import WorkbenchShellInstall from "./WorkbenchShellInstall.mjs";

test("owned shell shims delegate literal checkout paths and preserve failures", async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wb-shell-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const checkout = path.join(root, "a 'quoted' checkout");
  const bin = path.join(root, "bin");
  await fs.mkdir(checkout);
  await fs.mkdir(bin);
  await fs.writeFile(path.join(checkout, "wb"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\"\nexit 7\n");
  const install = new WorkbenchShellInstall({ root: checkout, platform: "linux", bin });
  await install.install();
  await assert.rejects(promisify(execFile)("bash", [path.join(bin, "wb"), "a b", "$(literal)"]), error => {
    assert.equal(error.code, 7);
    assert.equal(error.stdout, "a b\n$(literal)\n");
    return true;
  });
  await install.install();
});

test("shell installation refuses unrelated commands", async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wb-shell-owned-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = "#!/bin/sh\necho somebody else's command\n";
  await fs.writeFile(path.join(root, "wb"), original);
  const install = new WorkbenchShellInstall({ root: path.join(root, "checkout"), platform: "linux", bin: root });
  await assert.rejects(install.install(), /unrelated/i);
  assert.equal(await fs.readFile(path.join(root, "wb"), "utf8"), original);
});

test("Windows cmd shim preserves arguments and failure without bootstrapping Node", async context => {
  if (process.platform !== "win32") { context.skip("Windows command interpreter required."); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wb-cmd-shell-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const checkout = path.join(root, "space %literal% checkout");
  const bin = path.join(root, "bin");
  await fs.mkdir(checkout);
  await fs.writeFile(path.join(checkout, "wb"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\"\nexit 7\n");
  const install = new WorkbenchShellInstall({ root: checkout, platform: "win32", bin });
  await install.install();
  await assert.rejects(promisify(execFile)("cmd.exe", ["/d", "/c", 'wb.cmd thread "a b"'], {
    cwd: bin, windowsVerbatimArguments: true,
  }), error => {
    assert.equal(error.code, 7);
    assert.equal(error.stdout.replaceAll("\r\n", "\n"), "thread\na b\n");
    return true;
  });
});
