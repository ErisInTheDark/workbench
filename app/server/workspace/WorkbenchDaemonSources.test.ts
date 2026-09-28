/* No production exports. Protect app-host grants, source retention and conflicting publication fencing. */
import assert from "node:assert/strict";
import test from "node:test";
import { DaemonIdSchema } from "workbench-shared/workbench/identity";
import type WorkbenchNetworkController from "../network/WorkbenchNetworkController";
import WorkbenchDaemonSources from "./WorkbenchDaemonSources";

const daemonId = DaemonIdSchema.parse("00000000-0000-4000-8000-000000000001");
const identity = { protocol: 1 as const, daemonId, hostname: "peer", state: "sleeping" as const, wakeEnabled: true };
const peer = { peerId: "peer-node", hostname: "peer", phase: "verified" as const, identity,
  origin: "http://100.80.0.2:52739",
  endpoints: { httpOrigin: "http://100.80.0.2:52739", secureOrigin: null } };

test("the app host's grant admits a sleeping peer without waking it and revocation withdraws it", context => {
  let allowed: boolean | null = true;
  let facts: ReturnType<WorkbenchNetworkController["daemonSources"]> = {
    current: true, attached: null, localOrigin: null, discovery: { refreshing: false, peers: [peer] },
  };
  let changed = () => {};
  const sources = new WorkbenchDaemonSources({
    network: { daemonSources: () => facts, canAccessPeer: () => allowed,
      subscribe: listener => { changed = listener; return () => {}; } },
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
      canAccessPeer: () => true, subscribe: () => () => {},
    },
    warn: message => warnings.push(message),
  });
  context.after(() => sources.dispose());
  sources.start();
  assert.equal(sources.get(daemonId)?.getSnapshot().connection, "failed");
  assert.equal(sources.get(daemonId)?.available, false);
  assert.equal(warnings.length, 1);
});
