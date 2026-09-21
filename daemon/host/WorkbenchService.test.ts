/* No production exports. Protect cold identity, private control, app detachment and durable service reopening. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import WorkbenchService from "./WorkbenchService.ts";
import WorkbenchServiceClient from "../../shared/process/WorkbenchServiceClient.ts";
import { WorkbenchDaemonIdentitySchema } from "../../shared/http/workbench-daemon-discovery.ts";
import WorkbenchProcessLease from "../../shared/process/WorkbenchProcessLease.ts";

const exec = promisify(execFile);

test("foreground owner loss during host startup releases a late singleton lease", async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wb-service-start-close-"));
  const dataRoot = path.join(root, "data");
  const service = new WorkbenchService({
    root, dataRoot, session: "cancelled-start",
    warn: message => assert.fail(message), restart: () => assert.fail("Cancelled startup cannot restart."),
  });
  context.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const starting = service.start();
  const rejected = assert.rejects(starting);
  await service.close();
  await rejected;
  const lease = await WorkbenchProcessLease.acquire(path.join(dataRoot, "service", "process-lease.sqlite3"));
  assert.ok(lease);
  await lease.dispose();
});

test("cold service reads and app detach preserve durable identity without waking a daemon", async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wb-service-cold-"));
  const dataRoot = path.join(root, "data");
  const warnings: string[] = [];
  const services: WorkbenchService[] = [];
  const clients: WorkbenchServiceClient[] = [];
  let stopped!: () => void;
  const shutdownRequested = new Promise<void>(resolve => { stopped = resolve; });
  context.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    await Promise.all(services.map(service => service.close()));
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, "README.md"), "isolated host\n");
  for (const args of [
    ["init", "-q"], ["config", "user.email", "fixture@example.invalid"],
    ["config", "user.name", "Fixture"], ["add", "README.md"], ["commit", "-qm", "fixture"],
  ]) await exec("git", args, { cwd: root });
  const create = async () => {
    const service = new WorkbenchService({
      root, dataRoot, session: "cold-fixture",
      warn: message => warnings.push(message),
      restart: () => assert.fail("Cold reads must not request a restart."),
      stop: () => stopped(),
    });
    services.push(service);
    return { service, endpoint: await service.start() };
  };
  const first = await create();
  const identity = first.service.identity();
  assert.equal(identity.state, "sleeping");
  assert.equal((await fetch(`${first.endpoint.origin}/healthz`)).status, 403);
  const metadata = WorkbenchDaemonIdentitySchema.parse(await (await fetch(`${first.endpoint.origin}/_workbench-service/identity`)).json());
  assert.equal(metadata.daemonId, identity.daemonId);
  assert.equal(metadata.state, "sleeping");
  const forged = await fetch(`${first.endpoint.origin}/_workbench-service/identity`, {
    headers: { "x-workbench-network-device": "forged", "x-workbench-network-token": "0".repeat(64) },
  });
  assert.equal(forged.status, 403);
  const client = new WorkbenchServiceClient({
    endpointPath: path.join(dataRoot, "service", "runtime.json"),
    warn: message => warnings.push(message),
  });
  clients.push(client);
  await client.start();
  await client.request({
    method: "service/app/register",
    registration: {
      appOrigin: "http://127.0.0.1:32123", ingressToken: "a".repeat(64),
      previewOrigin: null, previewHostPort: null, retainedHostPort: null, privateAppAllowed: true,
    },
  });
  await client.request({ method: "service/status/read" });
  assert.equal(client.getSnapshot().snapshot?.identity.state, "sleeping");
  const processInfo = await client.request({ method: "service/process/read" });
  assert.equal(processInfo.kind, "process");
  if (processInfo.kind !== "process") assert.fail("Missing process information.");
  assert.equal(processInfo.instanceId, first.endpoint.instanceId);
  await assert.rejects(client.request({
    method: "service/stop", instanceId: "00000000-0000-4000-8000-000000000000",
  }), /replaced/u);
  assert.equal(warnings.length, 1);
  warnings.length = 0;
  let sawPending = false;
  let finishReload!: () => void;
  const reloaded = new Promise<void>(resolve => { finishReload = resolve; });
  const unsubscribe = client.subscribe(() => {
    const dirt = client.getSnapshot().snapshot?.reloadDirt;
    if (dirt?.pendingScopes.length) sawPending = true;
    if (sawPending && dirt?.pendingScopes.length === 0) finishReload();
  });
  await client.request({ method: "service/reload", scopes: ["host:database"] });
  await reloaded;
  unsubscribe();
  assert.equal(client.getSnapshot().snapshot?.reloadDirt?.error, null);
  assert.equal(client.getSnapshot().snapshot?.identity.daemonId, identity.daemonId);
  assert.equal(client.getSnapshot().snapshot?.identity.state, "sleeping");
  await client.request({ method: "service/daemon/stop", instanceId: first.endpoint.instanceId });
  assert.equal(first.service.identity().state, "sleeping");
  await client.request({ method: "service/stop", instanceId: first.endpoint.instanceId });
  await shutdownRequested;
  await client.close();
  assert.equal((await fetch(`${first.endpoint.origin}/_workbench-service/identity`)).status, 200);
  await first.service.close();
  const next = await create();
  assert.equal(next.service.identity().daemonId, identity.daemonId);
  assert.notEqual(next.endpoint.instanceId, first.endpoint.instanceId);
  assert.equal(next.service.identity().state, "sleeping");
  assert.deepEqual(warnings, []);
});
