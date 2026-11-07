/* No production exports. Protect app-host grants, source retention across restarts and conflicting publication fencing. */
import assert from "node:assert/strict";
import test from "node:test";
import { DaemonIdSchema } from "workbench-shared/workbench/identity";
import type WorkbenchNetworkController from "../network/WorkbenchNetworkController";
import WorkbenchDaemonSources, { type KnownDaemon } from "./WorkbenchDaemonSources";

const daemonId = DaemonIdSchema.parse("00000000-0000-4000-8000-000000000001");
const identity = { protocol: 1 as const, daemonId, hostname: "peer", state: "sleeping" as const, wakeEnabled: true };
const peer = { peerId: "peer-node", hostname: "peer", phase: "verified" as const, identity,
  origin: "http://100.80.0.2:52739",
  endpoints: { httpOrigin: "http://100.80.0.2:52739", secureOrigin: null } };
const offline: ReturnType<WorkbenchNetworkController["daemonSources"]> = {
  current: true, attached: null, localOrigin: null, discovery: { refreshing: false, peers: [] },
};

function memory(initial: KnownDaemon[] = []) {
  const rows = [...initial];
  return { rows, read: () => [...rows], remember: (daemon: KnownDaemon) => {
    const kept = rows.filter(row => row.daemonId !== daemon.daemonId && row.peerNodeId !== daemon.peerNodeId);
    rows.splice(0, rows.length, ...kept, daemon);
  } };
}

test("the app host's grant admits a sleeping peer without waking it, authoritative discovery loss withdraws its facts and revocation withdraws access", context => {
  let allowed: boolean | null = true;
  let facts: ReturnType<WorkbenchNetworkController["daemonSources"]> = {
    current: true, attached: null, localOrigin: null, discovery: { refreshing: false, peers: [peer] },
  };
  let changed = () => {};
  const sources = new WorkbenchDaemonSources({
    network: { daemonSources: () => facts, canAccessPeer: () => allowed, memberPeer: () => null,
      subscribe: listener => { changed = listener; return () => {}; } },
    knownDaemons: memory(),
    warn: message => assert.fail(message),
  });
  context.after(() => sources.dispose());
  sources.start();
  const source = sources.get(daemonId);
  assert.ok(source);
  assert.equal(source.getSnapshot().connection, "sleeping");
  assert.equal(source.socket.url, null);
  facts = { ...facts, current: false, discovery: { refreshing: true, peers: [] } };
  allowed = null;
  changed();
  assert.equal(sources.get(daemonId), source, "Missing discovery is not revocation");
  const observation = source.observe({ kind: "runtime" }, () => {});
  assert.equal(observation.getSnapshot().phase, "pending", "Discovery while the host is not ready is not authoritative");
  facts = { ...facts, current: true, discovery: { refreshing: false, peers: [] } };
  changed();
  assert.deepEqual(observation.getSnapshot(), { phase: "unavailable", failure: null, value: null });
  facts = { ...facts, discovery: { refreshing: false, peers: [peer] } };
  allowed = true;
  changed();
  assert.equal(observation.getSnapshot().phase, "pending");
  facts = { ...facts, discovery: { refreshing: false, peers: [] } };
  allowed = false;
  changed();
  assert.equal(source.getSnapshot().connection, "revoked");
  assert.equal(source.available, false);
});

test("conflicting verified endpoints for one daemon fence routing instead of choosing the first", context => {
  const warnings: string[] = [];
  const sources = new WorkbenchDaemonSources({
    network: {
      daemonSources: () => ({ current: true, attached: null, localOrigin: null,
        discovery: { refreshing: false, peers: [peer, { ...peer, peerId: "other-node",
          origin: "http://100.80.0.3:52739",
          endpoints: { httpOrigin: "http://100.80.0.3:52739", secureOrigin: null } }] } }),
      canAccessPeer: () => true, memberPeer: () => null, subscribe: () => () => {},
    },
    knownDaemons: memory(),
    warn: message => warnings.push(message),
  });
  context.after(() => sources.dispose());
  sources.start();
  assert.equal(sources.get(daemonId)?.getSnapshot().connection, "failed");
  assert.equal(sources.get(daemonId)?.available, false);
  assert.equal(warnings.length, 1);
});

test("a verified daemon stays in reach after a restart while it is offline, until its peer loses access", context => {
  const known = memory();
  const first = new WorkbenchDaemonSources({
    network: { daemonSources: () => ({ ...offline, discovery: { refreshing: false, peers: [peer] } }),
      canAccessPeer: () => true, memberPeer: () => null, subscribe: () => () => {} },
    knownDaemons: known, warn: message => assert.fail(message),
  });
  first.start();
  first.dispose();
  assert.deepEqual(known.rows, [{ daemonId, peerNodeId: "peer-node", hostname: "peer" }]);

  let allowed: boolean | null = null;
  let changed = () => {};
  const restarted = new WorkbenchDaemonSources({
    network: { daemonSources: () => offline, canAccessPeer: () => allowed, memberPeer: () => null,
      subscribe: listener => { changed = listener; return () => {}; } },
    knownDaemons: known, warn: message => assert.fail(message),
  });
  context.after(() => restarted.dispose());
  restarted.start();
  assert.equal(restarted.get(daemonId), null, "Unknown access admits nothing");
  allowed = true;
  changed();
  const source = restarted.get(daemonId);
  assert.ok(source);
  assert.notEqual(source.getSnapshot().connection, "revoked");
  assert.equal(source.getSnapshot().hostname, "peer");
  assert.equal(source.available, false);
  allowed = false;
  changed();
  assert.equal(source.getSnapshot().connection, "revoked");
});

test("a networked daemon nobody verified is recognised through an accessible member with its hostname", context => {
  const known = memory();
  let allowed = false;
  const sources = new WorkbenchDaemonSources({
    network: { daemonSources: () => offline, canAccessPeer: peerId => peerId === "peer-node" && allowed,
      memberPeer: label => label === "peer" ? "peer-node" : null, subscribe: () => () => {} },
    knownDaemons: known, warn: message => assert.fail(message),
  });
  context.after(() => sources.dispose());
  sources.start();
  sources.recognise([{ daemonId, hostname: "elsewhere" }]);
  sources.recognise([{ daemonId, hostname: "peer" }]);
  assert.equal(sources.get(daemonId), null, "Unmatched or inaccessible members are not recognised");
  allowed = true;
  sources.recognise([{ daemonId, hostname: "peer" }]);
  assert.notEqual(sources.get(daemonId)?.getSnapshot().connection, "revoked");
  assert.deepEqual(known.rows, [{ daemonId, peerNodeId: "peer-node", hostname: "peer" }]);
});
