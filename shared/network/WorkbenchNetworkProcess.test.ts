/* No production exports. Protect artifact integrity, pipe response validation and pending-work disposal. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import WorkbenchNetworkProcess from "./WorkbenchNetworkProcess.ts";

async function fixture(context: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wb-network-process-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "shared/network/native");
  const platform = process.platform === "win32" ? "windows-x64" : "linux-x64";
  const name = process.platform === "win32" ? "workbench-network.exe" : "workbench-network";
  const binary = path.join(source, "bin", platform, name);
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(path.join(source, "main.go"), "package main\n");
  await writeFile(path.join(source, "go.mod"), "module example.test/network\n");
  await writeFile(path.join(source, "go.sum"), "");
  const bytes = Buffer.from("test-owned executable substitute");
  await writeFile(binary, bytes);
  const manifest = {
    protocol: 1,
    artifacts: {
      [platform]: {
        file: `${platform}/${name}`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sourceHash: await WorkbenchNetworkProcess.sourceHash(source),
      },
    },
  };
  await writeFile(path.join(source, "bin/manifest.json"), JSON.stringify(manifest));
  return { root, source, binary };
}

test("refuses altered binaries and stale production sources while ignoring test-only changes", async context => {
  const { root, source, binary } = await fixture(context);
  assert.equal(await WorkbenchNetworkProcess.inspect(root), binary);
  await writeFile(path.join(source, "main_test.go"), "package main\n");
  assert.equal(await WorkbenchNetworkProcess.inspect(root), binary);
  await writeFile(path.join(source, "main.go"), "package main\nfunc main() {}\n");
  await assert.rejects(WorkbenchNetworkProcess.inspect(root));
  await writeFile(path.join(source, "main.go"), "package main\r\n");
  assert.equal(await WorkbenchNetworkProcess.inspect(root), binary);
  await writeFile(binary, "altered");
  await assert.rejects(WorkbenchNetworkProcess.inspect(root));
});

test("parent close rejects a pending operation and waits for child EOF shutdown", async context => {
  const { root } = await fixture(context);
  const lifecycle = { spawned: false, closed: false };
  let entered!: () => void;
  const received = new Promise<void>(resolve => { entered = resolve; });
  const status = {
    event: "status",
    snapshot: {
      hostServe: { phase: "off", message: null, url: null },
      privateAccess: {
        phase: "off", message: null, url: null, hostname: null, loginUrl: null, nodeId: null, addresses: [],
        rootCertificate: null, rootFingerprint: null, certificateExpiresAt: null, pending: [],
      },
    },
  };
  const owner = new WorkbenchNetworkProcess({
    root, stateDirectory: path.join(root, "private"), status: () => entered(), warn: assert.fail,
    spawnChild: (_executable, _args, options) => {
      lifecycle.spawned = true;
      const child = spawn(process.execPath, ["-e",
        `let id; process.stdin.once('data',data=>{id=JSON.parse(data).id;process.stdout.write(${JSON.stringify(JSON.stringify(status) + "\n")});}); process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({id,error:'cancelled'})+'\\n',()=>process.exit(0));});`,
      ], { ...options, stdio: "pipe" });
      child.once("close", () => { lifecycle.closed = true; });
      return child;
    },
  });
  await owner.start();
  assert.equal(lifecycle.spawned, true);
  const pending = owner.request({ action: "pair-code" });
  const rejected = assert.rejects(pending);
  await received;
  await owner.close();
  await rejected;
  assert.equal(lifecycle.closed, true);
});

test("rejects invalid subprocess responses without exposing payload content", async context => {
  const { root } = await fixture(context);
  const warnings: string[] = [];
  const failures: string[] = [];
  const owner = new WorkbenchNetworkProcess({
    root, stateDirectory: path.join(root, "private"), status: () => assert.fail("Invalid output must not publish status."), warn: message => warnings.push(message),
    failed: message => failures.push(message),
    spawnChild: (_executable, _args, options) => spawn(process.execPath, ["-e",
      "process.stdin.once('data',()=>process.stdout.write(JSON.stringify({secret:'PRIVATE'})+'\\n'));",
    ], { ...options, stdio: "pipe" }),
  });
  await owner.start();
  await assert.rejects(owner.request({ action: "pair-code" }));
  await owner.close();
  assert.ok(warnings.length > 0);
  assert.ok(warnings.every(message => !message.includes("PRIVATE")));
  assert.equal(failures.length, 1);
  assert.ok(!failures[0]!.includes("PRIVATE"));
});

test("stderr diagnostics are sanitised without turning a successful operation into a failure", async context => {
  const { root } = await fixture(context);
  const diagnostics: string[] = [];
  const warnings: string[] = [];
  const owner = new WorkbenchNetworkProcess({
    root, stateDirectory: path.join(root, "private"), status: () => assert.fail("Unexpected status"),
    warn: message => warnings.push(message), diagnostic: message => diagnostics.push(message), failed: assert.fail,
    spawnChild: (_executable, _args, options) => spawn(process.execPath, ["-e",
      "process.stdin.on('data',data=>{const r=JSON.parse(data);process.stderr.write('PRIVATE');process.stdout.write(JSON.stringify({id:r.id,result:{kind:'ok'}})+'\\n');});",
    ], { ...options, stdio: "pipe" }),
  });
  assert.deepEqual(await owner.request({ action: "pair-code" }), { kind: "ok" });
  await owner.close();
  assert.equal(warnings.length, 0);
  assert.ok(diagnostics.length > 0);
  assert.ok(diagnostics.every(message => !message.includes("PRIVATE")));
});

for (const event of ["persist-member", "persist-network"] as const) test(`${event} is acknowledged only after parent persistence without blocking the awaiting action`, async context => {
  const { root } = await fixture(context);
  let persisted = false;
  let rejectPersistence = true;
  let spawned = 0;
  const warnings: string[] = [];
  const member = { nodeId: "node", label: "desk", keyFingerprint: "a".repeat(64), addresses: ["100.64.1.2"] };
  const configuration = { hostServe: { enabled: false, port: 8080 }, privateAccess: null, members: [member] };
  const owner = new WorkbenchNetworkProcess({
    root, stateDirectory: path.join(root, "private"), status: () => assert.fail("Unexpected status"), warn: message => warnings.push(message),
    persistMember: (previous, next) => {
      assert.equal(previous, null);
      assert.deepEqual(next, member);
      if (rejectPersistence) throw new Error("PRIVATE persistence detail");
      persisted = true;
    },
    persistNetwork: (previous, next) => {
      assert.equal(previous, null);
      assert.deepEqual(next, configuration);
      if (rejectPersistence) throw new Error("PRIVATE persistence detail");
      persisted = true;
    },
    spawnChild: (_executable, _args, options) => {
      spawned++;
      return spawn(process.execPath, ["-e", `
      const lines = require("node:readline").createInterface({input:process.stdin});
      const respond = value => process.stdout.write(JSON.stringify(value)+"\\n");
      let action;
      lines.on("line", line => {
        const request = JSON.parse(line);
        if(request.action === "${event}-result") {
          respond({id: request.id, result: {kind:"ok"}});
          respond(request.payload.accepted ? {id: action,result:{kind:"ok"}} : {id:action,error:"persistence declined"});
        } else {
          action = request.id;
          respond(${JSON.stringify(event === "persist-member"
            ? { event, id: "persist-1", previous: null, member }
            : { event, id: "persist-1", previousRevision: null, configuration })});
        }
      });
    `], { ...options, stdio: "pipe" });
    },
  });
  try {
    await assert.rejects(owner.request({ action: "pair-code" }), /persistence declined/);
    assert.equal(persisted, false);
    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0]!.includes("PRIVATE"));
    rejectPersistence = false;
    assert.deepEqual(await owner.request({ action: "pair-code" }), { kind: "ok" });
    assert.equal(persisted, true);
    assert.equal(spawned, 1, "persistence failure must not kill the protocol owner");
  } finally { await owner.close(); }
});

test("network cancellation settles pending work without poisoning later responses or replacing its child", async context => {
  const { root } = await fixture(context);
  let spawned = 0;
  let closed = false;
  const owner = new WorkbenchNetworkProcess({
    root, stateDirectory: path.join(root, "private"), status: () => assert.fail("Unexpected status"), warn: assert.fail,
    spawnChild: (_executable, _args, options) => {
      spawned++;
      const child = spawn(process.execPath, ["-e", `
        const lines = require("node:readline").createInterface({input:process.stdin});
        const held = new Set();
        const respond = value => process.stdout.write(JSON.stringify(value)+"\\n");
        lines.on("line", line => {
          const request = JSON.parse(line);
          if(request.action === "cancel") {
            if(held.delete(request.payload.id)) respond({id:request.payload.id,error:"cancelled"});
            respond({id:request.id,result:{kind:"ok"}});
          } else if(request.action === "pair-code") held.add(request.id);
          else respond({id:request.id,result:{kind:"ok"}});
        });
      `], { ...options, stdio: "pipe" });
      child.once("close", () => { closed = true; });
      return child;
    },
  });
  context.after(() => owner.close());
  const first = owner.request({ action: "pair-code" });
  const rejected = assert.rejects(first);
  assert.deepEqual(await owner.request({ action: "retry" }), { kind: "ok" });
  await owner.cancelPending();
  await rejected;
  const burst = await Promise.all(Array.from({ length: 32 }, () => owner.request({ action: "retry" })));
  assert.ok(burst.every(result => result.kind === "ok"));
  assert.equal(spawned, 1);
  await owner.close();
  assert.equal(closed, true);
});

test("the bundled Windows sidecar accepts disabled configuration and exits on parent EOF without live setup", async context => {
  if (process.platform !== "win32" || process.arch !== "x64") {
    context.skip("The committed artifact is Windows x64; Linux is built and verified on Linux.");
    return;
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const directory = await mkdtemp(path.join(os.tmpdir(), "wb-network-disabled-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let statusCount = 0;
  const owner = new WorkbenchNetworkProcess({
    root, stateDirectory: directory,
    status: snapshot => {
      statusCount++;
      assert.equal(snapshot.hostServe.phase, "off");
      assert.equal(snapshot.privateAccess.phase, "off");
      assert.deepEqual(snapshot.privateAccess.addresses, []);
    },
    warn: message => assert.fail(message),
  });
  try {
    assert.deepEqual(await owner.request({
      action: "configure", configuration: { hostServe: { enabled: false, port: 8080 }, privateAccess: null, members: [] },
      appOrigin: "http://127.0.0.1:4200", daemonOrigin: "http://127.0.0.1:4500", daemonPort: 4500, preparing: false,
    }), { kind: "ok" });
    assert.equal(statusCount, 1);
  } finally { await owner.close(); }
});
