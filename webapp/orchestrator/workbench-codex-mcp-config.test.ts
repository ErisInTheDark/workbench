/* No production exports. Tests protect direct/Code Mode MCP separation, config merging, and loopback URL ownership. */
import assert from "node:assert/strict";
import test from "node:test";

import { withWorkbenchCodexMcpConfig } from "./workbench-codex-mcp-config";

type WorkbenchMcpServers = {
  wb: Record<string, unknown>;
  wbex: Record<string, unknown>;
};

function readWorkbenchServers(value: object) {
  return (value as { config: { mcp_servers: WorkbenchMcpServers } }).config.mcp_servers;
}

function readServerUrl(server: Record<string, unknown>) {
  return new URL(String(server.url));
}

test("adds separated direct and Code Mode wb servers while preserving caller config", () => {
  const result = withWorkbenchCodexMcpConfig({
    config: {
      developer_instructions: "",
      mcp_servers: {
        docs: { url: "https://example.com/mcp" },
        wb: { url: "https://untrusted.example/mcp" },
        wbex: { url: "https://untrusted.example/direct-mcp" },
      },
    },
    threadId: "thread-1",
  }, "ws://0.0.0.0:4500");
  const servers = readWorkbenchServers(result);
  const codeUrl = readServerUrl(servers.wb);
  const directUrl = readServerUrl(servers.wbex);
  for (const mcpUrl of [directUrl, codeUrl]) {
    assert.equal(mcpUrl.origin, "http://127.0.0.1:4500");
    assert.equal(mcpUrl.pathname, "/orchestrator/mcp");
    assert.match(mcpUrl.searchParams.get("client") ?? "", /^[0-9a-f-]{36}$/u);
    assert.equal(mcpUrl.searchParams.get("capabilities"), null);
  }
  assert.notEqual(directUrl.searchParams.get("client"), codeUrl.searchParams.get("client"));
  assert.deepEqual((result.config as { mcp_servers: Record<string, unknown> }).mcp_servers.docs, {
    url: "https://example.com/mcp",
  });
  const { url: _codeUrl, ...wbCodeWithoutUrl } = servers.wb;
  const { url: _url, ...wbexWithoutUrl } = servers.wbex;
  assert.deepEqual(wbCodeWithoutUrl, {
    default_tools_approval_mode: "approve",
    enabled_tools: [
      "git_arc_compare",
      "git_arc_diff",
      "rg",
      "shell",
      "thread_recall",
      "thread_recall_expand",
      "thread_recall_search",
      "thread_title",
      "thread_title_get",
      "tokens",
      "tokens_instructions",
    ],
    omit_tools_from: ["direct", "deferred"],
    required: true,
    tool_timeout_sec: 1800,
  });
  assert.deepEqual(wbexWithoutUrl, {
    default_tools_approval_mode: "approve",
    omit_tools_from: ["code_mode", "deferred"],
    required: true,
    tool_timeout_sec: 1800,
  });
  assert.equal((wbCodeWithoutUrl.enabled_tools as string[]).some((name) => name.startsWith("subagent_")), false);
  assert.equal((wbCodeWithoutUrl.enabled_tools as string[]).includes("thread_resume"), false);
});

test("derives secure loopback MCP transport and rejects non-WebSocket bridge URLs", () => {
  const secure = withWorkbenchCodexMcpConfig({}, "wss://0.0.0.0:7443");
  for (const server of Object.values(readWorkbenchServers(secure))) {
    const secureUrl = readServerUrl(server);
    assert.equal(secureUrl.origin, "https://127.0.0.1:7443");
    assert.equal(secureUrl.pathname, "/orchestrator/mcp");
    assert.match(secureUrl.searchParams.get("client") ?? "", /^[0-9a-f-]{36}$/u);
  }
  assert.throws(() => withWorkbenchCodexMcpConfig({}, "http://127.0.0.1:4500"), /must use ws/u);
});

test("gives each configured client a unique scope without capability negotiation", () => {
  const ordinary = withWorkbenchCodexMcpConfig({}, "ws://0.0.0.0:4500");
  const capable = withWorkbenchCodexMcpConfig({}, "ws://0.0.0.0:4500", { projectLocal: true });
  const ordinaryUrls = Object.values(readWorkbenchServers(ordinary)).map(readServerUrl);
  const capableUrls = Object.values(readWorkbenchServers(capable)).map(readServerUrl);
  const scopes = [...ordinaryUrls, ...capableUrls].map((url) => url.searchParams.get("client") ?? "");
  scopes.forEach((scope) => assert.match(scope, /^[0-9a-f-]{36}$/u));
  assert.equal(new Set(scopes).size, scopes.length);
  ordinaryUrls.forEach((url) => {
    assert.equal(url.searchParams.get("capabilities"), null);
    assert.equal(url.searchParams.get("project-local"), null);
  });
  capableUrls.forEach((url) => {
    assert.equal(url.searchParams.get("capabilities"), null);
    assert.equal(url.searchParams.get("project-local"), "true");
  });
});
