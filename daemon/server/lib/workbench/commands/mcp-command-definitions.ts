/*
 * Exports:
 * - WorkbenchMcpRequestSchema: validate one `mcp tools` listing or `mcp call` forwarding request.
 * - WORKBENCH_MCP_COMMANDS: `wb mcp tools` and `wb mcp call`, the only agent route to user-added MCP server tools, shared by CLI and MCP.
 */
import { z } from "zod";
import { McpServerNameSchema, McpServerToolNameSchema } from "workbench-shared/workbench/mcp/mcp-server-settings";
import { WorkbenchAgentCommandFlags, WorkbenchCommandArgumentError, preservePowerShellTrailingPaths } from "./workbench-agent-command-arguments";
import { defineWorkbenchAgentCommand, postWorkbenchAgentCommand, type JsonValue } from "./workbench-agent-command-definition";

const toolArguments = z.record(z.string(), z.unknown());

export const WorkbenchMcpRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("tools"), server: McpServerNameSchema.optional(), query: z.string().trim().max(500).optional() }).strict(),
  z.object({ action: z.literal("call"), server: McpServerNameSchema, tool: McpServerToolNameSchema, arguments: toolArguments }).strict(),
]);

const mcpTools = defineWorkbenchAgentCommand({
  words: ["mcp", "tools"],
  usage: "wb mcp tools [--server <name>] [-- <query>]",
  description: "List allowed tools from user-added MCP servers, or search them. Without a query, lists every allowed tool; with a query, returns the best matches with their input schemas.",
  effects: { readOnly: true, openWorld: true },
  helpGroups: ["mcp"],
  mcpCodeModeEligible: true,
  inputSchema: z.object({
    query: z.string().trim().min(1).max(500).optional().describe("Search terms. Omit to list every allowed tool."),
    server: McpServerNameSchema.optional().describe("Limit to one MCP server by name."),
  }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(preservePowerShellTrailingPaths(args, { values: ["--server"] }), {
      values: ["--server"], trailing: true,
    });
    const query = flags.trailing.join(" ").trim();
    const server = flags.optional("--server");
    return { ...query ? { query } : {}, ...server ? { server } : {} };
  },
  buildRequest(input) {
    return postWorkbenchAgentCommand("/internal/mcp", {
      action: "tools", ...input.query ? { query: input.query } : {}, ...input.server ? { server: input.server } : {},
    });
  },
});

const mcpCall = defineWorkbenchAgentCommand({
  words: ["mcp", "call"],
  usage: "wb mcp call --server <name> --tool <name> [--arguments-json <json>]",
  description: "Run one allowed tool on a user-added MCP server. Find tools and their input schemas with mcp_tools first.",
  effects: { readOnly: false, openWorld: true },
  helpGroups: ["mcp"],
  mcpCodeModeEligible: true,
  inputSchema: z.object({
    server: McpServerNameSchema.describe("MCP server name, as listed by mcp_tools."),
    tool: McpServerToolNameSchema.describe("Tool name on that server."),
    arguments: toolArguments.default({}).describe("Tool input matching its input schema."),
  }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, {
      values: ["--server", "--tool", "--arguments-json"], leadingDashValues: ["--arguments-json"],
    });
    const raw = flags.optional("--arguments-json");
    let parsed: unknown = {};
    if (raw !== null) {
      try { parsed = JSON.parse(raw); } catch {
        throw new WorkbenchCommandArgumentError("unexpectedArgument", "--arguments-json", "--arguments-json must be a JSON object.");
      }
    }
    const input = toolArguments.safeParse(parsed);
    if (!input.success) throw new WorkbenchCommandArgumentError("unexpectedArgument", "--arguments-json", "--arguments-json must be a JSON object.");
    return { server: flags.required("--server"), tool: flags.required("--tool"), arguments: input.data };
  },
  buildRequest(input) {
    // A JSON round trip turns arbitrary validated input into transportable JSON values.
    const args = JSON.parse(JSON.stringify(input.arguments)) as { [key: string]: JsonValue };
    return postWorkbenchAgentCommand("/internal/mcp", { action: "call", server: input.server, tool: input.tool, arguments: args });
  },
});

export const WORKBENCH_MCP_COMMANDS = [mcpTools, mcpCall] as const;
