/*
 * No production exports. Protect verified peer deduplication, endpoint choice, and revocation disposal.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkbenchNetworkSnapshot } from "workbench-shared/http/workbench-network";
import { DaemonIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchDaemonSessions from "./WorkbenchDaemonSessions";
import type WorkbenchDaemonSession from "./WorkbenchDaemonSession";

const attached = DaemonIdSchema.parse("4f29787d-5a30-4c4c-9d1f-224913a3468c");
const peer = DaemonIdSchema.parse("502902c0-9512-40be-bb06-c65d86ef2029");

function verified(daemonId: string, peerId: string, secureOrigin: string | null) {
  return {
    peerId, hostname: "laptop", phase: "verified" as const,
    identity: { protocol: 1 as const, daemonId, hostname: "laptop", state: "ready" as const, wakeEnabled: true },
    origin: "http://100.64.1.2:52739",
    endpoints: { httpOrigin: "http://100.64.1.2:52739", secureOrigin },
  };
}

test("only one verified address opens per daemon and revocation disposes its session", async () => {
  let snapshot: Pick<WorkbenchNetworkSnapshot, "daemon" | "discovery"> = {
    daemon: { protocol: 1 as const, daemonId: attached, hostname: "desktop", state: "ready" as const, wakeEnabled: true },
    discovery: { refreshing: false, peers: [
      verified(attached, "self", "https://self.wb.inthedark.boo:52739"),
      verified(peer, "peer", "https://peer.wb.inthedark.boo:52739"),
    ] },
  };
  let notify = () => {};
  const created: Array<{ daemonId: string; resolveUrl: () => Promise<string>; disposed: boolean; starts: number }> = [];
  const sessions = new WorkbenchDaemonSessions({
    network: { snapshot: () => snapshot, subscribe: listener => { notify = listener; return () => {}; } },
    createSession: options => {
      const item = { daemonId: options.daemonId, resolveUrl: options.resolveUrl, disposed: false, starts: 0 };
      created.push(item);
      return {
        start: async () => { item.starts += 1; },
        dispose: () => { item.disposed = true; },
        subscribe: () => () => {},
      } as unknown as WorkbenchDaemonSession;
    },
  });
  try {
    sessions.start();
    assert.equal(created.length, 1);
    assert.equal(created[0]?.daemonId, peer);
    assert.equal(await created[0]?.resolveUrl(), "wss://peer.wb.inthedark.boo:52739/");
    snapshot = { ...snapshot, discovery: { refreshing: false, peers: [
      verified(peer, "peer", "https://peer.wb.inthedark.boo:52739"),
      verified(peer, "duplicate", "https://duplicate.wb.inthedark.boo:52739"),
    ] } };
    notify();
    assert.equal(created[0]?.disposed, true);
    assert.equal(created.length, 1, "conflicting verified owners cannot be chosen arbitrarily");
    snapshot = { ...snapshot, discovery: { refreshing: false, peers: [
      verified(peer, "peer", "https://peer.wb.inthedark.boo:52739"),
    ] } };
    notify();
    assert.equal(created.length, 2);
    snapshot = { ...snapshot, discovery: { refreshing: false, peers: [] } };
    notify();
    assert.equal(created[1]?.disposed, true);
  } finally {
    sessions.dispose();
  }
});
