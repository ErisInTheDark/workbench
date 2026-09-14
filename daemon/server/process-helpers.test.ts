/* No production exports. Tests protect process argument transport and retirement failure propagation. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

import { createSpawnOptions, getSpawnDescriptor, killProcessTreeAsync } from "./process-helpers";

test("sandbox process-tree retirement closes an owned child and its descendant", {
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

test("Windows retirement rejects failed termination instead of declaring the child gone", async () => {
  const killer = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { return true; },
  }) as unknown as ChildProcess;
  let spawned = false;
  const retirement = killProcessTreeAsync(123, {
    platform: "win32",
    spawnProcess: () => { spawned = true; queueMicrotask(() => killer.emit("exit", 5, null)); return killer; },
  });
  const failure = assert.rejects(retirement, /termination.*5/iu);
  assert.equal(spawned, true, "Retirement must use the injected owner process port");
  await failure;
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
