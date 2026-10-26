/* No production exports. Tests protect that a stopped approved command answers promptly and ends what it started. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";

import executeApprovedCommand, { type ApprovedCommandOptions } from "./WorkbenchApprovedCommandExecutor";

/** A command whose `descendant` outlives the process that started it, so no parent link ties it to the command's root. */
function orphaning(descendant: string, detached: boolean) {
  const intermediate = `
    require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {
      detached: ${detached}, stdio: ["ignore", "inherit", "inherit"], windowsHide: true,
    }).unref();
  `;
  return `
    require("node:child_process").spawnSync(process.execPath, ["-e", ${JSON.stringify(intermediate)}], {
      stdio: ["ignore", "inherit", "inherit"], windowsHide: true,
    });
    setInterval(() => {}, 1_000);
  `;
}

function run(command: string, signal: AbortSignal, options: ApprovedCommandOptions) {
  return executeApprovedCommand({
    caller: { cwd: process.cwd(), harness: "test", threadId: WorkbenchThreadIdSchema.parse(randomUUID()) },
    command: [process.execPath, "-e", command],
    cwd: process.cwd(),
    permissions: { mode: "approved-unrestricted" },
  }, signal, options);
}

test("a stopped approved command settles while an escaped descendant still holds its output", async t => {
  // Without a job, the detached holder escapes the tree kill yet inherits the command's output pipes. Its private
  // HTTP close route is test cleanup; its own deadline bounds a broken run.
  const holder = `
    const http = require("node:http");
    const server = http.createServer((_request, response) => { response.end(); process.exit(0); });
    server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ pid: process.pid, port: server.address().port })));
    setTimeout(() => process.exit(0), 15_000);
  `;
  const stop = new AbortController();
  const reason = new Error("The user stopped this command.");
  let output = "";
  let holderAddress: { pid: number; port: number } | undefined;
  t.after(async () => {
    if (!holderAddress) return;
    await fetch(`http://127.0.0.1:${holderAddress.port}/close`, { method: "POST" }).catch(error => {
      if (error.cause?.code !== "ECONNREFUSED" && error.cause?.code !== "ECONNRESET") throw error;
    });
  });
  const running = run(orphaning(holder, true), stop.signal, {
    onOutput: (_stream, chunk) => {
      output += chunk.toString("utf8");
      const line = /^\{.*\}$/mu.exec(output)?.[0];
      if (!line || holderAddress) return;
      holderAddress = JSON.parse(line) as { pid: number; port: number };
      stop.abort(reason);
    },
  });

  await assert.rejects(running, reason);
  assert.ok(holderAddress, "the holder reported itself before the stop");
  assert.doesNotThrow(() => process.kill(holderAddress!.pid, 0), "the command answered without waiting for the holder");
});

test("a stopped approved command ends a descendant that outlived its parent", async t => {
  // The orphan holds a socket to this test, which closes only once the orphan has died; closing it is also cleanup.
  // Windows Node ends a parent's undetached children with it, so only a detached orphan survives there; on Unix,
  // detaching would deliberately leave the command's process group.
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as net.AddressInfo;
  const orphan = `
    const socket = require("node:net").connect(${port}, "127.0.0.1");
    socket.on("close", () => process.exit(0));
    socket.on("error", () => process.exit(0));
  `;
  const connected = once(server, "connection") as Promise<[net.Socket]>;
  const stop = new AbortController();
  const reason = new Error("The user stopped this command.");
  const runner = path.resolve(import.meta.dirname, "../../host/bin/windows-x64/workbench-daemon-host.exe");
  const windows = process.platform === "win32";
  const running = run(orphaning(orphan, windows), stop.signal, windows ? { windowsJobRunner: async () => runner } : {});
  const [socket] = await connected;
  t.after(() => { socket.destroy(); server.close(); });
  // A killed orphan resets its connection, so its close may follow an error.
  socket.on("error", () => {});
  const orphanGone = new Promise(resolve => socket.once("close", resolve));

  stop.abort(reason);
  await assert.rejects(running, reason);
  await orphanGone;
});
