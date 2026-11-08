/* No production exports. Protect the private-DNS verdict, row order and the next computer to add. */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchNetworkSnapshot } from "workbench-shared/http/workbench-network";
import { networkDnsCoverage } from "./network-dns-coverage.ts";

const fingerprint = "a".repeat(64);
const ONLINE: Record<string, boolean> = { "100.64.0.1": true, "100.64.0.2": false, "100.64.0.3": true, "100.64.0.5": true };
function snapshot(nameservers: string[] | undefined): WorkbenchNetworkSnapshot {
  return {
    configuration: {
      hostServe: { enabled: true, port: 8080 }, privateAccess: { role: "authority", enabled: true, label: "noisybox" },
      members: [
        { nodeId: "noisybox", label: "noisybox", keyFingerprint: fingerprint, addresses: ["100.64.0.1"] },
        { nodeId: "floof", label: "tower-of-floof", keyFingerprint: fingerprint, addresses: ["100.64.0.2"] },
        { nodeId: "floof-2", hostNodeId: "noisybox", label: "noisybox-two", keyFingerprint: fingerprint, addresses: ["100.64.0.3"] },
        { nodeId: "binky", label: "binkymachine", keyFingerprint: fingerprint, addresses: ["100.64.0.5"] },
        { nodeId: "hidden", label: "hidden", keyFingerprint: fingerprint, addresses: ["100.64.0.4"], published: false },
      ],
      group: { id: "67e323d5-949a-4c41-956f-1fa28905f034", revision: 1, ownerNodeId: "noisybox", dnsNodeId: "floof", access: "all", grants: [] },
    },
    runtime: { hostServe: { phase: "ready", message: null, url: null }, privateAccess: {
      phase: "ready", nodeId: "noisybox", hostname: "noisybox.wb.inthedark.boo", message: null, url: null, loginUrl: null,
      keyFingerprint: null, addresses: [], rootCertificate: null, rootFingerprint: null, certificateExpiresAt: null, pending: [],
      ...(nameservers ? { tailnetDns: {
        nameservers: nameservers.map(address => ({ address, online: ONLINE[address] ?? null })),
        members: Object.entries(ONLINE).map(([address, online]) => ({ address, online })),
      } } : {}),
    } },
    executable: { available: true, message: null }, hostPlatform: "linux", busy: false, failure: null,
  };
}

test("no route data yet makes no claim", () => {
  assert.equal(networkDnsCoverage(snapshot(undefined)), null);
});

test("only an offline computer listed fails now and suggests an online one", () => {
  const coverage = networkDnsCoverage(snapshot(["100.64.0.2"]))!;
  assert.equal(coverage.verdict, "broken");
  assert.deepEqual(coverage.rows.map(row => [row.label, row.listed, row.online]), [
    ["tower-of-floof", true, false], ["noisybox", false, true], ["noisybox-two", false, true], ["binkymachine", false, true],
  ], "listed first, then unlisted published members with their reachability");
  assert.deepEqual(coverage.suggestion, { label: "noisybox", address: "100.64.0.1" });
  assert.equal(networkDnsCoverage(snapshot([]))!.verdict, "broken");
  assert.equal(networkDnsCoverage(snapshot(["100.64.9.9"]))!.verdict, "broken", "an address no member owns cannot answer");
});

test("a second app on the same computer is not a second nameserver", () => {
  const coverage = networkDnsCoverage(snapshot(["100.64.0.1", "100.64.0.3"]))!;
  assert.equal(coverage.verdict, "fragile");
  assert.deepEqual(coverage.suggestion, { label: "binkymachine", address: "100.64.0.5" });
});

test("two reachable computers stay fragile while an offline or stranger entry is listed, then turn healthy", () => {
  assert.equal(networkDnsCoverage(snapshot(["100.64.0.1", "100.64.0.5", "100.64.0.2"]))!.verdict, "fragile");
  assert.equal(networkDnsCoverage(snapshot(["100.64.0.1", "100.64.0.5", "100.64.9.9"]))!.verdict, "fragile");
  const healthy = networkDnsCoverage(snapshot(["100.64.0.1", "100.64.0.5"]))!;
  assert.equal(healthy.verdict, "healthy");
  assert.equal(healthy.suggestion, null);
});
