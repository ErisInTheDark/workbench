/*
 * Exports:
 * - JsonPrimitive: scalar JSON transport value.
 * - WorkbenchAgentCommandEffects: write-effect declarations.
 * - managedWorkbenchAgentCommandBody: validated managed identity for command requests.
 * - JsonValue/WorkbenchAgentCommandRequest/WorkbenchAgentCommandResponseKind/WorkbenchAgentMcpRuntimeDrainPolicy: transport and MCP lifecycle contracts.
 * - WorkbenchAgentCommandContext/WorkbenchAgentCommandDefinition: invocation context and registry definitions.
 * - defineWorkbenchAgentCommand: preserve schema inference at the registry boundary.
 * - getWorkbenchAgentCommandToolName: canonical MCP command name.
 * - getWorkbenchAgentCommand/postWorkbenchAgentCommand/queryWorkbenchAgentCommandPath: request construction.
 * - createWorkbenchAgentMcpRuntimeReloadInterruption: private reload re-entry signal.
 * - isWorkbenchAgentMcpRuntimeReloadInterruption: recognise cross-generation reload re-entry.
 */
import { z } from "zod";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type WorkbenchAgentCommandResponseKind =
  | "browse-command"
  | "browse-session-control"
  | "git-arc-add"
  | "git-arc-adopt"
  | "git-arc-claims"
  | "git-arc-scope"
  | "git-arc-status"
  | "git-arc-compare"
  | "git-arc-continue"
  | "git-arc-diff"
  | "git-arc-mv"
  | "git-arc-plan"
  | "git-arc-propose"
  | "git-arc-release"
  | "git-arc-remove"
  | "git-arc-restore"
  | "git-arc-start"
  | "git-arc-wait"
  | "json"
  | "native"
  | "reload-dirt"
  | "daemon-reload"
  | "subagent-create"
  | "subagent-list"
  | "subagent-settle"
  | "thread-status"
  | "thread-refresh"
  | "thread-title-get"
  | "thread-title";

export interface WorkbenchAgentCommandRequest {
  body?: { [key: string]: JsonValue };
  commandName?: string;
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

export type WorkbenchAgentMcpRuntimeDrainPolicy =
  | "abort-at-deadline"
  | "abort-immediately"
  | "preserve-across-reload";

const MCP_RUNTIME_RELOAD_INTERRUPTION_KEY = Symbol.for("workbench.agentMcpRuntimeReloadInterruption.v1");

export function createWorkbenchAgentMcpRuntimeReloadInterruption() {
  const error = new Error("Workbench command generation was replaced.");
  Reflect.set(error, MCP_RUNTIME_RELOAD_INTERRUPTION_KEY, true);
  return error;
}

export function managedWorkbenchAgentCommandBody({ callerHarness, callerThreadId, cwd }: Pick<WorkbenchAgentCommandContext, "callerHarness" | "callerThreadId" | "cwd">) {
  if (!callerThreadId) throw new Error("A managed Workbench thread identity is required.");
  if (callerHarness !== "codex" && callerHarness !== "copilot" && callerHarness !== "opencode") {
    throw new Error("A managed Workbench harness identity is required.");
  }
  return { cwd, harness: callerHarness, threadId: callerThreadId };
}

export function isWorkbenchAgentMcpRuntimeReloadInterruption(error: unknown) {
  return error instanceof Error && Reflect.get(error, MCP_RUNTIME_RELOAD_INTERRUPTION_KEY) === true;
}

export interface WorkbenchAgentCommandDefinition {
  aliases?: readonly (readonly string[])[];
  buildRequestFromCli(args: string[], context: WorkbenchAgentCommandContext): Promise<WorkbenchAgentCommandRequest>;
  buildRequestFromJson(input: object, context: WorkbenchAgentCommandContext): Promise<WorkbenchAgentCommandRequest>;
  description: string;
  effects: WorkbenchAgentCommandEffects;
  hideFromMcp?: boolean;
  hideFromRootHelp?: boolean;
  helpGroups: readonly string[];
  inputSchema: z.ZodType;
  managedThreadRootOnly?: boolean;
  mcpCodeModeEligible?: boolean;
  mcpRuntimeDrainPolicy?: WorkbenchAgentMcpRuntimeDrainPolicy;
  mcpSteerInterruptible?: boolean;
  usage: string;
  words: readonly string[];
}

interface TypedWorkbenchAgentCommandDefinition<TSchema extends z.ZodType<object>> {
  aliases?: readonly (readonly string[])[];
  buildRequest(input: z.output<TSchema>, context: WorkbenchAgentCommandContext): Promise<WorkbenchAgentCommandRequest> | WorkbenchAgentCommandRequest;
  description: string;
  effects?: WorkbenchAgentCommandEffects;
  hideFromMcp?: boolean;
  hideFromRootHelp?: boolean;
  helpGroups: readonly string[];
  inputSchema: TSchema;
  managedThreadRootOnly?: boolean;
  mcpCodeModeEligible?: boolean;
  mcpRuntimeDrainPolicy?: WorkbenchAgentMcpRuntimeDrainPolicy;
  mcpSteerInterruptible?: boolean;
  parseCliArgs(args: string[]): z.input<TSchema>;
  usage: string;
  words: readonly string[];
}

export function defineWorkbenchAgentCommand<TSchema extends z.ZodType<object>>(
  definition: TypedWorkbenchAgentCommandDefinition<TSchema>,
): WorkbenchAgentCommandDefinition {
  const buildValidatedRequest = async (input: unknown, context: WorkbenchAgentCommandContext) => {
    const request = await definition.buildRequest(definition.inputSchema.parse(input), context);
    Object.defineProperty(request, "commandName", {
      enumerable: false,
      value: definition.words.join(" "),
    });
    return request;
  };
  return {
    aliases: definition.aliases,
    buildRequestFromCli: async (args, context) => await buildValidatedRequest(definition.parseCliArgs(args), context),
    buildRequestFromJson: buildValidatedRequest,
    description: definition.description,
    effects: definition.effects ?? {},
    hideFromMcp: definition.hideFromMcp,
    hideFromRootHelp: definition.hideFromRootHelp,
    helpGroups: definition.helpGroups,
    inputSchema: definition.inputSchema,
    managedThreadRootOnly: definition.managedThreadRootOnly,
    mcpCodeModeEligible: definition.mcpCodeModeEligible,
    mcpRuntimeDrainPolicy: definition.mcpRuntimeDrainPolicy,
    mcpSteerInterruptible: definition.mcpSteerInterruptible,
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
