/* No production exports. Protect actionable setup stages from incomplete and stale runtime state. */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchNetworkSnapshot } from "workbench-shared/http/workbench-network";
import privateAccessStep from "./private-access-step.ts";

test("an enrolled node still connecting never offers duplicate preparation or network creation", () => {
  const snapshot: WorkbenchNetworkSnapshot = {
    configuration: { hostServe: { enabled: true, port: 8080 }, privateAccess: { role: "unconfigured", enabled: false, label: "desktop" }, members: [] },
    runtime: { hostServe: { phase: "ready", message: null, url: null }, privateAccess: {
      phase: "starting", nodeId: "node", hostname: "desktop.wb.inthedark.boo", message: null, url: null,
      loginUrl: null, keyFingerprint: null, addresses: [], rootCertificate: null, rootFingerprint: null,
      certificateExpiresAt: null, pending: [],
    } },
    executable: { available: true, message: null }, hostPlatform: "win32", busy: false, failure: null,
  };
  assert.equal(privateAccessStep(snapshot, "idle", false), "connecting");
  snapshot.runtime.privateAccess.phase = "setup";
  snapshot.runtime.privateAccess.discovery = "searching";
  assert.equal(privateAccessStep(snapshot, "idle", false), "discovering");
  snapshot.runtime.privateAccess.discovery = "none";
  assert.equal(privateAccessStep(snapshot, "idle", false), "create");
  snapshot.runtime.privateAccess.discovery = "failed";
  assert.equal(privateAccessStep(snapshot, "idle", false), "failed");
  snapshot.runtime.privateAccess.loginUrl = "https://login.tailscale.com/example";
  assert.equal(privateAccessStep(snapshot, "idle", false), "signin");
  snapshot.runtime.privateAccess.loginUrl = null;
  snapshot.runtime.privateAccess.phase = "ready";
  snapshot.runtime.privateAccess.rootCertificate = "trusted-root";
  snapshot.configuration.privateAccess = { role: "authority", enabled: true, label: "desktop" };
  snapshot.configuration.group = {
    id: "67e323d5-949a-4c41-956f-1fa28905f034", revision: 1,
    ownerNodeId: "node", dnsNodeId: "node", access: "all", grants: [],
  };
  snapshot.capabilities = { manageApp: true, manageNetwork: true, trustHost: true };
  assert.equal(privateAccessStep(snapshot, "checking", false), "checking", "do not prescribe setup before the automatic check finishes");
  assert.equal(privateAccessStep(snapshot, "failed", false), "dns");
  assert.equal(privateAccessStep(snapshot, "failed", true), "trust");
  snapshot.capabilities = { manageApp: false, manageNetwork: false, trustHost: false };
  assert.equal(privateAccessStep(snapshot, "failed", false), "trust", "another browsing device needs trust, not repeated network-wide DNS setup");
  snapshot.busy = true;
  assert.equal(privateAccessStep(snapshot, "verified", true), "ready", "an unrelated pending operation must not reset verified setup");
});
