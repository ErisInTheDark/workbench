/*
 * Exports:
 * - workbenchMcpFailure: a failed `/internal/mcp` reply in the Workbench error envelope, so tool text survives unwrapping whole.
 * - WorkbenchMcpRequestSchema: validate one `mcp tools` listing, `mcp request` enable request, `mcp call` forwarding request, `mcp authorize` link request or `mcp download` link download.
 * - WORKBENCH_MCP_COMMANDS: `wb mcp tools`, `wb mcp request`, `wb mcp call`, and deferred `wb mcp authorize` and `wb mcp download`, the only agent route to user-added MCP server tools, shared by CLI and MCP.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";
import { McpServerNameSchema, McpServerToolNameSchema } from "workbench-shared/workbench/mcp/mcp-server-settings";
import { WORKBENCH_MCP_QUESTIONNAIRE_REQUEST_KEY_PREFIX } from "workbench-shared/workbench/thread/thread-questionnaire-identity";
import { WorkbenchAgentCommandFlags, WorkbenchCommandArgumentError, preservePowerShellTrailingPaths } from "./workbench-agent-command-arguments";
import {
  defineWorkbenchAgentCommand, managedWorkbenchAgentCommandBody, postWorkbenchAgentCommand, type JsonValue,
} from "./workbench-agent-command-definition";

/**
 * Failed replies use the Workbench `{ error }` envelope: the CLI and MCP adapters unwrap a JSON body's `error`/`message`,
 * and an external tool's own text is often JSON with a `message` key that would otherwise replace the whole text.
 */
export function workbenchMcpFailure(text: string, status: number) {
  return Response.json({ error: text }, { status, headers: { "Cache-Control": "no-store" } });
}

const toolArguments = z.record(z.string(), z.unknown());
const reason = z.string().trim().min(1).max(1000);
const link = z.string().trim().min(1).max(8000);
const fileName = z.string().trim().min(1).max(200);

export const WorkbenchMcpRequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("tools"), server: McpServerNameSchema.optional(), query: z.string().trim().max(500).optional(),
    includeDisabled: z.boolean().optional(),
  }).strict(),
  z.object({
    action: z.literal("request"), server: McpServerNameSchema, tool: McpServerToolNameSchema, reason,
    cwd: z.string().trim().min(1), harness: ProviderKeySchema, threadId: z.string().trim().min(1),
    requestKey: z.string().refine(value => value.startsWith(WORKBENCH_MCP_QUESTIONNAIRE_REQUEST_KEY_PREFIX)),
  }).strict(),
  z.object({ action: z.literal("call"), server: McpServerNameSchema, tool: McpServerToolNameSchema, arguments: toolArguments }).strict(),
  z.object({
    action: z.literal("download"), server: McpServerNameSchema, url: link, name: fileName.optional(),
    cwd: z.string().trim().min(1), harness: ProviderKeySchema, threadId: z.string().trim().min(1),
  }).strict(),
  z.object({
    action: z.literal("authorize"), server: McpServerNameSchema, url: link, reason,
    cwd: z.string().trim().min(1), harness: ProviderKeySchema, threadId: z.string().trim().min(1),
    requestKey: z.string().refine(value => value.startsWith(WORKBENCH_MCP_QUESTIONNAIRE_REQUEST_KEY_PREFIX)),
  }).strict(),
]);

const mcpTools = defineWorkbenchAgentCommand({
  words: ["mcp", "tools"],
  usage: "wb mcp tools [--server <name>] [--include-disabled] [-- <query>]",
  description: "List enabled tools from user-added MCP servers, or search them. Without a query, lists every enabled tool; with a query, returns the best matches with their input schemas. includeDisabled adds tools the user has not enabled yet, in a separate section.",
  effects: { readOnly: true, openWorld: true },
  helpGroups: ["mcp"],
  mcpCodeModeEligible: true,
  inputSchema: z.object({
    query: z.string().trim().min(1).max(500).optional().describe("Search terms. Omit to list every tool."),
    server: McpServerNameSchema.optional().describe("Limit to one MCP server by name."),
    includeDisabled: z.boolean().optional().describe("Also list offered tools the user has not enabled."),
  }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(
      preservePowerShellTrailingPaths(args, { boolean: ["--include-disabled"], values: ["--server"] }),
      { boolean: ["--include-disabled"], values: ["--server"], trailing: true },
    );
    const query = flags.trailing.join(" ").trim();
    const server = flags.optional("--server");
    return { ...query ? { query } : {}, ...server ? { server } : {}, ...flags.has("--include-disabled") ? { includeDisabled: true } : {} };
  },
  buildRequest(input) {
    return postWorkbenchAgentCommand("/internal/mcp", {
      action: "tools", ...input.query ? { query: input.query } : {}, ...input.server ? { server: input.server } : {},
      ...input.includeDisabled ? { includeDisabled: true } : {},
    });
  },
});

