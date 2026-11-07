/* No production exports. Protect the private-DNS verdict: outage now, one outage away, stale entries and healthy coverage. */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchNetworkSnapshot } from "workbench-shared/http/workbench-network";
import { networkDnsCoverage } from "./network-dns-coverage.ts";

const fingerprint = "a".repeat(64);
function snapshot(nameservers: Array<{ address: string; online: boolean | null }> | undefined): WorkbenchNetworkSnapshot {
  return {
    configuration: {
      hostServe: { enabled: true, port: 8080 }, privateAccess: { role: "authority", enabled: true, label: "noisybox" },
      members: [
        { nodeId: "noisybox", label: "noisybox", keyFingerprint: fingerprint, addresses: ["100.64.0.1"] },
        { nodeId: "floof", label: "tower-of-floof", keyFingerprint: fingerprint, addresses: ["100.64.0.2"] },
        { nodeId: "floof-2", hostNodeId: "floof", label: "floof-two", keyFingerprint: fingerprint, addresses: ["100.64.0.3"] },
        { nodeId: "hidden", label: "hidden", keyFingerprint: fingerprint, addresses: ["100.64.0.4"], published: false },
      ],
      group: { id: "67e323d5-949a-4c41-956f-1fa28905f034", revision: 1, ownerNodeId: "noisybox", dnsNodeId: "floof", access: "all", grants: [] },
    },
    runtime: { hostServe: { phase: "ready", message: null, url: null }, privateAccess: {
      phase: "ready", nodeId: "noisybox", hostname: "noisybox.wb.inthedark.boo", message: null, url: null, loginUrl: null,
      keyFingerprint: null, addresses: [], rootCertificate: null, rootFingerprint: null, certificateExpiresAt: null, pending: [],
      ...(nameservers ? { tailnetDns: { nameservers } } : {}),
    } },
    executable: { available: true, message: null }, hostPlatform: "linux", busy: false, failure: null,
  };
}

test("no route data yet makes no claim", () => {
  assert.equal(networkDnsCoverage(snapshot(undefined)), null);
});

test("only offline or missing nameservers mean private names fail now", () => {
  const offline = networkDnsCoverage(snapshot([{ address: "100.64.0.2", online: false }]))!;
  assert.equal(offline.verdict, "broken");
  assert.deepEqual(offline.offline, ["100.64.0.2"]);
  assert.deepEqual(offline.members.map(member => [member.label, member.listed]),
    [["noisybox", false], ["tower-of-floof", true], ["floof-two", false]], "unpublished members are not offered");
  assert.equal(networkDnsCoverage(snapshot([]))!.verdict, "broken");
  assert.equal(networkDnsCoverage(snapshot([{ address: "100.64.9.9", online: null }]))!.verdict, "broken",
    "an address no member owns cannot answer private names");
});

test("one reachable computer, even with two of its apps listed, is one outage away", () => {
  const coverage = networkDnsCoverage(snapshot([{ address: "100.64.0.2", online: true }, { address: "100.64.0.3", online: true }]))!;
  assert.equal(coverage.verdict, "fragile");
  assert.match(coverage.problem ?? "", /only one/u);
});

test("two reachable computers stay fragile while an offline or stale entry is listed, then turn healthy", () => {
  const live = [{ address: "100.64.0.1", online: true }, { address: "100.64.0.2", online: true }];
  assert.equal(networkDnsCoverage(snapshot([...live, { address: "100.64.0.3", online: false }]))!.verdict, "fragile");
  const stale = networkDnsCoverage(snapshot([...live, { address: "100.64.9.9", online: null }]))!;
  assert.equal(stale.verdict, "fragile");
  assert.deepEqual(stale.unknown, ["100.64.9.9"]);
  const healthy = networkDnsCoverage(snapshot(live))!;
  assert.equal(healthy.verdict, "healthy");
  assert.equal(healthy.problem, null);
});
