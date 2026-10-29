/*
 * Exports:
 * - McpWrapperRawCall: call one of the wrapper server's own (meta) tools.
 * - McpWrapperPorts: what a wrapper session may use: raw meta-tool calls and public file downloads.
 * - McpWrapperSession: the inner tools of one wrapper server, found by search, described by name and called directly.
 * - McpWrapper: recognises a meta-tool server by its tool list and opens a session over it.
 * - MCP_WRAPPERS/detectMcpWrapper: the known wrappers, and the one a tool list belongs to.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerTool } from "../McpServerConnection";
import composioMcpWrapper from "./composio-mcp-wrapper";

export type McpWrapperRawCall = (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<CallToolResult>;

export interface McpWrapperPorts {
  call: McpWrapperRawCall;
  /** Read a public https link the wrapper server handed out, such as an exported file. */
  download(url: string, signal: AbortSignal): Promise<Buffer>;
}

export interface McpWrapperSession {
  /** Inner tools for a query, best first, with complete input schemas. */
  search(query: string, signal: AbortSignal): Promise<McpServerTool[]>;
  /** The named inner tools that exist, with complete input schemas. */
  describe(names: readonly string[], signal: AbortSignal): Promise<McpServerTool[]>;
  /** Run one inner tool and return its own result, as if the server offered it directly. */
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult>;
}

export interface McpWrapper {
  id: string;
  detect(tools: readonly McpServerTool[]): boolean;
  open(ports: McpWrapperPorts): McpWrapperSession;
}

export const MCP_WRAPPERS: readonly McpWrapper[] = [composioMcpWrapper];

export function detectMcpWrapper(tools: readonly McpServerTool[], wrappers: readonly McpWrapper[] = MCP_WRAPPERS) {
  return wrappers.find(wrapper => wrapper.detect(tools)) ?? null;
}
