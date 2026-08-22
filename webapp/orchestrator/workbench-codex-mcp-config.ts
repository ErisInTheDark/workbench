/*
 * Exports:
 * - withWorkbenchCodexMcpConfig: add the Workbench-owned loopback MCP server to a managed Codex thread config. Keywords: workbench, Codex, MCP, thread config.
 */

const WORKBENCH_MCP_TOOL_TIMEOUT_SECONDS = 30 * 60;

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function getWorkbenchMcpUrl(bridgeUrl: string) {
  const url = new URL(bridgeUrl);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`Workbench Codex bridge URL must use ws:// or wss://, received ${bridgeUrl}`);
  }
  const protocol = url.protocol === "wss:" ? "https:" : "http:";
  const port = url.port || (url.protocol === "wss:" ? "443" : "80");
  return new URL(`/orchestrator/mcp`, `${protocol}//127.0.0.1:${port}`).toString();
}

export function withWorkbenchCodexMcpConfig(params: Record<string, unknown>, bridgeUrl: string) {
  const config = asRecord(params.config);
  const mcpServers = asRecord(config.mcp_servers);
  return {
    ...params,
    config: {
      ...config,
      mcp_servers: {
        ...mcpServers,
        wb: {
          default_tools_approval_mode: "approve",
          required: true,
          tool_timeout_sec: WORKBENCH_MCP_TOOL_TIMEOUT_SECONDS,
          url: getWorkbenchMcpUrl(bridgeUrl),
        },
      },
    },
  };
}
