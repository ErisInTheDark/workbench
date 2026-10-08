/*
 * No exports. Protect reload ordering, admission exclusivity and update failure/repair boundaries.
 */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchAppReloadOrchestrator, { type WorkbenchAppReloadOrchestratorPorts } from "./WorkbenchAppReloadOrchestrator";
import type { WorkbenchReloadDirtSnapshot } from "workbench-shared/reload/workbench-reload";
import { DaemonIdSchema } from "workbench-shared/workbench/identity";

function dirt(...scopes: string[]): WorkbenchReloadDirtSnapshot {
  return { dirtyScopes: scopes.map(scope => ({ scope, destructive: false, description: scope })),
    pendingScopes: [], error: null };
}

function harness(overrides: Partial<WorkbenchAppReloadOrchestratorPorts> = {}) {
  const events: string[] = [];
  const ports: WorkbenchAppReloadOrchestratorPorts = {
    readAppDirt: () => dirt("host:network", "client:http"),
    readDaemonDirt: async () => dirt("server:workspace"),
    isLocalDaemon: () => true,
    readControlDaemon: () => ({ dirt: null, update: null }),
    pullDaemon: async () => ({ fromSha: "a".repeat(40), toSha: "b".repeat(40), lockfileChanged: false }),
    refreshAppDirt: async () => { events.push("refresh"); },
    reloadDaemon: async scopes => { events.push(`daemon:${scopes.join(",")}`); },
    reloadHost: async scopes => { events.push(`host:${scopes.join(",")}`); },
    admitClient: scopes => ({
      response: { ok: true, state: "running", requestedScopes: scopes, queuedScopes: scopes,
        appliedScopes: [], startedAt: 1, completedAt: null, error: null },
      cancel: () => {},
      start: async () => { events.push(`client:${scopes.join(",")}`); },
    }),
    warn: message => { events.push(`warning:${message}`); },
    ...overrides,
  };
  return { owner: new WorkbenchAppReloadOrchestrator(ports), events, ports };
}

test("reload all completes daemon, host and client in order", async () => {
  const daemonEntered = Promise.withResolvers<void>();
  const hostEntered = Promise.withResolvers<void>();
  const daemonCompletion = Promise.withResolvers<void>();
  const hostCompletion = Promise.withResolvers<void>();
  let daemonDone = false;
  let hostDone = false;
  const { owner, events, ports } = harness();
  ports.reloadDaemon = async scopes => {
    events.push(`daemon:${scopes.join(",")}`);
    daemonEntered.resolve();
    await daemonCompletion.promise;
    daemonDone = true;
  };
  ports.reloadHost = async scopes => {
    events.push(`host:${scopes.join(",")}`);
    hostEntered.resolve();
    assert.equal(daemonDone, true);
    await hostCompletion.promise;
    hostDone = true;
  };
  const admitClient = ports.admitClient;
  ports.admitClient = scopes => { assert.equal(hostDone, true); return admitClient(scopes); };
  const work = owner.admitReloadAll().start();
  await daemonEntered.promise;
  assert.throws(() => owner.admitPull(undefined, true), /already running/u);
  assert.deepEqual(events, ["daemon:server:workspace"]);
  daemonCompletion.resolve();
  await hostEntered.promise;
  assert.deepEqual(events, ["daemon:server:workspace", "host:host:network"]);
  hostCompletion.resolve();
  await work;
  assert.deepEqual(events, ["daemon:server:workspace", "host:host:network", "client:client:http"]);
  assert.equal(owner.read().phase, "idle");
});

test("process restart is published before client execution and subsumes client nodes", async () => {
  const { owner, ports } = harness({ readAppDirt: () => dirt("client:process", "client:http"),
    readDaemonDirt: async () => null });
  let observed = false;
  ports.admitClient = scopes => ({
    ...harness().ports.admitClient(scopes),
    start: async () => {
      assert.deepEqual(scopes, ["client:process"]);
      assert.equal(owner.read().phase, "restarting");
      observed = true;
    },
  });
  await owner.admitReloadAll().start();
  assert.ok(observed);
  assert.equal(owner.read().phase, "restarting");
  assert.throws(() => owner.admitReloadAll(), /already running/u);
});

test("admission reserves the operation before start and cancellation releases it", async () => {
  const { owner } = harness();
  const admission = owner.admitReloadAll();
  assert.throws(() => owner.admitPull(undefined, true), /already running/u);
  admission.cancel();
  await owner.admitPull(undefined, false).start();
  assert.equal(owner.read().phase, "idle");
});

test("pull failure persists and prevents refresh or reload; a later request clears it", async () => {
  const { owner, events, ports } = harness({ pullDaemon: async () => { throw new Error("pull rejected"); } });
  await owner.admitPull(undefined, true).start();
  assert.equal(owner.read().phase, "failed");
  assert.equal(owner.read().error, "pull rejected");
  assert.equal(events.length, 1);
  ports.pullDaemon = async () => ({ fromSha: "a".repeat(40), toSha: "b".repeat(40), lockfileChanged: false });
  const next = owner.admitPull(undefined, false);
  assert.equal(owner.read().error, null);
  await next.start();
  assert.equal(owner.read().phase, "idle");
});

test("lockfile pull refreshes then installs exclusively with the pre-pull commit", async () => {
  const { owner, events, ports } = harness({
    pullDaemon: async () => ({ fromSha: "a".repeat(40), toSha: "b".repeat(40), lockfileChanged: true }),
  });
  ports.admitClient = (scopes, options) => {
    assert.deepEqual(scopes, ["client:install"]);
    assert.deepEqual(options, { installFromSha: "a".repeat(40) });
    return harness().ports.admitClient(scopes);
  };
  await owner.admitPull(undefined, true).start();
  assert.deepEqual(events, ["refresh"]);
  assert.equal(owner.read().phase, "restarting");
});

test("empty dirt succeeds without a reload admission", async () => {
  const { owner, events } = harness({ readAppDirt: () => dirt(), readDaemonDirt: async () => null });
  await owner.admitReloadAll().start();
  assert.deepEqual(events, []);
  assert.equal(owner.read().phase, "idle");
});

test("daemon failure stops later owners and survives an orchestrator handoff", async () => {
  const { owner, events, ports } = harness({ reloadDaemon: async () => { throw new Error("daemon rejected"); } });
  const transferred = new WorkbenchAppReloadOrchestrator(ports, owner.detachForReload());
  let updates = 0;
  transferred.subscribe(() => { updates++; });
  await owner.admitReloadAll().start();
  assert.equal(transferred.read().phase, "failed");
  assert.ok(updates > 0);
  assert.equal(events.length, 1);
});

test("remote update targets are rejected before reserving or pulling", async () => {
  const { owner, events } = harness({ isLocalDaemon: () => false });
  const remote = DaemonIdSchema.parse("67e323d5-949a-4c41-956f-1fa28905f034");
  assert.throws(() => owner.admitPull(remote, true), /only to this device/u);
  assert.equal(owner.read().phase, "idle");
  assert.deepEqual(events, []);
  await owner.admitReloadAll(remote).start();
  assert.equal(owner.read().phase, "idle");
});

test("owner retirement cancels an active wait without advancing to reload", async () => {
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const { owner, events } = harness({
    readDaemonDirt: async (_daemonId, signal) => {
      entered();
      await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort",
        () => reject(signal!.reason), { once: true }));
      return null;
    },
  });
  const work = owner.admitReloadAll().start();
  await waiting;
  owner.cancelPending();
  await work;
  assert.equal(owner.read().phase, "failed");
  assert.equal(events.length, 1);
});
