/*
 * Exports:
 * - McpToolListing: one server's allowed tools, or why they are unavailable.
 * - formatMcpToolListing: agent-facing text for `mcp_tools`; a query returns ranked matches with input schemas.
 * - formatMcpToolResult: agent-facing text for one `mcp_call` result.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerTool } from "./McpServerConnection";

export type McpToolListing =
  | { server: string; status: "ready"; tools: McpServerTool[] }
  | { server: string; status: "error"; detail: string };

const MAX_MATCHES = 10;
const NO_SERVERS = "No MCP servers are configured. The user can add them in Settings > Agents > MCP servers.";

function firstLine(text: string) {
  return text.split(/\r?\n/u).find(line => line.trim())?.trim() ?? "";
}

function terms(text: string) {
  return text.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
}

/** Name hits outweigh description hits; tools matching no term are dropped. */
function score(tool: McpServerTool, server: string, query: readonly string[]) {
  const name = new Set(terms(`${server} ${tool.name}`));
  const description = tool.description.toLowerCase();
  let total = 0;
  for (const term of query) {
    if (name.has(term)) total += 3;
    else if ([...name].some(word => word.includes(term))) total += 2;
    if (description.includes(term)) total += 1;
  }
  return total;
}

function unavailable(listings: readonly McpToolListing[]) {
  return listings.flatMap(listing => listing.status === "error" ? [`${listing.server}: unavailable (${listing.detail})`] : []);
}

export function formatMcpToolListing(listings: readonly McpToolListing[], query: string | undefined) {
  if (!listings.length) return `${NO_SERVERS}\n`;
  const ready = listings.flatMap(listing => listing.status === "ready"
    ? listing.tools.map(tool => ({ server: listing.server, tool }))
    : []);
  const failures = unavailable(listings);
  const queryTerms = terms(query ?? "");
  if (!queryTerms.length) {
    const lines = ready.map(({ server, tool }) => `${server}/${tool.name}: ${firstLine(tool.description)}`);
    if (!lines.length && !failures.length) lines.push("No MCP server tools are allowed. The user can allow them in Settings > Agents > MCP servers.");
    return `${[...lines, ...failures].join("\n")}\n`;
  }
  const matches = ready
    .map(entry => ({ ...entry, score: score(entry.tool, entry.server, queryTerms) }))
    .filter(entry => entry.score > 0)
    .sort((left, right) => right.score - left.score || `${left.server}/${left.tool.name}`.localeCompare(`${right.server}/${right.tool.name}`))
    .slice(0, MAX_MATCHES);
  const blocks = matches.map(({ server, tool }) => [
    `${server}/${tool.name}`,
    tool.description.trim(),
    `Input schema: ${JSON.stringify(tool.inputSchema)}`,
  ].filter(Boolean).join("\n"));
  if (!blocks.length) blocks.push(`No allowed MCP server tools match "${query}".`);
  return `${[...blocks, ...failures].join("\n\n")}\n`;
}

export function formatMcpToolResult(result: CallToolResult) {
  const parts = result.content.map(part => {
    switch (part.type) {
      case "text": return part.text;
      case "resource": return "text" in part.resource ? part.resource.text : `[binary resource: ${part.resource.uri}]`;
      case "resource_link": return `[resource link: ${part.uri}]`;
      case "image":
      case "audio": return `[${part.type} omitted: ${part.mimeType}]`;
      default: return "";
    }
  }).filter(Boolean);
  if (!parts.length && result.structuredContent) parts.push(JSON.stringify(result.structuredContent, null, 2));
  return `${parts.join("\n") || "(no content)"}\n`;
}
