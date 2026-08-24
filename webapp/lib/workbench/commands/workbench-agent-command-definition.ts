/*
 * Exports:
 * - JsonValue/WorkbenchAgentCommandRequest/WorkbenchAgentCommandResponseKind/WorkbenchAgentMcpRuntimeDrainPolicy: structured command transport and MCP lifecycle contracts. Keywords: workbench, command, request, response, drain.
 * - WorkbenchAgentCommandContext/WorkbenchAgentCommandDefinition: trusted invocation context and erased registry definition. Keywords: workbench, command, context, registry.
 * - defineWorkbenchAgentCommand: preserve command-specific Zod inference while exposing one uniform registry boundary. Keywords: workbench, command, zod, schema.
 * - getWorkbenchAgentCommandToolName: derive the canonical typed MCP name from a command definition. Keywords: workbench, command, MCP, name.
 * - getWorkbenchAgentCommand/postWorkbenchAgentCommand/queryWorkbenchAgentCommandPath: request-building helpers for command families. Keywords: workbench, command, request, query.
 */
import { z } from "zod";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type WorkbenchAgentCommandResponseKind =
  | "browse-command"
  | "browse-session-control"
  | "git-arc-add"
  | "git-arc-adopt"
  | "git-arc-compare"
  | "git-arc-continue"
  | "git-arc-diff"
  | "git-arc-mv"
  | "git-arc-plan"
  | "git-arc-propose"
  | "git-arc-remove"
  | "git-arc-restore"
  | "git-arc-start"
  | "json"
  | "native"
  | "orchestrator-reload"
  | "subagent-create"
  | "subagent-list"
  | "subagent-settle"
  | "thread-status"
  | "thread-resume"
  | "thread-title-get"
  | "thread-title";

export interface WorkbenchAgentCommandRequest {
  body?: { [key: string]: JsonValue };
  method: "GET" | "POST";
  path: string;
  responseKind: WorkbenchAgentCommandResponseKind;
  waitForReload?: boolean;
}

export interface WorkbenchAgentCommandContext {
  callerHarness: string;
  callerThreadId: string | null;
  cwd: string;
  workbenchOrigin: string | null;
}

export interface WorkbenchAgentCommandEffects {
  destructive?: boolean;
  idempotent?: boolean;
  openWorld?: boolean;
  readOnly?: boolean;
}

export interface WorkbenchAgentMcpSchemaContext {
  reloadScopes: boolean;
}

export type WorkbenchAgentMcpRuntimeDrainPolicy = "abort-at-deadline" | "abort-immediately";

export interface WorkbenchAgentCommandDefinition {
  aliases?: readonly (readonly string[])[];
  buildRequestFromCli(args: string[], context: WorkbenchAgentCommandContext): Promise<WorkbenchAgentCommandRequest>;
  buildRequestFromJson(input: object, context: WorkbenchAgentCommandContext): Promise<WorkbenchAgentCommandRequest>;
  description: string;
  effects: WorkbenchAgentCommandEffects;
  hideFromMcp?: boolean;
  helpGroups: readonly string[];
  inputSchema: z.ZodType;
  mcpRuntimeDrainPolicy?: WorkbenchAgentMcpRuntimeDrainPolicy;
  mcpInputSchema?: (context: WorkbenchAgentMcpSchemaContext) => z.ZodType;
  usage: string;
  words: readonly string[];
}

interface TypedWorkbenchAgentCommandDefinition<TSchema extends z.ZodType<object>> {
  aliases?: readonly (readonly string[])[];
  buildRequest(input: z.output<TSchema>, context: WorkbenchAgentCommandContext): Promise<WorkbenchAgentCommandRequest> | WorkbenchAgentCommandRequest;
  description: string;
  effects?: WorkbenchAgentCommandEffects;
  hideFromMcp?: boolean;
  helpGroups: readonly string[];
  inputSchema: TSchema;
  mcpRuntimeDrainPolicy?: WorkbenchAgentMcpRuntimeDrainPolicy;
  mcpInputSchema?: (context: WorkbenchAgentMcpSchemaContext) => z.ZodType;
  parseCliArgs(args: string[]): z.input<TSchema>;
  usage: string;
  words: readonly string[];
}

export function defineWorkbenchAgentCommand<TSchema extends z.ZodType<object>>(
  definition: TypedWorkbenchAgentCommandDefinition<TSchema>,
): WorkbenchAgentCommandDefinition {
  const buildValidatedRequest = async (input: unknown, context: WorkbenchAgentCommandContext) => (
    await definition.buildRequest(definition.inputSchema.parse(input), context)
  );
  return {
    aliases: definition.aliases,
    buildRequestFromCli: async (args, context) => await buildValidatedRequest(definition.parseCliArgs(args), context),
    buildRequestFromJson: buildValidatedRequest,
    description: definition.description,
    effects: definition.effects ?? {},
    hideFromMcp: definition.hideFromMcp,
    helpGroups: definition.helpGroups,
    inputSchema: definition.inputSchema,
    mcpRuntimeDrainPolicy: definition.mcpRuntimeDrainPolicy,
    mcpInputSchema: definition.mcpInputSchema,
    usage: definition.usage,
    words: definition.words,
  };
}

export function getWorkbenchAgentCommandToolName(definition: Pick<WorkbenchAgentCommandDefinition, "words">) {
  return definition.words.join("_");
}

export function postWorkbenchAgentCommand(
  path: string,
  body: WorkbenchAgentCommandRequest["body"],
  responseKind: WorkbenchAgentCommandResponseKind = "native",
): WorkbenchAgentCommandRequest {
  return { body, method: "POST", path, responseKind };
}

export function getWorkbenchAgentCommand(
  path: string,
  responseKind: WorkbenchAgentCommandResponseKind = "native",
): WorkbenchAgentCommandRequest {
  return { method: "GET", path, responseKind };
}

export function queryWorkbenchAgentCommandPath(
  pathname: string,
  values: Record<string, string | readonly string[] | null>,
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) {
      value.filter(Boolean).forEach((entry) => query.append(key, entry));
    } else if (typeof value === "string" && value) {
      query.set(key, value);
    }
  }
  const suffix = query.toString();
  return suffix ? `${pathname}?${suffix}` : pathname;
}
