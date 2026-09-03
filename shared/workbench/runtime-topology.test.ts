/*
 * No production exports. Tests protect shared runner topology defaults, external listener ownership, and invalid configuration rejection.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { deriveWorkbenchRuntimeTopology } from "./runtime-topology.ts";

test("derives the default bridge and managed OpenCode listener", () => {
  assert.deepEqual(deriveWorkbenchRuntimeTopology({}), {
    endpoints: { bridge: "ws://0.0.0.0:4500" },
    listeners: [
      { key: "openCode", label: "OpenCode", port: 4096 },
      { key: "bridge", label: "Workbench bridge", port: 4500 },
    ],
  });
});

test("uses configured ports and excludes externally owned OpenCode", () => {
  assert.deepEqual(deriveWorkbenchRuntimeTopology({
    CODEX_APP_SERVER_URL: "wss://127.0.0.1:7443/socket",
    OPENCODE_SERVER_URL: "http://127.0.0.1:9000",
  }), {
    endpoints: { bridge: "wss://127.0.0.1:7443/socket" },
    listeners: [
      { key: "bridge", label: "Workbench bridge", port: 7443 },
    ],
  });
});

test("rejects invalid and duplicate listener ports", () => {
  assert.throws(
    () => deriveWorkbenchRuntimeTopology({ CODEX_APP_SERVER_URL: "not a url" }),
    /valid IPv4 or bracketed IPv6 URL/u,
  );
  assert.throws(
    () => deriveWorkbenchRuntimeTopology({
      CODEX_APP_SERVER_URL: "ws://127.0.0.1:4096",
      OPENCODE_SERVER_PORT: "4096",
    }),
    /duplicate port 4096/u,
  );
});
