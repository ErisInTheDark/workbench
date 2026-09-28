/* No exports. Protect exact detached-service retirement and parent-owned cleanup. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WorkbenchTestProcessResources from "./WorkbenchTestProcessResources";

test("a retained service record kills its detached process without its spawning worker", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wb-service-retirement-"));
  const record = path.join(directory, "service.json");
  const child = spawn(process.execPath, ["-e",
    'process.on("message", () => {}); process.send("ready");'], {
    detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const exited = once(child, "exit");
  try {
    await once(child, "message");
    assert.ok(child.pid);
    await fs.writeFile(record, JSON.stringify({ pid: child.pid, password: "must-not-be-logged" }));
    await WorkbenchTestProcessResources.retireService(record);
    await exited;
    await assert.rejects(fs.stat(record), { code: "ENOENT" });
    await WorkbenchTestProcessResources.retireService(record);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("failed retirement preserves the ownership record and never counts as clean", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wb-service-retirement-"));
  const record = path.join(directory, "service.json");
  try {
    await fs.writeFile(record, JSON.stringify({ pid: 12345 }));
    const killed: number[] = [];
    await assert.rejects(WorkbenchTestProcessResources.retireService(record, async pid => {
      killed.push(pid);
      throw new Error("access denied");
    }), /access denied/u);
    assert.deepEqual(killed, [12345]);
    assert.ok(await fs.stat(record));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
