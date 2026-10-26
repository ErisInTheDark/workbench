/* No production exports. Tests protect that a stopped approved command answers once its own process is retired. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";

import executeApprovedCommand from "./WorkbenchApprovedCommandExecutor";

test("a stopped approved command settles while an escaped descendant still holds its output", async t => {
  // The holder escapes the tree kill: its parent exits first and it runs detached, yet it inherits the command's
  // output pipes. Its private HTTP close route is test cleanup; its own deadline bounds a broken run.
  const holder = `
    const http = require("node:http");
    const server = http.createServer((_request, response) => { response.end(); process.exit(0); });
    server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ pid: process.pid, port: server.address().port })));
    setTimeout(() => process.exit(0), 15_000);
  `;
  const intermediate = `
    require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(holder)}], {
      detached: true, stdio: ["ignore", "inherit", "inherit"], windowsHide: true,
    }).unref();
  `;
  const root = `
    require("node:child_process").spawnSync(process.execPath, ["-e", ${JSON.stringify(intermediate)}], {
      stdio: ["ignore", "inherit", "inherit"], windowsHide: true,
    });
    setInterval(() => {}, 1_000);
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
  const running = executeApprovedCommand({
    caller: { cwd: process.cwd(), harness: "test", threadId: WorkbenchThreadIdSchema.parse(randomUUID()) },
    command: [process.execPath, "-e", root],
    cwd: process.cwd(),
    permissions: { mode: "approved-unrestricted" },
  }, stop.signal, process.env, (_stream, chunk) => {
    output += chunk.toString("utf8");
    const line = /^\{.*\}$/mu.exec(output)?.[0];
    if (!line || holderAddress) return;
    holderAddress = JSON.parse(line) as { pid: number; port: number };
    stop.abort(reason);
  });

  await assert.rejects(running, reason);
  assert.ok(holderAddress, "the holder reported itself before the stop");
  assert.doesNotThrow(() => process.kill(holderAddress!.pid, 0), "the command answered without waiting for the holder");
});
