/* No exports. Explicit no-model scenario for the real persistent Codex sandbox executor. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import CodexExecServer from "../../daemon/server/CodexExecServer";
import type { CodexExecRequest } from "../../daemon/server/codex-exec-protocol";
import IsolatedWorkbench from "./IsolatedWorkbench";

test("native executor enforces workspace writes and reuses Windows private desktops", async t => {
  const fixture = await IsolatedWorkbench.create(path.resolve(process.cwd(), ".."), t.signal);
  const executor = new CodexExecServer({
    cwd: fixture.project,
    env: { ...process.env, CODEX_HOME: path.join(fixture.root, "codex") },
  });
  try {
    const permissions: CodexExecRequest["permissions"] = {
      type: "managed", network: "restricted",
      file_system: {
        type: "restricted",
        entries: [
          { path: { type: "special", value: { kind: "root" } }, access: "read" },
          { path: { type: "path", path: pathToFileURL(fixture.project).href }, access: "write" },
          { path: { type: "special", value: { kind: "tmpdir" } }, access: "write" },
          { path: { type: "special", value: { kind: "slash_tmp" } }, access: "write" },
        ],
      },
    };
    const execute = (command: string[], profile = permissions) => executor.execute({
      command, cwd: fixture.project, permissions: profile, workspaceRoots: [fixture.project],
      windowsSandboxLevel: process.platform === "win32" ? "elevated" : "disabled",
      windowsSandboxPrivateDesktop: true,
    }, t.signal);
    const allowed = path.join(fixture.project, "allowed.txt");
    const denied = path.join(fixture.root, "denied.txt");
    const write = (file: string) => process.platform === "win32"
      ? ["pwsh", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; [IO.File]::WriteAllText('${file.replaceAll("'", "''")}','proof')`]
      : [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(file)},"proof")`];
    const allowedResult = await execute(write(allowed));
    assert.equal(allowedResult.exitCode, 0, allowedResult.stderr);
    assert.equal(await fs.readFile(allowed, "utf8"), "proof");
    const deniedResult = await execute(write(denied));
    assert.notEqual(deniedResult.exitCode, 0);
    await assert.rejects(fs.stat(denied), { code: "ENOENT" });
    const nodeResult = await execute([process.execPath, "-e", "console.log(require('node:crypto').randomUUID())"]);
    assert.equal(nodeResult.exitCode, 0, nodeResult.stderr);
    assert.match(nodeResult.stdout.trim(), /^[0-9a-f-]{36}$/u);

    const ready = path.join(fixture.project, "child-ready.json");
    const cancel = new AbortController();
    const watchCancel = new AbortController();
    const watcher = fs.watch(fixture.project, { signal: watchCancel.signal });
    const childScript = `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(`${ready}.tmp`)},JSON.stringify({pid:process.pid}));fs.renameSync(${JSON.stringify(`${ready}.tmp`)},${JSON.stringify(ready)});setInterval(()=>{},1000)`;
    const parentScript = `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(childScript)}],{stdio:"inherit"});setInterval(()=>{},1000)`;
    const waiting = executor.execute({
      command: [process.execPath, "-e", parentScript], cwd: fixture.project, permissions,
      workspaceRoots: [fixture.project], windowsSandboxLevel: process.platform === "win32" ? "elevated" : "disabled",
      windowsSandboxPrivateDesktop: true,
    }, cancel.signal);
    const stopped = assert.rejects(waiting, /scenario cancellation/u);
    try {
      await Promise.race([
        (async () => {
          for await (const event of watcher) {
            if (event.filename === path.basename(ready)) return;
          }
          throw new Error("Readiness watcher closed before the child started.");
        })(),
        waiting.then(result => { throw new Error(`Command exited before readiness: ${result.stderr}`); }),
      ]);
      const { pid } = JSON.parse(await fs.readFile(ready, "utf8")) as { pid: number };
      const independent = execute([process.execPath, "-e", "console.log('independent')"]);
      cancel.abort(new Error("scenario cancellation"));
      await stopped;
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "cancelled command must not leave its descendant alive");
      assert.equal((await independent).stdout.trim(), "independent");
    } finally {
      watchCancel.abort();
      cancel.abort(new Error("scenario cancellation"));
      await stopped;
    }

    if (process.platform === "win32") {
      const desktop = [
        "$ErrorActionPreference = 'Stop'",
        `Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DesktopProof {
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint threadId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, int size, out int needed);
  public static string Read() {
    var name = new StringBuilder(1024); int needed;
    if (!GetUserObjectInformation(GetThreadDesktop(GetCurrentThreadId()), 2, name, 2048, out needed)) throw new Exception("desktop lookup failed");
    return name.ToString();
  }
}
'@`,
        "[DesktopProof]::Read()",
      ].join("\n");
      const command = ["pwsh", "-NoProfile", "-NonInteractive", "-Command", desktop];
      const first = await execute(command);
      assert.equal(first.exitCode, 0, first.stderr);
      assert.ok(first.stdout.trim());
      assert.notEqual(first.stdout.trim().toLowerCase(), "default");
      // The first command has closed completely; no active command keeps its desktop alive.
      await fs.readFile(allowed);
      const second = await execute(command);
      assert.equal(second.exitCode, 0, second.stderr);
      assert.equal(second.stdout.trim(), first.stdout.trim());
      const different = await execute(command, { ...permissions, network: "enabled" });
      assert.equal(different.exitCode, 0, different.stderr);
      assert.notEqual(different.stdout.trim(), first.stdout.trim());
    }
  } finally {
    await executor.dispose();
    await fixture.close();
  }
});
