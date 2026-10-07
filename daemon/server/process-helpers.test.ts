/* No production exports. Tests protect process argument transport and retirement failure propagation. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

import { constants as osConstants, setPriority } from "node:os";

import { createSpawnOptions, getSpawnDescriptor, killProcessTreeAsync, lowerAgentProcessPriority } from "./process-helpers";

test("agent processes and everything they start later run below the daemon's priority", async t => {
  // The child waits for a line, then reports the priority of a grandchild it starts afterwards.
  const grandchild = `process.stdout.write(String(require("node:os").getPriority()))`;
  const parent = `
    process.stdin.once("data", () => {
      const out = require("node:child_process").spawnSync(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { windowsHide: true });
      console.log(out.stdout.toString().trim());
    });
  `;
  const child = spawn(process.execPath, ["-e", parent], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  const warnings: string[] = [];
  try {
    // Start from normal priority even when the test runner itself is already deprioritised.
    try { setPriority(child.pid!, osConstants.priority.PRIORITY_NORMAL); }
    catch { t.skip("cannot raise a child to normal priority here"); return; }
    lowerAgentProcessPriority(child, message => warnings.push(message));
    const lines = createInterface({ input: child.stdout });
    // Closing stdin lets the child exit after it reports, instead of idling on an open pipe.
    child.stdin.end("go\n");
    const [line] = await once(lines, "line", { signal: t.signal });
    lines.close();
    assert.equal(Number(line), osConstants.priority.PRIORITY_BELOW_NORMAL);
    assert.deepEqual(warnings, []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("lowering an agent's priority after it already exited is quiet; other failures warn", () => {
  const warnings: string[] = [];
  // Same shape os.setPriority throws: ERR_SYSTEM_ERROR carrying the libuv code in `info`.
  const fake = (code: string) => () => {
    throw Object.assign(new Error(`set failed ${code}`), { code: "ERR_SYSTEM_ERROR", info: { code } });
  };
  lowerAgentProcessPriority({ pid: 4242 } as ChildProcess, message => warnings.push(message), fake("ESRCH"));
  assert.deepEqual(warnings, []);
  lowerAgentProcessPriority({ pid: 4242 } as ChildProcess, message => warnings.push(message), fake("EACCES"));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /pid 4242.*set failed EACCES/u);
});

test("Windows retirement closes an owned child and its descendant", {
  skip: process.platform !== "win32",
}, async t => {
  // The descendant's private HTTP close route is test cleanup, not the mechanism
  // being proved. Inherited stdout keeps `close` pending until both children exit.
  const descendant = `
    const http = require("node:http");
    const server = http.createServer((_request, response) => {
      response.end(); server.close();
    });
    server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ pid: process.pid, port: server.address().port })));
  `;
  const parent = `
    require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
    process.stdin.resume();
  `;
  const child = spawn(process.execPath, ["-e", parent], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  const closed = once(child, "close", { signal: t.signal });
  void closed.catch(() => {});
  let address: { pid: number; port: number } | undefined;
  try {
    const [line] = await once(lines, "line", { signal: t.signal });
    address = JSON.parse(line) as { pid: number; port: number };
    assert.ok(Number.isSafeInteger(address.pid) && address.pid > 0);
    await killProcessTreeAsync(child.pid);
    await closed;
    assert.throws(() => process.kill(address!.pid, 0), { code: "ESRCH" });
  } finally {
    if (address) {
      await fetch(`http://127.0.0.1:${address.port}/close`, { method: "POST" }).catch(error => {
        if (error.cause?.code !== "ECONNREFUSED") throw error;
      });
    }
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    child.stdin.destroy();
  }
});

test("Windows retirement falls back to PowerShell when taskkill is denied", async () => {
  const commands: string[] = [];
  await killProcessTreeAsync(123, {
    platform: "win32",
    spawnProcess: command => {
      commands.push(command);
      const killer = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { return true; },
      }) as unknown as ChildProcess;
      queueMicrotask(() => killer.emit("exit", command === "taskkill.exe" ? 1 : 0, null));
      return killer;
    },
  });
  assert.deepEqual(commands, ["taskkill.exe", "powershell.exe"]);
});

test("Windows retirement waits for its mocked process-tree command to finish", async () => {
  const killer = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { return true; },
  }) as unknown as ChildProcess;
  const retirement = killProcessTreeAsync(123, {
    platform: "win32",
    spawnProcess: () => killer,
  });
  let finished = false;
  void retirement.then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  killer.emit("exit", 0, null);
  await retirement;
  assert.equal(finished, true);
});

test("Windows retirement rejects only after every tree-kill command fails", async () => {
  const commands: string[] = [];
  const retirement = killProcessTreeAsync(123, {
    platform: "win32",
    spawnProcess: command => {
      commands.push(command);
      const killer = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { return true; },
      }) as unknown as ChildProcess;
      queueMicrotask(() => killer.emit("exit", 5, null));
      return killer;
    },
  });
  await assert.rejects(retirement, /process tree 123/u);
  assert.deepEqual(commands, ["taskkill.exe", "powershell.exe"]);
});

test("Windows spawn descriptors preserve spaces, shell metacharacters, quotes, and trailing slashes", {
  skip: process.platform !== "win32",
}, () => {
  const expected = [
    "hooks.PreToolUse=[{matcher='^apply_patch$',hooks=[{type='command',command='wb __hook apply-patch-claim'}]}]",
    'quoted "value"',
    "trailing\\",
  ];
  const descriptor = getSpawnDescriptor({
    args: ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...expected],
    command: process.execPath,
  });
  const result = spawnSync(descriptor.command, descriptor.args, {
    ...createSpawnOptions(process.cwd(), process.env, true),
    encoding: "utf8",
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), expected);
});
