/* No production exports. Tests protect managed-thread MCP config merging and loopback URL ownership. */
import assert from "node:assert/strict";
import test from "node:test";

import { withWorkbenchCodexMcpConfig } from "./workbench-codex-mcp-config";

test("adds wb MCP config while preserving caller config and other servers", () => {
  const result = withWorkbenchCodexMcpConfig({
    config: {
      developer_instructions: "",
      mcp_servers: {
        docs: { url: "https://example.com/mcp" },
        wb: { url: "https://untrusted.example/mcp" },
      },
    },
    threadId: "thread-1",
  }, "ws://0.0.0.0:4500");
  const wb = (result.config as { mcp_servers: { wb: Record<string, unknown> } }).mcp_servers.wb;
  const mcpUrl = new URL(String(wb.url));
  assert.equal(mcpUrl.origin, "http://127.0.0.1:4500");
  assert.equal(mcpUrl.pathname, "/orchestrator/mcp");
  assert.match(mcpUrl.searchParams.get("client") ?? "", /^[0-9a-f-]{36}$/u);
  assert.equal(mcpUrl.searchParams.get("capabilities"), null);
  const { url: _url, ...wbWithoutUrl } = wb;
  assert.deepEqual({ ...result, config: { ...result.config as object, mcp_servers: { ...(result.config as { mcp_servers: object }).mcp_servers, wb: wbWithoutUrl } } }, {
    config: {
      developer_instructions: "",
      mcp_servers: {
        docs: { url: "https://example.com/mcp" },
        wb: {
          default_tools_approval_mode: "approve",
          required: true,
          tool_timeout_sec: 1800,
        },
      },
    },
    threadId: "thread-1",
  });
});

test("derives secure loopback MCP transport and rejects non-WebSocket bridge URLs", () => {
  const secure = withWorkbenchCodexMcpConfig({}, "wss://0.0.0.0:7443");
  const secureUrl = new URL((secure.config as { mcp_servers: { wb: { url: string } } }).mcp_servers.wb.url);
  assert.equal(secureUrl.origin, "https://127.0.0.1:7443");
  assert.equal(secureUrl.pathname, "/orchestrator/mcp");
  assert.match(secureUrl.searchParams.get("client") ?? "", /^[0-9a-f-]{36}$/u);
  assert.throws(() => withWorkbenchCodexMcpConfig({}, "http://127.0.0.1:4500"), /must use ws/u);
});

test("gives each configured client a unique scope and selects capability inventory", () => {
  const ordinary = withWorkbenchCodexMcpConfig({}, "ws://0.0.0.0:4500");
  const capable = withWorkbenchCodexMcpConfig({}, "ws://0.0.0.0:4500", { reloadScopes: true });
  const readUrl = (value: object) => new URL((value as { config: { mcp_servers: { wb: { url: string } } } }).config.mcp_servers.wb.url);
  const ordinaryUrl = readUrl(ordinary);
  const capableUrl = readUrl(capable);
  assert.match(ordinaryUrl.searchParams.get("client") ?? "", /^[0-9a-f-]{36}$/u);
  assert.match(capableUrl.searchParams.get("client") ?? "", /^[0-9a-f-]{36}$/u);
  assert.notEqual(ordinaryUrl.searchParams.get("client"), capableUrl.searchParams.get("client"));
  assert.equal(ordinaryUrl.searchParams.get("capabilities"), null);
  assert.equal(capableUrl.searchParams.get("capabilities"), "reload-scopes");
});
