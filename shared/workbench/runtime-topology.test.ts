/*
 * No production exports. Tests protect configured bridge addressing and invalid URL rejection.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { deriveWorkbenchRuntimeTopology } from "./runtime-topology.ts";

test("derives the default bridge listener", () => {
  assert.deepEqual(deriveWorkbenchRuntimeTopology({}), {
    endpoints: { bridge: "ws://0.0.0.0:4500" },
    listeners: [
      { key: "bridge", label: "Workbench bridge", port: 4500 },
    ],
  });
});

test("uses the effective port of the configured bridge URL", () => {
  assert.deepEqual(deriveWorkbenchRuntimeTopology({
    CODEX_APP_SERVER_URL: "wss://127.0.0.1:7443/socket",
  }), {
    endpoints: { bridge: "wss://127.0.0.1:7443/socket" },
    listeners: [
      { key: "bridge", label: "Workbench bridge", port: 7443 },
    ],
  });
});

test("rejects invalid listener URLs", () => {
  assert.throws(
    () => deriveWorkbenchRuntimeTopology({ CODEX_APP_SERVER_URL: "not a url" }),
    /valid IPv4 or bracketed IPv6 URL/u,
  );
});
