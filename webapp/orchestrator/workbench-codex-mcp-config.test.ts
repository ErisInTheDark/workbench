/* No production exports. Tests protect managed-thread MCP config merging and loopback URL ownership. */
import assert from "node:assert/strict";
import test from "node:test";

import { withWorkbenchCodexMcpConfig } from "./workbench-codex-mcp-config";

test("adds wb MCP config while preserving caller config and other servers", () => {
  assert.deepEqual(withWorkbenchCodexMcpConfig({
    config: {
      developer_instructions: "",
      mcp_servers: {
        docs: { url: "https://example.com/mcp" },
        wb: { url: "https://untrusted.example/mcp" },
      },
    },
    threadId: "thread-1",
  }, "ws://0.0.0.0:4500"), {
    config: {
      developer_instructions: "",
      mcp_servers: {
        docs: { url: "https://example.com/mcp" },
        wb: {
          default_tools_approval_mode: "approve",
          required: true,
          tool_timeout_sec: 1800,
          url: "http://127.0.0.1:4500/orchestrator/mcp",
        },
      },
    },
    threadId: "thread-1",
  });
});

test("derives secure loopback MCP transport and rejects non-WebSocket bridge URLs", () => {
  const secure = withWorkbenchCodexMcpConfig({}, "wss://0.0.0.0:7443");
  assert.equal(((secure.config as { mcp_servers: { wb: { url: string } } }).mcp_servers.wb.url), "https://127.0.0.1:7443/orchestrator/mcp");
  assert.throws(() => withWorkbenchCodexMcpConfig({}, "http://127.0.0.1:4500"), /must use ws/u);
});
