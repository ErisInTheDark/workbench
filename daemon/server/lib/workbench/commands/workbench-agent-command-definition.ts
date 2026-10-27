/*
 * Exports:
 * - JsonPrimitive: scalar JSON transport value.
 * - WorkbenchAgentCommandEffects: write-effect declarations.
 * - managedWorkbenchAgentCommandBody: validated managed identity for command requests.
 * - JsonValue/WorkbenchAgentCommandRequest/WorkbenchAgentCommandResponseKind/WorkbenchAgentMcpRuntimeDrainPolicy: transport and MCP lifecycle contracts.
 * - WorkbenchAgentCommandContext/WorkbenchAgentCommandDefinition: invocation context and registry definitions.
 * - WorkbenchCommandAudienceRule: declarative harness, root-only and local-capability gates a definition places on its callers.
 * - WorkbenchLocalCapability: a local capability setting a command can require.
 * - defineWorkbenchAgentCommand: preserve schema inference at the registry boundary, refuse root-only input from other callers, and keep capability-gated commands deferred.
 * - getWorkbenchAgentCommandToolName: canonical MCP command name.
 * - isWorkbenchAgentCommandOnMcp: whether the wb MCP server offers a command at all.
 * - getWorkbenchAgentCommand/postWorkbenchAgentCommand/queryWorkbenchAgentCommandPath: request construction.
 * - createWorkbenchAgentMcpRuntimeReloadInterruption: private reload re-entry signal.
 * - isWorkbenchAgentMcpRuntimeReloadInterruption: recognise cross-generation reload re-entry.
 */
import { z } from "zod";
import { ProviderKeySchema, type ProviderKey } from "workbench-shared/workbench/provider/provider-key";
import type { WorkbenchLocalCapabilitySettings } from "workbench-shared/types";

export type WorkbenchLocalCapability = keyof WorkbenchLocalCapabilitySettings;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type WorkbenchAgentCommandResponseKind =
  | "browse-command"
  | "browse-session-control"
  | "git-arc-add"
  | "git-arc-adopt"
  | "git-arc-claims"
  | "git-arc-status"
  | "git-arc-compare"
  | "git-arc-continue"
  | "git-arc-diff"
  | "git-arc-edit"
  | "git-arc-plan"
  | "git-arc-propose"
  | "git-arc-release"
  | "git-arc-remove"
  | "git-arc-restore"
  | "git-arc-start"
  | "git-arc-stack"
  | "git-arc-stash"
  | "git-arc-unstack"
  | "git-arc-unstash"
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
  /** Original invocation lifetime, distinct from a replaceable command-generation signal. Never transported. */
  lifetimeSignal?: AbortSignal;
}

export interface WorkbenchAgentCommandContext {
  /** Caller explicitly opted into store reads for this invocation, never daemon-global permission. */
  allowStoreRead?: boolean;
  callerHarness: string;
  callerThreadId: string | null;
  cwd: string;
  /** May use root-only commands and input: a managed thread at the Workbench repository root, or an unmanaged caller. */
  workbenchRoot: boolean;
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
  if (!ProviderKeySchema.safeParse(callerHarness).success) {
    throw new Error("A managed Workbench harness identity is required.");
  }
  return { cwd, harness: callerHarness, threadId: callerThreadId };
}

export function isWorkbenchAgentMcpRuntimeReloadInterruption(error: unknown) {
  return error instanceof Error && Reflect.get(error, MCP_RUNTIME_RELOAD_INTERRUPTION_KEY) === true;
}

/** Parent-only commands are listed by name in `WORKBENCH_PARENT_ONLY_TOOLS`, which provider permission edges also read. */
export interface WorkbenchCommandAudienceRule {
  /** Providers that may use this command; omitted means every provider. */
  harnesses?: readonly ProviderKey[];
  /** Usable only by managed threads at the Workbench repository root, and by unmanaged callers. */
  rootOnly?: true;
  /** Usable only while this local capability is enabled; such commands must be MCP-deferred so preloaded lists never change. */
  requiresCapability?: WorkbenchLocalCapability;
}

