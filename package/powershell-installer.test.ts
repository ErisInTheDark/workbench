/*
 * No production exports. Tests protect pinned archive selection, hash verification, extraction and temporary cleanup.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import WorkbenchTemporaryDirectory from "../shared/WorkbenchTemporaryDirectory";
import installPowerShell from "./powershell-installer.mjs";

test("a verified archive is expanded through inbox PowerShell and temporary files are removed", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-powershell-installer-");
  context.after(() => temporary.dispose());
  const bytes = Buffer.from("fixture archive");
  const destination = path.join(temporary.path, "runtime");
  const calls: { command: string; args: string[] }[] = [];
  await installPowerShell({
    destination,
    directory: temporary.path,
    arch: "x64",
    releases: { x64: { version: "1.2.3", sha256: createHash("sha256").update(bytes).digest("hex") } },
    fetchInstaller: async () => new Response(bytes),
    commands: {
      run: async (command: string, args: string[]) => {
        calls.push({ command, args });
        assert.match(args.at(-2)!, /\.zip$/u);
        await fs.writeFile(path.join(args.at(-1)!, "pwsh.exe"), "runtime");
      },
    },
  });
  assert.equal(calls[0]?.command, "powershell.exe");
  assert.deepEqual((await fs.readdir(temporary.path)).sort(), ["runtime"]);
  assert.equal(await fs.readFile(path.join(destination, "pwsh.exe"), "utf8"), "runtime");
});

test("a mismatched archive is rejected before extraction and cleaned", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-powershell-installer-hash-");
  context.after(() => temporary.dispose());
  await assert.rejects(installPowerShell({
    destination: path.join(temporary.path, "runtime"),
    directory: temporary.path,
    arch: "x64",
    releases: { x64: { version: "1.2.3", sha256: "0".repeat(64) } },
    fetchInstaller: async () => new Response("tampered"),
    commands: { run: async () => assert.fail("unverified archives cannot be expanded") },
  }), /hash mismatch/u);
  assert.deepEqual(await fs.readdir(temporary.path), []);
});

test("unsupported architectures fail before downloading", async () => {
  let fetched = false;
  await assert.rejects(installPowerShell({
    destination: "unused",
    directory: "unused",
    arch: "ia32",
    fetchInstaller: async () => { fetched = true; return new Response(); },
    commands: { run: async () => {} },
  }), /not available.*ia32/u);
  assert.equal(fetched, false);
});
