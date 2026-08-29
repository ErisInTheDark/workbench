/*
 * Exports:
 * - withWorkbenchCodexMcpConfig: add Code-Mode-only wb and direct-only wbex loopback MCP servers to a managed Codex thread config. Keywords: workbench, Codex, MCP, Code Mode, thread config.
 */
import { randomUUID } from "node:crypto";

import { listWorkbenchAgentCodeModeToolNames } from "../lib/workbench/commands/workbench-agent-command-registry";
import { WORKBENCH_SHELL_MCP_TOOL_NAME } from "../lib/workbench/commands/workbench-shell-command";

const WORKBENCH_MCP_TOOL_TIMEOUT_SECONDS = 30 * 60;

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function getWorkbenchMcpUrl(bridgeUrl: string, projectLocal: boolean) {
  const url = new URL(bridgeUrl);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`Workbench Codex bridge URL must use ws:// or wss://, received ${bridgeUrl}`);
  }
  const protocol = url.protocol === "wss:" ? "https:" : "http:";
  const port = url.port || (url.protocol === "wss:" ? "443" : "80");
  const mcpUrl = new URL(`/orchestrator/mcp`, `${protocol}//127.0.0.1:${port}`);
  mcpUrl.searchParams.set("client", randomUUID());
  if (projectLocal) mcpUrl.searchParams.set("project-local", "true");
  return mcpUrl.toString();
}

export function withWorkbenchCodexMcpConfig(
  params: Record<string, unknown>,
  bridgeUrl: string,
  { projectLocal = false }: { projectLocal?: boolean } = {},
) {
  const config = asRecord(params.config);
  const mcpServers = asRecord(config.mcp_servers);
  const codeModeToolNames = [
    WORKBENCH_SHELL_MCP_TOOL_NAME,
    ...listWorkbenchAgentCodeModeToolNames(),
  ].sort();
  return {
    ...params,
    config: {
      ...config,
      mcp_servers: {
        ...mcpServers,
        wb: {
          default_tools_approval_mode: "approve",
          enabled_tools: codeModeToolNames,
          omit_tools_from: ["direct", "deferred"],
          required: true,
          tool_timeout_sec: WORKBENCH_MCP_TOOL_TIMEOUT_SECONDS,
          url: getWorkbenchMcpUrl(bridgeUrl, projectLocal),
        },
        wbex: {
          default_tools_approval_mode: "approve",
          disabled_tools: codeModeToolNames,
          omit_tools_from: ["code_mode", "deferred"],
          required: true,
          tool_timeout_sec: WORKBENCH_MCP_TOOL_TIMEOUT_SECONDS,
          url: getWorkbenchMcpUrl(bridgeUrl, projectLocal),
        },
      },
    },
  };
}