export interface WorkbenchAgentCommandDefinition {
  aliases?: readonly (readonly string[])[];
  audience?: WorkbenchCommandAudienceRule;
  buildRequestFromCli(args: string[], context: WorkbenchAgentCommandContext): Promise<WorkbenchAgentCommandRequest>;
  buildRequestFromJson(input: object, context: WorkbenchAgentCommandContext): Promise<WorkbenchAgentCommandRequest>;
  description: string;
  effects: WorkbenchAgentCommandEffects;
  /** Not preloaded as an MCP tool; agents find it with `mcp_tools` and run it with `mcp_call` on server `wb`. */
  mcpDeferred?: boolean;
  /** Execute without recording MCP arguments or results in the conversation transcript. */
  hideMcpTranscript?: boolean;
  hideFromRootHelp?: boolean;
  helpGroups: readonly string[];
  inputSchema: z.ZodType;
  mcpCodeModeEligible?: boolean;
  mcpRuntimeDrainPolicy?: WorkbenchAgentMcpRuntimeDrainPolicy;
  mcpSteerInterruptible?: boolean;
  /** The user may stop a running call from its transcript row, as they can a running shell. */
  mcpUserStoppable?: boolean;
  /** Its behaviour follows one cwd, so MCP callers, who cannot `cd`, may name it as `workdir`. */
  mcpWorkdir?: true;
  usage: string;
  /** Usage shown instead of `usage` to callers at the Workbench repository root, documenting root-only options. */
  workbenchRootUsage?: string;
  words: readonly string[];
}

interface TypedWorkbenchAgentCommandDefinition<TSchema extends z.ZodType<object>> {
  aliases?: readonly (readonly string[])[];
  audience?: WorkbenchCommandAudienceRule;
  buildRequest(input: z.output<TSchema>, context: WorkbenchAgentCommandContext): Promise<WorkbenchAgentCommandRequest> | WorkbenchAgentCommandRequest;
  description: string;
  effects?: WorkbenchAgentCommandEffects;
  mcpDeferred?: boolean;
  hideMcpTranscript?: boolean;
  hideFromRootHelp?: boolean;
  helpGroups: readonly string[];
  inputSchema: TSchema;
  mcpCodeModeEligible?: boolean;
  mcpRuntimeDrainPolicy?: WorkbenchAgentMcpRuntimeDrainPolicy;
  mcpSteerInterruptible?: boolean;
  mcpUserStoppable?: boolean;
  mcpWorkdir?: true;
  parseCliArgs(args: string[]): z.input<TSchema>;
  /** Input fields only Workbench-root callers may set; anyone else setting one is refused. */
  rootOnlyInput?: readonly (keyof z.output<TSchema> & string)[];
  usage: string;
  workbenchRootUsage?: string;
  words: readonly string[];
}

export function defineWorkbenchAgentCommand<TSchema extends z.ZodType<object>>(
  definition: TypedWorkbenchAgentCommandDefinition<TSchema>,
): WorkbenchAgentCommandDefinition {
  if (definition.audience?.requiresCapability && !definition.mcpDeferred) {
    throw new Error(`Capability-gated command ${definition.words.join(" ")} must be MCP-deferred.`);
  }
  const buildValidatedRequest = async (input: unknown, context: WorkbenchAgentCommandContext) => {
    const parsed = definition.inputSchema.parse(input);
    const rootOnly = context.workbenchRoot ? undefined : definition.rootOnlyInput?.find(field => Boolean(parsed[field]));
    if (rootOnly) throw new Error(`${rootOnly} is available only to threads at the Workbench repository root.`);
    const request = await definition.buildRequest(parsed, context);
    Object.defineProperty(request, "commandName", {
      enumerable: false,
      value: definition.words.join(" "),
    });
    return request;
  };
  return {
    aliases: definition.aliases,
    audience: definition.audience,
    buildRequestFromCli: async (args, context) => await buildValidatedRequest(definition.parseCliArgs(args), context),
    buildRequestFromJson: buildValidatedRequest,
    description: definition.description,
    effects: definition.effects ?? {},
    mcpDeferred: definition.mcpDeferred,
    hideMcpTranscript: definition.hideMcpTranscript,
    hideFromRootHelp: definition.hideFromRootHelp,
    helpGroups: definition.helpGroups,
    inputSchema: definition.inputSchema,
    mcpCodeModeEligible: definition.mcpCodeModeEligible,
    mcpRuntimeDrainPolicy: definition.mcpRuntimeDrainPolicy,
    mcpSteerInterruptible: definition.mcpSteerInterruptible,
    mcpUserStoppable: definition.mcpUserStoppable,
    mcpWorkdir: definition.mcpWorkdir,
    usage: definition.usage,
    workbenchRootUsage: definition.workbenchRootUsage,
    words: definition.words,
  };
}

export function getWorkbenchAgentCommandToolName(definition: Pick<WorkbenchAgentCommandDefinition, "words">) {
  return definition.words.join("_");
}

/** Whether the wb MCP server offers this command, directly or through `mcp_call`; deferred commands hidden from help are CLI-only. */
export function isWorkbenchAgentCommandOnMcp(definition: Pick<WorkbenchAgentCommandDefinition, "hideFromRootHelp" | "mcpDeferred">) {
  return !(definition.mcpDeferred && definition.hideFromRootHelp);
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
