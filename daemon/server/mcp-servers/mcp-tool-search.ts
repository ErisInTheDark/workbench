/*
 * Exports:
 * - McpToolListing: one server's offered tools with their allowed state, or why they are unavailable.
 * - formatMcpToolListing: agent-facing text for `mcp_tools`; allowed tools first, then disabled ones under one hint; a query ranks matches (a wrapped server's own search leads) and adds input schemas.
 * - formatWorkbenchToolSection: the same ranked text for Workbench's deferred tools under server `wb`.
 * - formatMcpToolResult: agent-facing text for one `mcp_call` result, including structured content its text does not already mirror.
 */
import { isDeepStrictEqual } from "node:util";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { WORKBENCH_MCP_SERVER_NAME } from "workbench-shared/workbench/mcp/mcp-server-settings";
import type { McpServerTool } from "./McpServerConnection";

/** `search` marks a wrapped server whose tools are found by query; `ranked` tools came from its own search, best first. */
export type McpToolListing =
  | { server: string; status: "ready"; search?: boolean; tools: { tool: McpServerTool; allowed: boolean; ranked?: boolean }[] }
  | { server: string; status: "signInRequired" }
  | { server: string; status: "error"; detail: string };

type Entry = { server: string; tool: McpServerTool; allowed: boolean; ranked?: boolean };

const MAX_MATCHES = 10;
const NO_SERVERS = "No MCP servers are configured. The user can add them in Settings > Agents > MCP servers.";
const DISABLED_HINT = "Disabled (ask the user to enable one with mcp_request):";

function firstLine(text: string) {
  return text.split(/\r?\n/u).find(line => line.trim())?.trim() ?? "";
}

function terms(text: string) {
  return text.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
}

/** Name hits outweigh description hits; tools matching no term are dropped. */
function score(entry: Entry, query: readonly string[]) {
  const name = new Set(terms(`${entry.server} ${entry.tool.name} ${entry.tool.title ?? ""}`));
  const description = entry.tool.description.toLowerCase();
  let total = 0;
  for (const term of query) {
    if (name.has(term)) total += 3;
    else if ([...name].some(word => word.includes(term))) total += 2;
    if (description.includes(term)) total += 1;
  }
  return total;
}

function brief(entry: Entry) {
  return `${entry.server}/${entry.tool.name}: ${firstLine(entry.tool.description)}`;
}

function detailed(entry: Entry) {
  return [
    `${entry.server}/${entry.tool.name}`,
    entry.tool.description.trim(),
    `Input schema: ${JSON.stringify(entry.tool.inputSchema)}`,
  ].filter(Boolean).join("\n");
}

function section(lines: readonly string[], separator: string) {
  return lines.join(separator);
}

/** A wrapped server's own search already ranked its matches, so they lead, in its order, ahead of local term matches. */
function rank(candidates: readonly Entry[], queryTerms: readonly string[]) {
  if (!queryTerms.length) return [...candidates];
  const local = candidates.filter(entry => !entry.ranked).map(entry => ({ entry, score: score(entry, queryTerms) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score
      || `${left.entry.server}/${left.entry.tool.name}`.localeCompare(`${right.entry.server}/${right.entry.tool.name}`))
    .map(({ entry }) => entry);
  return [...candidates.filter(entry => entry.ranked), ...local].slice(0, MAX_MATCHES);
}

/** Workbench's deferred tools as one `wb/<tool>` block, ranked and rendered exactly like server tools. */
export function formatWorkbenchToolSection(tools: readonly McpServerTool[], query: string | undefined) {
  const queryTerms = terms(query ?? "");
  const matches = rank(tools.map(tool => ({ server: WORKBENCH_MCP_SERVER_NAME, tool, allowed: true })), queryTerms);
  if (!matches.length) {
    return queryTerms.length ? `No deferred Workbench tools match "${query}".\n` : "No deferred Workbench tools are available.\n";
  }
  return `${section(matches.map(queryTerms.length ? detailed : brief), queryTerms.length ? "\n\n" : "\n")}\n`;
}

export function formatMcpToolListing(listings: readonly McpToolListing[], query: string | undefined, includeDisabled = false) {
  if (!listings.length) return `${NO_SERVERS}\n`;
  const entries = listings.flatMap(listing => listing.status === "ready"
    ? listing.tools.map(({ tool, allowed, ranked }): Entry => ({ server: listing.server, tool, allowed, ranked }))
    : []);
  const searchable = listings.flatMap(listing => listing.status === "ready" && listing.search
    ? [`${listing.server} is search-based: pass a query to find more of its tools.`]
    : []);
  const unavailable = listings.flatMap(listing => listing.status === "error"
    ? [`${listing.server}: unavailable (${listing.detail})`]
    : listing.status === "signInRequired"
      ? [`${listing.server}: needs authentication; the user can authenticate it in Settings > Agents > MCP servers`]
      : []);
  const queryTerms = terms(query ?? "");
  const ranked = (candidates: Entry[]) => rank(candidates, queryTerms);
  const render = queryTerms.length ? detailed : brief;
  const separator = queryTerms.length ? "\n\n" : "\n";
  const enabled = ranked(entries.filter(entry => entry.allowed)).map(render);
  const disabled = includeDisabled ? ranked(entries.filter(entry => !entry.allowed)).map(render) : [];

  const blocks: string[] = [];
  if (enabled.length) blocks.push(section(enabled, separator));
  else if (queryTerms.length) blocks.push(`No enabled MCP server tools match "${query}".`);
  else blocks.push("No MCP server tools are enabled.");
  if (disabled.length) blocks.push(`${DISABLED_HINT}\n${section(disabled, separator)}`);
  else if (!includeDisabled && !enabled.length) blocks.push("Search again with includeDisabled to see tools the user could enable.");
  if (!queryTerms.length && searchable.length) blocks.push(searchable.join("\n"));
  if (unavailable.length) blocks.push(unavailable.join("\n"));
  return `${blocks.join("\n\n")}\n`;
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
  const structured = result.structuredContent;
  if (structured && !result.content.some(part => part.type === "text" && mirrors(part.text, structured))) {
    parts.push(JSON.stringify(structured, null, 2));
  }
  return `${parts.join("\n") || "(no content)"}\n`;
}

/**
 * The spec asks servers to echo structured output as a JSON text block; printing both would duplicate it.
 * Structured content must be an object, so servers wrap an array result in one field and echo the bare array.
 */
function mirrors(text: string, structured: Record<string, unknown>) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  const values = Object.values(structured);
  return isDeepStrictEqual(parsed, structured) || (values.length === 1 && isDeepStrictEqual(parsed, values[0]));
}
