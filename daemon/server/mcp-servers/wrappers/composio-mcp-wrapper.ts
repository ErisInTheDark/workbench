/*
 * Exports:
 * - default composioMcpWrapper: unwraps Composio's meta tools (search, schemas, multi-execute) into its inner app tools,
 *   keeping Composio's session id and turning "no active connection" failures into a sign-in link for the user.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerTool } from "../McpServerConnection";
import type { McpWrapper, McpWrapperRawCall, McpWrapperSession } from "./mcp-wrapper";

const SEARCH = "COMPOSIO_SEARCH_TOOLS";
const SCHEMAS = "COMPOSIO_GET_TOOL_SCHEMAS";
const EXECUTE = "COMPOSIO_MULTI_EXECUTE_TOOL";
const CONNECT = "COMPOSIO_MANAGE_CONNECTIONS";
const NO_CONNECTION = /No active connection found for toolkit\(s\) ([^.]+?) in this session/u;

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}

/** Composio answers every meta tool with one JSON text part, also when it reports a failure. */
function envelope(result: CallToolResult) {
  for (const part of result.content) {
    if (part.type !== "text") continue;
    try {
      const parsed = record(JSON.parse(part.text));
      if (parsed) return parsed;
    } catch { /* not this part */ }
  }
  return null;
}

function text(value: unknown, isError: boolean): CallToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], isError };
}

/** Composio's own meta tools; its schema lookup describes them too, but agents only ever see app tools. */
const isMeta = (name: string) => name.startsWith("COMPOSIO_");

function toolFromSchema(entry: unknown): McpServerTool | null {
  const schema = record(entry);
  const name = typeof schema?.tool_slug === "string" ? schema.tool_slug : null;
  const inputSchema = record(schema?.input_schema);
  if (!name || isMeta(name) || !inputSchema) return null;
  return { name, title: null, description: typeof schema?.description === "string" ? schema.description : "", inputSchema };
}

class ComposioSession implements McpWrapperSession {
  #sessionId: string | null = null;

  constructor(private readonly raw: McpWrapperRawCall) {}

  async search(query: string, signal: AbortSignal) {
    const data = record(envelope(await this.raw(SEARCH, {
      queries: [{ use_case: query }], session: this.#sessionId ? { id: this.#sessionId } : { generate_id: true }, search_strategy: "tool_search",
    }, signal))?.data);
    this.#remember(data);
    const slugs = [...new Set((Array.isArray(data?.results) ? data.results : []).flatMap(result => {
      const entry = record(result);
      return [entry?.primary_tool_slugs, entry?.related_tool_slugs].flatMap(list => Array.isArray(list) ? list.filter(slug => typeof slug === "string") : []);
    }))];
    const schemas = record(data?.tool_schemas) ?? {};
    const complete = new Map(slugs.flatMap(slug => {
      const tool = toolFromSchema(schemas[slug]);
      return tool ? [[slug, tool] as const] : [];
    }));
    // Results without a full schema carry a reference that the schema tool resolves.
    const missing = slugs.filter(slug => !complete.has(slug));
    for (const tool of missing.length ? await this.describe(missing, signal) : []) complete.set(tool.name, tool);
    return slugs.flatMap(slug => complete.get(slug) ?? []);
  }

  async describe(requested: readonly string[], signal: AbortSignal) {
    const names = requested.filter(name => !isMeta(name));
    if (!names.length) return [];
    const data = record(envelope(await this.raw(SCHEMAS, { tool_slugs: names, ...this.#session() }, signal))?.data);
    const schemas = record(data?.tool_schemas) ?? {};
    return names.flatMap(name => toolFromSchema(schemas[name]) ?? []);
  }

  async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
    const result = await this.raw(EXECUTE, {
      tools: [{ tool_slug: name, arguments: args }], sync_response_to_workbench: false, ...this.#session(),
    }, signal);
    const data = record(envelope(result)?.data);
    this.#remember(data);
    const first = record(Array.isArray(data?.results) ? data.results[0] : null);
    if (!first) return result;
    const response = record(first.response);
    if (response) return text(response, response.successful === false);
    const error = typeof first.error === "string" ? first.error : "The tool failed.";
    const toolkits = [...(NO_CONNECTION.exec(error)?.[1] ?? "").matchAll(/'([^']+)'/gu)].map(match => match[1]!);
    return toolkits.length ? await this.#connect(error, toolkits, signal) : text(error, true);
  }

  /** Start the missing connections, so the failure carries the links the user must open. */
  async #connect(error: string, toolkits: readonly string[], signal: AbortSignal) {
    const data = record(envelope(await this.raw(CONNECT, {
      toolkits: toolkits.map(name => ({ name, action: "add" })), ...this.#session(),
    }, signal))?.data);
    const results = record(data?.results) ?? {};
    const links = toolkits.flatMap(name => {
      const url = record(results[name])?.redirect_url;
      return typeof url === "string" ? [`${name}: ${url}`] : [];
    });
    if (!links.length) return text(error, true);
    return text([
      error.replace(/ To fix this,[\s\S]*$/u, ""),
      `The user must connect ${toolkits.join(", ")} first. Sign-in links:`,
      ...links,
      "Ask the user to open the link with wb/mcp_authorize, then retry this call.",
    ].join("\n"), true);
  }

  #session() {
    return this.#sessionId ? { session_id: this.#sessionId } : {};
  }

  #remember(data: Json | null) {
    const id = record(data?.session)?.id;
    if (typeof id === "string" && id) this.#sessionId = id;
  }
}

const composioMcpWrapper: McpWrapper = {
  id: "composio",
  detect: tools => [SEARCH, SCHEMAS, EXECUTE].every(name => tools.some(tool => tool.name === name)),
  open: raw => new ComposioSession(raw),
};

export default composioMcpWrapper;