const mcpRequest = defineWorkbenchAgentCommand({
  words: ["mcp", "request"],
  usage: "wb mcp request --server <name> --tool <name> --reason <text>",
  description: "Ask the user to enable one disabled MCP server tool and wait for their answer. Explain why the tool is needed in reason.",
  effects: { readOnly: false },
  helpGroups: ["mcp"],
  mcpCodeModeEligible: true,
  mcpRuntimeDrainPolicy: "preserve-across-reload",
  inputSchema: z.object({
    server: McpServerNameSchema.describe("MCP server name, as listed by mcp_tools."),
    tool: McpServerToolNameSchema.describe("Tool name on that server."),
    reason: reason.describe("Why the task needs this tool, shown to the user."),
  }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { values: ["--server", "--tool", "--reason"] });
    return { server: flags.required("--server"), tool: flags.required("--tool"), reason: flags.required("--reason") };
  },
  buildRequest(input, context) {
    return postWorkbenchAgentCommand("/internal/mcp", {
      action: "request", server: input.server, tool: input.tool, reason: input.reason,
      ...managedWorkbenchAgentCommandBody(context),
      // A stable key lets a reload restore the same pending request instead of asking twice.
      requestKey: `${WORKBENCH_MCP_QUESTIONNAIRE_REQUEST_KEY_PREFIX}${randomUUID()}`,
    });
  },
});

const mcpCall = defineWorkbenchAgentCommand({
  words: ["mcp", "call"],
  usage: "wb mcp call --server <name> --tool <name> [--arguments-json <json>]",
  description: "Run one enabled tool on a user-added MCP server. Find tools and their input schemas with mcp_tools first.",
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

const mcpAuthorize = defineWorkbenchAgentCommand({
  words: ["mcp", "authorize"],
  usage: "wb mcp authorize --server <name> --url <link> --reason <text>",
  description: "Ask the user to open a link an MCP server sent in an mcp_call reply, such as its sign-in page, and wait until they say they finished or declined. Pass the link exactly as the server returned it.",
  effects: { readOnly: false, openWorld: true },
  helpGroups: ["mcp"],
  mcpDeferred: true,
  mcpCodeModeEligible: true,
  mcpRuntimeDrainPolicy: "preserve-across-reload",
  inputSchema: z.object({
    server: McpServerNameSchema.describe("MCP server name whose reply contained the link."),
    url: link.describe("The link exactly as the server returned it."),
    reason: reason.describe("What the user is opening it for, shown to the user."),
  }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { values: ["--server", "--url", "--reason"] });
    return { server: flags.required("--server"), url: flags.required("--url"), reason: flags.required("--reason") };
  },
  buildRequest(input, context) {
    return postWorkbenchAgentCommand("/internal/mcp", {
      action: "authorize", server: input.server, url: input.url, reason: input.reason,
      ...managedWorkbenchAgentCommandBody(context),
      requestKey: `${WORKBENCH_MCP_QUESTIONNAIRE_REQUEST_KEY_PREFIX}${randomUUID()}`,
    });
  },
});

const mcpDownload = defineWorkbenchAgentCommand({
  words: ["mcp", "download"],
  usage: "wb mcp download --server <name> --url <link> [--name <file name>]",
  description: "Download a file link an MCP server sent in an mcp_call reply, such as an export URL, and print the local path it was saved to; the file is deleted when this thread settles. Pass the link exactly as the server returned it; name sets the saved file name.",
  effects: { readOnly: true, openWorld: true },
  helpGroups: ["mcp"],
  mcpDeferred: true,
  mcpCodeModeEligible: true,
  inputSchema: z.object({
    server: McpServerNameSchema.describe("MCP server name whose reply contained the link."),
    url: link.describe("The link exactly as the server returned it."),
    name: fileName.optional().describe("File name to save as, such as the document title the server reported."),
  }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { values: ["--server", "--url", "--name"] });
    const name = flags.optional("--name");
    return { server: flags.required("--server"), url: flags.required("--url"), ...name ? { name } : {} };
  },
  buildRequest(input, context) {
    return postWorkbenchAgentCommand("/internal/mcp", {
      action: "download", server: input.server, url: input.url, ...input.name ? { name: input.name } : {},
      ...managedWorkbenchAgentCommandBody(context),
    });
  },
});

export const WORKBENCH_MCP_COMMANDS = [mcpTools, mcpRequest, mcpCall, mcpAuthorize, mcpDownload] as const;
