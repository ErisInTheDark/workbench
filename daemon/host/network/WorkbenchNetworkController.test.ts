/* No production exports. Protect publication of the private daemon listener's actual port. */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchNetworkRuntime } from "../../../shared/http/workbench-network.ts";
import WorkbenchNetworkController from "./WorkbenchNetworkController.ts";

test("browser descriptor uses the private daemon listener, not the discovery port", async () => {
  let owner!: WorkbenchNetworkController;
  const ownerRuntime: WorkbenchNetworkRuntime = {
    hostServe: { phase: "off", message: null, url: null },
    daemonServe: { phase: "ready", message: null, url: "http://100.64.1.2:52739" },
    privateAccess: {
      phase: "ready", message: null, url: "https://peer.wb.inthedark.boo",
      daemonUrl: "https://peer.wb.inthedark.boo:32123",
      hostname: "peer.wb.inthedark.boo", loginUrl: null, nodeId: "node",
      keyFingerprint: null, addresses: ["100.64.1.2"], rootCertificate: null,
      rootFingerprint: null, certificateExpiresAt: null, pending: [],
    },
  };
  owner = new WorkbenchNetworkController({
    repository: {
      read: () => ({ mode: "tailnet-service", hostServe: { enabled: true, port: 8080 },
        privateAccess: { role: "authority", enabled: true, label: "peer" }, members: [] }),
      write: () => {},
    },
    root: ".", stateDirectory: ".", target: () => ({
      appOrigin: "http://127.0.0.1:8080", daemonOrigin: "http://127.0.0.1:32123",
      daemonPort: 40000, publishDaemon: true,
    }),
    preview: () => ({ port: 8080, retainedPort: null }),
    keepPublication: () => true,
    warn: () => {},
    inspect: async () => "test",
    createProcess: options => ({
      request: async () => { options.status(ownerRuntime); return { kind: "ok" }; },
      cancelPending: async () => {},
      close: async () => {},
    }),
  });
  try {
    await owner.start();
    assert.deepEqual(owner.browserEndpoints(), {
      httpOrigin: "http://100.64.1.2:52739",
      secureOrigin: "https://peer.wb.inthedark.boo:32123",
    });
  } finally {
    await owner.close();
  }
});
