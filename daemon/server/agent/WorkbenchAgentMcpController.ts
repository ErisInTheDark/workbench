/*
 * Exports:
 * - WorkbenchAgentMcpControllerOptions: inject trusted identity resolution, caller audience, cancellation, wait deadlines, hosted-shell approval, and command execution ports.
 * - default WorkbenchAgentMcpController: one MCP generation's short steps (list, call, finish) for typed wb tools, served through the thin ingress, including deferred tools found and run on server `wb` of `mcp_tools`/`mcp_call`, per-caller audience gates, wait timeouts with non-error timed-out results, the transcript-free user-message acknowledgement for providers that host it, text-only results for providers whose model reads structured content, plus the served tool specs for prompt-cost accounting.
 */
import type http from "node:http";

import { getParseErrorMessage, normalizeObjectSchema, safeParseAsync, type AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { createGitArcFailureFromError, formatGitArcFailureReceipt } from "workbench-shared/workbench/git/git-arc-failures";
import {
  ProviderToolMetadataSchema, ProviderToolResultSchema,
  type ProviderToolRequestContext, type WorkbenchPreparedShell, type WorkbenchShellRunResult,
  type WorkbenchToolTranscriptReference, type WorkbenchProviderTools,
} from "../providers/provider-execution";
import { ErrorCode, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";
import { WORKBENCH_MCP_SERVER_NAME } from "workbench-shared/workbench/mcp/mcp-server-settings";
import {
  BATCH_TURN_INTERRUPTION_TEXT, QUEUED_SHELL_STEER_INTERRUPTION_TEXT, SKIPPED_AFTER_FAILURE_TEXT,
} from "workbench-shared/workbench/thread/tool-batch-turn-results";
import { readWorkbenchMcpEndpointUrl } from "workbench-shared/workbench/mcp/workbench-mcp-endpoint";
import { adaptWorkbenchAgentCliResponse } from "../lib/workbench/cli/workbench-agent-cli-responses";
import type { DaemonReloadScopeDescriptor } from "workbench-shared/workbench/daemon-reload";
import { WORKBENCH_MCP_COMMANDS } from "../lib/workbench/commands/mcp-command-definitions";
import { listWorkbenchAgentCommands } from "../lib/workbench/commands/workbench-agent-command-registry";
import { formatWorkbenchToolSection } from "../mcp-servers/mcp-tool-search";
import {
  getWorkbenchAgentCommandToolName,
  isWorkbenchAgentCommandOnMcp,
  type WorkbenchAgentCommandDefinition,
  type WorkbenchAgentCommandRequest,
} from "../lib/workbench/commands/workbench-agent-command-definition";
import { listWorkbenchInstructionTools, type WorkbenchInstructionTool } from "../lib/workbench/instructions/instruction-tool-reference";
import { WORKBENCH_CODE_MODE_TOOL_META as CODE_MODE_META } from "workbench-shared/workbench/commands/workbench-tool-audience";
import {
  describeWorkbenchCommandRefusal,
  refuseWorkbenchCommand,
  refuseWorkbenchCommandCaller,
} from "../lib/workbench/commands/workbench-command-audience";
import { DEFAULT_WORKBENCH_LOCAL_CAPABILITY_SETTINGS } from "../lib/workbench/settings/WorkbenchServerSettings";
import type { WorkbenchLocalCapabilitySettings } from "workbench-shared/types";
import type { WorkbenchProviderCaller } from "../providers/provider-execution";
import {
  getWorkbenchShellAggregatedOutput,
  WORKBENCH_SHELL_MCP_TOOL_NAME,
  WORKBENCH_SHELL_STOP_MCP_TOOL_NAME,
  WORKBENCH_SHELL_WAIT_MCP_TOOL_NAME,
  WorkbenchShellCallResultSchema,
  WorkbenchShellResultSchema,
  WorkbenchYieldedShellInputSchema,
  type WorkbenchShellInput,
} from "workbench-shared/workbench/commands/workbench-shell-command";
import type { WorkbenchThreadId } from "workbench-shared/workbench/identity";
import { logError } from "../process-helpers";
import WorkbenchToolAdmissionController, { type WorkbenchToolAdmissionOptions } from "./WorkbenchToolAdmissionController";
import {
  getProcessWorkbenchAgentMcpRequestRegistry,
  isWorkbenchAgentMcpSteerInterruption,
  isWorkbenchAgentMcpShellStop,
  type WorkbenchAgentMcpRequestRegistry,
} from "./workbench-agent-mcp-request-registry";
import {
  linkWorkbenchMcpCallSignal,
  sanitizeWorkbenchMcpError as sanitizeError,
  sendWorkbenchMcpJsonRpcError as sendJsonRpcError,
  serveWorkbenchMcpHttpRequest,
  type WorkbenchMcpCallOutcome,
  type WorkbenchMcpDetachedCall,
  type WorkbenchMcpIngressCapabilities,
  type WorkbenchMcpProgressScheduler,
  type WorkbenchMcpScope,
  type WorkbenchMcpToolCall,
  type WorkbenchMcpToolGeneration,
  type WorkbenchMcpToolStep,
} from "./workbench-mcp-ingress";
import {
  createWorkbenchMcpWaitDeadline,
  getWorkbenchMcpCommandInputSchema,
  getWorkbenchMcpShellInputSchema,
  getWorkbenchMcpShellOutputSchema,
  getWorkbenchMcpShellWaitInputSchema,
  isWorkbenchMcpWaitTimeout,
  readWorkbenchMcpInputShape,
  resolveWorkbenchMcpWorkdir,
  splitWorkbenchMcpWaitTimeout,
  type WorkbenchMcpInputShape,
} from "./workbench-mcp-tool-inputs";
import {
  WORKBENCH_USER_MESSAGE_DELIVERED, WORKBENCH_USER_MESSAGE_TEXT_DESCRIPTION,
  WORKBENCH_USER_MESSAGE_TOOL_DESCRIPTION, WORKBENCH_USER_MESSAGE_TOOL_NAME,
} from "./workbench-user-message-tool";

const LEGACY_MCP_CLIENT_SCOPE = "legacy";
/** McpServer's schema for tools without an object input, so hand-served lists match what it served before. */
const EMPTY_OBJECT_JSON_SCHEMA = { type: "object" as const, properties: {} };
const STEER_INTERRUPTION_TEXT = "Wait interrupted: a new message arrived for this thread. Read it, then call this tool again if you still need to wait.";
const MCP_CLIENT_SCOPE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
type WorkbenchAgentMcpRequestId = number | string;
type WorkbenchAgentMcpRegisteredCommand = {
  registration: ReturnType<WorkbenchAgentMcpRequestRegistry["register"]>;
  signal: AbortSignal;
};

/** The provider's name for this call within its tool batch, when calls can wait their batch turn. */
function readToolUseKey(description: { toolUseIdMeta?: string }, shape: WorkbenchMcpInputShape, call: WorkbenchMcpToolCall) {
  if (!shape.parallelShells) return null;
  const key = call.meta?.[description.toolUseIdMeta!];
  return typeof key === "string" && key ? key : null;
}

function waitTimeoutText(toolName: string) {
  return `Wait timed out with nothing ready. Do other work, then call ${toolName} again to keep waiting.`;
}

export interface WorkbenchAgentMcpControllerOptions {
  isSubagentCaller?: (caller: WorkbenchProviderCaller) => Promise<boolean>;
  /** Live local capability settings; capability-gated deferred tools are found and run only while enabled. */
  readLocalCapabilities?: () => Promise<WorkbenchLocalCapabilitySettings>;
  /** Whether the caller works at the Workbench repository root, the only audience of root-only commands. */
  isWorkbenchRootCaller?: (caller: WorkbenchProviderCaller) => boolean;
  tools: (provider: string) => WorkbenchProviderTools;
  /** Workbench approval for outside-sandbox commands on the Workbench-hosted shell. */
  approveHostedShell?: WorkbenchToolAdmissionOptions["approve"];
  /** Defaults to the registry's generation-reentrant executor; tests inject their own. */
  executeCommand?: (request: WorkbenchAgentCommandRequest, signal: AbortSignal) => Promise<Response>;
  /** Defaults to the registry's exec-node shell runner; tests inject their own. */
  executeShell?: WorkbenchMcpDetachedCall["executeShell"];
  getReloadScopeCatalog?: () => readonly DaemonReloadScopeDescriptor[];
  /** Read per request so the catalogue follows the virtual repository runtime as it appears or disappears. */
  virtualReposAvailable?: () => boolean;
  lifecycleLogError?: (name: string, message: string) => void;
  daemonOrigin: string;
  requestRegistry?: WorkbenchAgentMcpRequestRegistry;
  scheduleProgress?: WorkbenchMcpProgressScheduler;
  /** Defaults to a platform timeout signal; tests inject their own. */
  createWaitDeadline?: (timeoutMs: number) => AbortSignal;
}

function isLoopbackAddress(address: string | undefined) {
  if (!address) return false;
  const normalized = address.toLowerCase().split("%")[0];
  return normalized === "::1" || normalized === "127.0.0.1" || normalized.startsWith("127.") || normalized.startsWith("::ffff:127.");
}

/** McpServer's tool error shape: tool failures, unknown tools and invalid input all answer as error results. */
function toolError(error: unknown): CallToolResult {
  return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/** What a call is recorded as: the tool the agent named, even when `mcp_call` runs a deferred command. */
type ToolTranscriptIdentity = { tool: string; input: object };

const [MCP_TOOLS_COMMAND, MCP_REQUEST_COMMAND, MCP_CALL_COMMAND] = WORKBENCH_MCP_COMMANDS;
/** The `mcp_*` fields that decide whether a call targets Workbench's own deferred tools. */
const McpRoutingFieldsSchema = z.object({
  arguments: z.record(z.string(), z.unknown()).optional(),
  query: z.string().optional(),
  server: z.string().optional(),
  tool: z.string().optional(),
});

/** McpServer's input validation, reproduced for hand-served tools. */
async function validateToolInput(schema: AnySchema, args: unknown, toolName: string) {
  const parsed = await safeParseAsync(normalizeObjectSchema(schema) ?? schema, args);
  if (!parsed.success) {
    throw new McpError(ErrorCode.InvalidParams,
      `Input validation error: Invalid arguments for tool ${toolName}: ${getParseErrorMessage("error" in parsed ? parsed.error : "Unknown error")}`);
  }
  return parsed.data;
}

/** McpServer's output validation for tools that declare an output schema. */
async function validateToolOutput(schema: AnySchema, result: CallToolResult, toolName: string) {
  if (result.isError) return;
  if (!result.structuredContent) {
    throw new McpError(ErrorCode.InvalidParams, `Output validation error: Tool ${toolName} has an output schema but no structured content was provided`);
  }
  const parsed = await safeParseAsync(normalizeObjectSchema(schema)!, result.structuredContent);
  if (!parsed.success) {
    throw new McpError(ErrorCode.InvalidParams,
      `Output validation error: Invalid structured content for tool ${toolName}: ${getParseErrorMessage("error" in parsed ? parsed.error : "Unknown error")}`);
  }
}

function toolJsonSchema(schema: AnySchema, pipeStrategy: "input" | "output") {
  const object = normalizeObjectSchema(schema);
  return object ? toJsonSchemaCompat(object, { strictUnions: true, pipeStrategy }) : EMPTY_OBJECT_JSON_SCHEMA;
}

/**
 * Every listing converts every tool's schema, and input builders return fresh zod objects per call, so conversions are
 * kept per owner (a command definition or a fixed tool) and input shape. Listed schemas are only serialized, never mutated.
 */
const listedJsonSchemas = new WeakMap<object, Map<string, ReturnType<typeof toolJsonSchema>>>();
function listedJsonSchema(owner: object, shape: WorkbenchMcpInputShape, pipeStrategy: "input" | "output", build: () => AnySchema) {
  const key = `${pipeStrategy}:${shape.parallelShells}:${shape.waitTimeouts}:${shape.shellYields}`;
  let byShape = listedJsonSchemas.get(owner);
  if (!byShape) listedJsonSchemas.set(owner, byShape = new Map());
  let schema = byShape.get(key);
  if (!schema) byShape.set(key, schema = toolJsonSchema(build(), pipeStrategy));
  return schema;
}
const SHELL_SCHEMA_OWNER = {};

const UserMessageInputSchema = z.object({ text: z.string().describe(WORKBENCH_USER_MESSAGE_TEXT_DESCRIPTION) }).strict();
const USER_MESSAGE_TOOL: Tool = {
  name: WORKBENCH_USER_MESSAGE_TOOL_NAME,
  description: WORKBENCH_USER_MESSAGE_TOOL_DESCRIPTION,
  inputSchema: toolJsonSchema(UserMessageInputSchema, "input") as Tool["inputSchema"],
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false, readOnlyHint: true },
};

const SHELL_WAIT_TOOL: Tool = {
  name: WORKBENCH_SHELL_WAIT_MCP_TOOL_NAME,
  description: "Wait for a shell that yield_ms backgrounded, then return its result. Workbench Long Wait; steers interrupt it.",
  inputSchema: toolJsonSchema(getWorkbenchMcpShellWaitInputSchema(), "input") as Tool["inputSchema"],
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false, readOnlyHint: true },
  _meta: CODE_MODE_META,
};

const SHELL_STOP_TOOL: Tool = {
  name: WORKBENCH_SHELL_STOP_MCP_TOOL_NAME,
  description: "Stop a shell that yield_ms backgrounded, then return its final result like shell_wait.",
  inputSchema: toolJsonSchema(WorkbenchYieldedShellInputSchema, "input") as Tool["inputSchema"],
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false, readOnlyHint: false },
  _meta: CODE_MODE_META,
};

function readClientScope(value: string | null) {
  if (!value) return LEGACY_MCP_CLIENT_SCOPE;
  if (!MCP_CLIENT_SCOPE_PATTERN.test(value)) throw new Error("Workbench MCP client scope is invalid.");
  return value.toLowerCase();
}

export default class WorkbenchAgentMcpController implements WorkbenchMcpToolGeneration {
  private readonly executeCommand: NonNullable<WorkbenchAgentMcpControllerOptions["executeCommand"]>;
  /** Injected executor only; detached waits otherwise re-enter the registry without capturing this generation. */
  private readonly injectedExecuteCommand: WorkbenchAgentMcpControllerOptions["executeCommand"];
  private readonly getReloadScopeCatalog: NonNullable<WorkbenchAgentMcpControllerOptions["getReloadScopeCatalog"]>;
  private readonly virtualReposAvailable: NonNullable<WorkbenchAgentMcpControllerOptions["virtualReposAvailable"]>;
  private readonly lifecycleLogError: NonNullable<WorkbenchAgentMcpControllerOptions["lifecycleLogError"]>;
  private readonly daemonOrigin: string;
  private readonly requestRegistry: WorkbenchAgentMcpRequestRegistry;
  private readonly injectedScheduleProgress: WorkbenchAgentMcpControllerOptions["scheduleProgress"];
  private readonly tools: WorkbenchAgentMcpControllerOptions["tools"];
  private readonly approveHostedShell: WorkbenchAgentMcpControllerOptions["approveHostedShell"];
  /** Injected runner only; detached shells otherwise run through the registry's exec-node runner. */
  private readonly injectedExecuteShell: WorkbenchAgentMcpControllerOptions["executeShell"];
  private readonly runtimeOwner = {};
  private readonly isSubagentCaller: NonNullable<WorkbenchAgentMcpControllerOptions["isSubagentCaller"]>;
  private readonly isWorkbenchRootCaller: NonNullable<WorkbenchAgentMcpControllerOptions["isWorkbenchRootCaller"]>;
  private readonly readLocalCapabilities: NonNullable<WorkbenchAgentMcpControllerOptions["readLocalCapabilities"]>;
  private readonly createWaitDeadline: NonNullable<WorkbenchAgentMcpControllerOptions["createWaitDeadline"]>;

  constructor({
    executeCommand,
    executeShell,
    getReloadScopeCatalog = () => [],
    virtualReposAvailable = () => false,
    lifecycleLogError = logError,
    daemonOrigin,
    tools,
    approveHostedShell,
    requestRegistry = getProcessWorkbenchAgentMcpRequestRegistry(),
    scheduleProgress,
    isSubagentCaller = async () => false,
    isWorkbenchRootCaller = () => false,
    readLocalCapabilities = async () => DEFAULT_WORKBENCH_LOCAL_CAPABILITY_SETTINGS,
    createWaitDeadline = createWorkbenchMcpWaitDeadline,
  }: WorkbenchAgentMcpControllerOptions) {
    this.createWaitDeadline = createWaitDeadline;
    this.injectedExecuteCommand = executeCommand;
    this.executeCommand = executeCommand ?? (async (request, signal) => await requestRegistry.executeCommand(request, signal));
    this.getReloadScopeCatalog = getReloadScopeCatalog;
    this.virtualReposAvailable = virtualReposAvailable;
    this.lifecycleLogError = lifecycleLogError;
    this.daemonOrigin = daemonOrigin;
    this.requestRegistry = requestRegistry;
    this.injectedScheduleProgress = scheduleProgress;
    this.tools = tools;
    this.approveHostedShell = approveHostedShell;
    this.injectedExecuteShell = executeShell;
    this.isSubagentCaller = isSubagentCaller;
    this.isWorkbenchRootCaller = isWorkbenchRootCaller;
    this.readLocalCapabilities = readLocalCapabilities;
  }

  beginRuntimeDrain() {
    return this.requestRegistry.beginRuntimeDrain(
      this.runtimeOwner,
      "immediate",
      "Workbench MCP tool call was cancelled because its runtime generation is reloading.",
    );
  }

  expireRuntimeDrain() {
    return this.requestRegistry.beginRuntimeDrain(
      this.runtimeOwner,
      "deadline",
      "Workbench MCP tool call exceeded the runtime-drain deadline.",
    );
  }

  listRuntimeDrainPending() {
    return this.requestRegistry.listRuntimeDrainPending(this.runtimeOwner);
  }

  releaseRuntimeOwner() {
    this.requestRegistry.releaseToolGeneration(this.runtimeOwner);
    this.requestRegistry.releaseRuntimeOwner(this.runtimeOwner);
  }

  /** Serve every MCP request step, including steps of waits that an earlier generation accepted. */
  activateToolGeneration() {
    this.requestRegistry.activateToolGeneration(this.runtimeOwner, this);
  }

  async handleHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      sendJsonRpcError(response, 403, "Workbench MCP is available only over loopback.");
      return;
    }
    if (request.method !== "POST") {
      sendJsonRpcError(response, 405, "Method not allowed.");
      return;
    }

    const endpoint = readWorkbenchMcpEndpointUrl(new URL(request.url ?? "/", "http://localhost"));
    let scope: WorkbenchMcpScope;
    try {
      const clientScope = readClientScope(endpoint.client);
      const { provider } = endpoint;
      if (!provider) throw new Error("Workbench MCP requires a provider selector.");
      this.tools(provider);
      scope = { clientScope, provider, projectLocal: endpoint.projectLocal, subagent: endpoint.subagent };
    } catch (error) {
      sendJsonRpcError(response, 400, sanitizeError(error) || "Workbench MCP client scope is invalid.");
      return;
    }
    // The ingress owns the accepted request and resolves the current generation for each of its steps.
    serveWorkbenchMcpHttpRequest(request, response, {
      logError: this.lifecycleLogError, registry: this.requestRegistry, scope,
      ...(this.injectedScheduleProgress ? { scheduleProgress: this.injectedScheduleProgress } : {}),
    });
  }

  /**
   * Commands one audience may use, in catalogue order: preloaded tools, and deferred ones found and run through
   * `mcp_tools`/`mcp_call` on server `wb`. Deferred search mirrors CLI help, so root-help-hidden commands stay out.
   * Duplicate names are a catalogue defect. Null capabilities leave capability gates to call admission; only deferred
   * commands carry them, so preloaded lists never depend on settings.
   */
  private visibleCommands(scope: WorkbenchMcpScope, capabilities: WorkbenchLocalCapabilitySettings | null = null) {
    const names = new Set<string>([
      WORKBENCH_SHELL_MCP_TOOL_NAME, WORKBENCH_SHELL_WAIT_MCP_TOOL_NAME, WORKBENCH_SHELL_STOP_MCP_TOOL_NAME, WORKBENCH_USER_MESSAGE_TOOL_NAME,
    ]);
    const direct = new Map<string, WorkbenchAgentCommandDefinition>();
    const deferred = new Map<string, WorkbenchAgentCommandDefinition>();
    const audience = { harness: scope.provider, subagent: scope.subagent, workbenchRoot: scope.projectLocal, capabilities };
    for (const definition of this.listCommands()) {
      const name = getWorkbenchAgentCommandToolName(definition);
      if (refuseWorkbenchCommand(definition, audience)) continue;
      if (!isWorkbenchAgentCommandOnMcp(definition)) continue;
      if (names.has(name)) throw new Error(`Duplicate Workbench MCP tool name: ${name}`);
      names.add(name);
      (definition.mcpDeferred ? deferred : direct).set(name, definition);
    }
    return { deferred, direct };
  }

  /** The preloaded audience: a connection serving many threads lists every thread's tools and gates each caller. */
  private listingScope(scope: WorkbenchMcpScope, description: { connectionSpansThreads?: boolean }): WorkbenchMcpScope {
    return description.connectionSpansThreads ? { ...scope, projectLocal: true } : scope;
  }

  /** Deferred commands the resolved caller may find, whatever audience its connection declared. */
  private async callerDeferredCommands(scope: WorkbenchMcpScope, call: WorkbenchMcpToolCall, tools: WorkbenchProviderTools) {
    const caller = await tools.caller(ProviderToolMetadataSchema.parse(call.meta ?? {}), call.signal, { clientScope: scope.clientScope });
    return this.visibleCommands({
      ...scope,
      projectLocal: this.isWorkbenchRootCaller(caller),
      subagent: scope.subagent || await this.isSubagentCaller(caller),
    }, await this.readLocalCapabilities()).deferred;
  }

  private toolSpec(name: string, definition: WorkbenchAgentCommandDefinition, shape: WorkbenchMcpInputShape): Tool & { description: string } {
    return {
      name,
      description: `${definition.description}\n\nCLI equivalent: ${definition.usage}`,
      inputSchema: listedJsonSchema(definition, shape, "input",
        () => getWorkbenchMcpCommandInputSchema(definition, shape)) as Tool["inputSchema"],
      annotations: {
        destructiveHint: definition.effects.destructive ?? false,
        idempotentHint: definition.effects.idempotent ?? false,
        openWorldHint: definition.effects.openWorld ?? false,
        readOnlyHint: definition.effects.readOnly ?? false,
      },
      ...(definition.mcpCodeModeEligible ? { _meta: CODE_MODE_META } : {}),
    };
  }

  async describe(scope: WorkbenchMcpScope, signal: AbortSignal, ingress?: WorkbenchMcpIngressCapabilities) {
    const description = await this.tools(scope.provider).describe();
    signal.throwIfAborted();
    const shape = readWorkbenchMcpInputShape(description, ingress ?? {});
    const tools: Tool[] = [{
      name: WORKBENCH_SHELL_MCP_TOOL_NAME,
      description: description.shellDescription,
      inputSchema: listedJsonSchema(SHELL_SCHEMA_OWNER, shape, "input", () => getWorkbenchMcpShellInputSchema(shape)) as Tool["inputSchema"],
      // Clients overlap only read-only tools; ordered shell turns keep unmarked shells serial regardless.
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false, readOnlyHint: shape.parallelShells },
      outputSchema: listedJsonSchema(SHELL_SCHEMA_OWNER, shape, "output", () => getWorkbenchMcpShellOutputSchema(shape)) as Tool["outputSchema"],
      _meta: CODE_MODE_META,
    }];
    if (shape.shellYields) tools.push(SHELL_WAIT_TOOL, SHELL_STOP_TOOL);
    if (description.hostsUserMessage) tools.push(USER_MESSAGE_TOOL);
    for (const [name, definition] of this.visibleCommands(this.listingScope(scope, description)).direct) {
      tools.push(this.toolSpec(name, definition, shape));
    }
    return { tools };
  }

  async call(scope: WorkbenchMcpScope, call: WorkbenchMcpToolCall): Promise<WorkbenchMcpToolStep> {
    const step = await this.step(scope, call);
    return step.kind === "result" ? { ...step, result: await this.wireResult(scope, call.name, step.result) } : step;
  }

  /**
   * Providers whose model reads structured content instead of text get only the text, which carries every agent-facing
   * line; transcripts already recorded both. The shell declares an output schema, so its structured result stays.
   */
  private async wireResult(scope: WorkbenchMcpScope, toolName: string, result: CallToolResult): Promise<CallToolResult> {
    if (toolName === WORKBENCH_SHELL_MCP_TOOL_NAME || result.structuredContent === undefined) return result;
    if (!(await this.tools(scope.provider).describe()).modelReadsStructuredContent) return result;
    const { structuredContent: _transcriptOnly, ...text } = result;
    return text;
  }

  private async step(scope: WorkbenchMcpScope, call: WorkbenchMcpToolCall): Promise<WorkbenchMcpToolStep> {
    const tools = this.tools(scope.provider);
    try {
      const description = await tools.describe();
      const shape = readWorkbenchMcpInputShape(description, call);
      if (call.name === WORKBENCH_SHELL_MCP_TOOL_NAME) {
        const toolUseKey = readToolUseKey(description, shape, call);
        const shellInputSchema = getWorkbenchMcpShellInputSchema(shape);
        const input: WorkbenchShellInput & { parallel?: boolean; yield_ms?: number } = shellInputSchema.parse(
          await validateToolInput(shellInputSchema, call.arguments, call.name),
        );
        // A serial shell waits for its batch's earlier calls before anything about it is recorded or approved.
        if (toolUseKey && input.parallel !== true) {
          const turn = await this.batchTurn(scope, call, tools, toolUseKey, call.name, input);
          if (turn) return turn;
        }
        return await this.callShell(scope, call, input, tools);
      }
      if (call.name === WORKBENCH_SHELL_WAIT_MCP_TOOL_NAME && shape.shellYields) return await this.collectShell(scope, call, tools, false);
      if (call.name === WORKBENCH_SHELL_STOP_MCP_TOOL_NAME && shape.shellYields) return await this.collectShell(scope, call, tools, true);
      if (call.name === WORKBENCH_USER_MESSAGE_TOOL_NAME && description.hostsUserMessage) {
        await validateToolInput(UserMessageInputSchema, call.arguments, call.name);
        return { kind: "result", result: { content: [{ type: "text", text: WORKBENCH_USER_MESSAGE_DELIVERED }] } };
      }
      const { direct } = this.visibleCommands(this.listingScope(scope, description));
      // `mcp_call` reaches root-only and capability-gated commands from any connection; `prepareCommand` gates each caller.
      const { deferred } = this.visibleCommands({ ...scope, projectLocal: true });
      const definition = direct.get(call.name);
      if (!definition) throw new McpError(ErrorCode.InvalidParams, `Tool ${call.name} not found`);
      const input = await validateToolInput(getWorkbenchMcpCommandInputSchema(definition, shape), call.arguments, call.name) as object;
      const routing = McpRoutingFieldsSchema.parse(input);
      const workbenchServer = routing.server === WORKBENCH_MCP_SERVER_NAME;
      const transcript = { tool: call.name, input };
      if (definition === MCP_TOOLS_COMMAND && (workbenchServer || (!routing.server && deferred.size))) {
        const findable = await this.callerDeferredCommands(scope, call, tools);
        const section = formatWorkbenchToolSection([...findable].map(([name, tool]) => this.toolSpec(name, tool, shape)), routing.query);
        const result = workbenchServer
          ? await this.observeTool(call.name, input, call.meta, scope.clientScope, call.signal, tools, async () => textResult(section))
          : await this.callTool(definition, input, call.meta, scope.clientScope, call.requestId, call.signal, tools, {
            decorate: listed => ({ ...listed, content: [...listed.content, { type: "text", text: section }] }),
          });
        return { kind: "result", result };
      }
      if (definition === MCP_REQUEST_COMMAND && workbenchServer) {
        return {
          kind: "result",
          result: await this.observeTool(call.name, input, call.meta, scope.clientScope, call.signal, tools, async () => ({
            ...textResult(`Workbench tools need no enabling; call them with mcp_call on server ${WORKBENCH_MCP_SERVER_NAME}.`), isError: true,
          })),
        };
      }
      const target = definition === MCP_CALL_COMMAND && workbenchServer
        ? await this.deferredTarget(deferred, routing, shape)
        : { definition, input };
      // The provider's call id orders this call in its tool batch; the provider reports each call's result there.
      const toolUseKey = call.batchTurns && !target.definition.effects.readOnly ? readToolUseKey(description, shape, call) : null;
      if (toolUseKey) {
        const turn = await this.batchTurn(scope, call, tools, toolUseKey, getWorkbenchAgentCommandToolName(target.definition), input);
        if (turn) return turn;
      }
      const { input: commandInput, timeoutMs } = splitWorkbenchMcpWaitTimeout(target.definition, shape, target.input);
      if (target.definition.mcpRuntimeDrainPolicy === "preserve-across-reload") {
        return await this.detachTool(target.definition, commandInput, timeoutMs, call, scope.clientScope, tools, transcript);
      }
      return {
        kind: "result",
        result: await this.callTool(target.definition, commandInput, call.meta, scope.clientScope, call.requestId, call.signal, tools, { transcript }),
      };
    } catch (error) {
      return { kind: "result", result: toolError(error) };
    }
  }

  /** Null once the call's batch turn is ready; otherwise the wait step, or the skipped or interrupted result. */
  private async batchTurn(
    scope: WorkbenchMcpScope, call: WorkbenchMcpToolCall, tools: WorkbenchProviderTools, key: string, toolName: string, input: object,
  ): Promise<WorkbenchMcpToolStep | null> {
    if (!call.batchTurn) return { kind: "batchTurn", key, toolName };
    if (call.batchTurn === "ready") return null;
    const text = call.batchTurn === "skipped" ? SKIPPED_AFTER_FAILURE_TEXT : BATCH_TURN_INTERRUPTION_TEXT;
    return {
      kind: "result",
      result: await this.observeTool(call.name, input, call.meta, scope.clientScope, call.signal, tools,
        async () => ({ content: [{ type: "text", text }], isError: true })),
    };
  }

  private async deferredTarget(
    deferred: ReadonlyMap<string, WorkbenchAgentCommandDefinition>, routing: z.infer<typeof McpRoutingFieldsSchema>,
    shape: WorkbenchMcpInputShape,
  ) {
    const name = routing.tool ?? "";
    const definition = deferred.get(name);
    if (!definition) {
      throw new McpError(ErrorCode.InvalidParams,
        `${WORKBENCH_MCP_SERVER_NAME}/${name} is not a deferred Workbench tool. Find one with mcp_tools on server ${WORKBENCH_MCP_SERVER_NAME}.`);
    }
    const input = await validateToolInput(
      getWorkbenchMcpCommandInputSchema(definition, shape), routing.arguments ?? {}, `${WORKBENCH_MCP_SERVER_NAME}/${name}`,
    ) as object;
    return { definition, input };
  }

  /**
   * Long waits only prepare here; the ingress awaits them outside this generation, and whichever generation is
   * current when they end formats and records the outcome.
   */
  private async detachTool(
    definition: WorkbenchAgentCommandDefinition, input: object, timeoutMs: number | null, call: WorkbenchMcpToolCall,
    clientScope: string, tools: WorkbenchProviderTools, transcript: ToolTranscriptIdentity,
  ): Promise<WorkbenchMcpToolStep> {
    const toolName = getWorkbenchAgentCommandToolName(definition);
    let registered: WorkbenchAgentMcpRegisteredCommand;
    try {
      registered = this.registerCommand(definition, clientScope, call.requestId, call.signal, timeoutMs);
    } catch (error) {
      return { kind: "result", result: this.commandFailure(definition, error, call.signal) };
    }
    const started = await this.startTranscript(transcript.tool, transcript.input, call.meta, clientScope, registered.signal, tools);
    if (started.kind === "failed") {
      registered.registration.unregister();
      return { kind: "result", result: started.result };
    }
    try {
      if (started.reference) registered.registration.setWorkbenchThreadId(started.reference.threadId);
    } catch (error) {
      registered.registration.unregister();
      const result = this.commandFailure(definition, error, registered.signal);
      return { kind: "result", result: await this.finishTranscript(tools, started.reference, result) };
    }
    if (registered.signal.aborted) {
      registered.registration.unregister();
      const result = this.commandFailure(definition, registered.signal.reason, registered.signal);
      return { kind: "result", result: await this.finishTranscript(tools, started.reference, result) };
    }
    const prepared = await this.prepareCommand(
      definition, input, call.meta, clientScope, call.requestId, registered.signal, tools, registered,
    );
    if (prepared.kind === "result") {
      prepared.unregister?.();
      return { kind: "result", result: await this.finishTranscript(tools, started.reference, prepared.result) };
    }
    return {
      kind: "detached",
      call: {
        ...(this.injectedExecuteCommand ? { execute: this.injectedExecuteCommand } : {}),
        request: prepared.request,
        signal: prepared.signal,
        toolName,
        transcript: started.reference,
        unregister: prepared.unregister,
      },
    };
  }

  private registerCommand(
    definition: WorkbenchAgentCommandDefinition,
    clientScope: string,
    requestId: WorkbenchAgentMcpRequestId,
    signal: AbortSignal,
    timeoutMs: number | null = null,
  ): WorkbenchAgentMcpRegisteredCommand {
    const registration = this.requestRegistry.register(clientScope, requestId, {
      owner: this.runtimeOwner,
      policy: definition.mcpRuntimeDrainPolicy,
      steerInterruptible: definition.mcpSteerInterruptible,
      toolName: getWorkbenchAgentCommandToolName(definition),
    });
    // The ingress keeps this signal across reloads, so the deadline runs from the original call.
    const deadline = timeoutMs === null ? [] : [this.createWaitDeadline(timeoutMs)];
    return { registration, signal: AbortSignal.any([signal, registration.signal, ...deadline]) };
  }

  async finish(scope: WorkbenchMcpScope, call: WorkbenchMcpDetachedCall, outcome: WorkbenchMcpCallOutcome, yieldedShellId?: string) {
    const tools = this.tools(scope.provider);
    let result: CallToolResult;
    if (call.shell) {
      result = "shellResult" in outcome
        ? await this.shellResult(call.shell, outcome.shellResult)
        : this.shellFailure("error" in outcome ? outcome.error : new Error("The shell finished without a result."), call.signal);
    } else if (call.collect) {
      result = "collected" in outcome
        ? outcome.collected
        : this.shellWaitFailure("error" in outcome ? outcome.error : new Error("The wait finished without a result."), call.signal);
    } else {
      const definition = this.listCommands().find(candidate => getWorkbenchAgentCommandToolName(candidate) === call.toolName);
      result = "response" in outcome
        ? await this.commandResult(call.request, outcome.response)
        : this.commandFailure(definition, "error" in outcome ? outcome.error : new Error("The command finished without a response."), call.signal);
    }
    // Only the row learns it yielded: the transcript cannot record the yield itself, so its finish keeps that fact.
    const recorded = yieldedShellId
      ? { ...result, structuredContent: { ...result.structuredContent, shellId: yieldedShellId } }
      : result;
    const finished = await this.finishTranscript(tools, call.transcript as WorkbenchToolTranscriptReference | null, recorded, result);
    return call.shell ? finished : await this.wireResult(scope, call.toolName, finished);
  }

  /** The row stays running; only the call answers, with the output so far and the id `shell_wait` collects. */
  async yielded(_scope: WorkbenchMcpScope, call: WorkbenchMcpDetachedCall, shellId: string, outputTail: string): Promise<CallToolResult> {
    if (!call.shell) throw new Error("Only a shell call can yield.");
    const result: CallToolResult = {
      content: [{
        type: "text",
        text: `Still running as shell ${shellId}. Output so far:\n${outputTail}\n`
          + `Call ${WORKBENCH_SHELL_WAIT_MCP_TOOL_NAME} with this shellId to collect the result. It stops when your turn ends.`,
      }],
      isError: false,
      structuredContent: { cwd: call.shell.cwd, exitCode: null, shell: call.shell.shell, shellId, stderr: "", stdout: outputTail },
    };
    try {
      await validateToolOutput(WorkbenchShellCallResultSchema, result, WORKBENCH_SHELL_MCP_TOOL_NAME);
      return result;
    } catch (error) {
      return toolError(error);
    }
  }

  /**
   * `shell_wait` and `shell_stop` are long waits: steers interrupt them, `shell_wait`'s `timeoutMs` ends it, and they
   * outlive reloads. Only the caller's own thread can stop or collect a shell, so the caller resolves before the wait
   * detaches; `shell_stop` stops the shell first, then collects its stopped (or already finished) result.
   */
  private async collectShell(
    scope: WorkbenchMcpScope, call: WorkbenchMcpToolCall, tools: WorkbenchProviderTools, stop: boolean,
  ): Promise<WorkbenchMcpToolStep> {
    const schema = stop ? WorkbenchYieldedShellInputSchema : getWorkbenchMcpShellWaitInputSchema();
    const input: { shellId: string; timeoutMs?: number } = schema.parse(await validateToolInput(schema, call.arguments, call.name));
    const started = await this.startTranscript(call.name, input, call.meta, scope.clientScope, call.signal, tools);
    if (started.kind === "failed") return { kind: "result", result: started.result };
    let registration: ReturnType<WorkbenchAgentMcpRequestRegistry["register"]>;
    try {
      registration = this.requestRegistry.register(scope.clientScope, call.requestId, {
        owner: this.runtimeOwner, policy: "preserve-across-reload", steerInterruptible: true, toolName: call.name,
      });
    } catch (error) {
      return { kind: "result", result: await this.finishTranscript(tools, started.reference, this.shellWaitFailure(error, call.signal)) };
    }
    const deadline = input.timeoutMs === undefined ? [] : [this.createWaitDeadline(input.timeoutMs)];
    const signal = AbortSignal.any([call.signal, registration.signal, ...deadline]);
    let threadId: WorkbenchThreadId;
    try {
      threadId = (await tools.caller(ProviderToolMetadataSchema.parse(call.meta ?? {}), signal, { clientScope: scope.clientScope })).threadId;
      registration.setWorkbenchThreadId(threadId);
    } catch (error) {
      registration.unregister();
      return { kind: "result", result: await this.finishTranscript(tools, started.reference, this.shellWaitFailure(error, signal)) };
    }
    if (stop) this.requestRegistry.stopYieldedShell(threadId, input.shellId);
    registration.markDrainIndependent();
    return {
      kind: "detached",
      call: {
        collect: { shellId: input.shellId, threadId },
        signal, toolName: call.name, transcript: started.reference,
        unregister: registration.unregister,
      },
    };
  }

  /** A missing or foreign shell id is the agent's mistake, not a Workbench failure, so it is not logged. */
  private shellWaitFailure(error: unknown, signal: AbortSignal): CallToolResult {
    return this.expectedWaitEnd(WORKBENCH_SHELL_WAIT_MCP_TOOL_NAME, error, signal)
      ?? { content: [{ type: "text", text: sanitizeError(error) || "Workbench shell wait failed." }], isError: true };
  }

  /** A steer or the caller's own `timeoutMs` ending a wait is expected, not a failure. */
  private expectedWaitEnd(toolName: string, error: unknown, signal: AbortSignal): CallToolResult | null {
    if (isWorkbenchAgentMcpSteerInterruption(error)) {
      // Expected, not a failure: an empty error result reaches agents as an opaque "Unknown error".
      return {
        content: [{ type: "text" as const, text: STEER_INTERRUPTION_TEXT }],
        isError: false,
        structuredContent: { kind: "interruptedBySteer", version: 1 },
      };
    }
    if (signal.aborted && error === signal.reason && isWorkbenchMcpWaitTimeout(error)) {
      return {
        content: [{ type: "text" as const, text: waitTimeoutText(toolName) }],
        isError: false,
        structuredContent: { kind: "timedOut", version: 1 },
      };
    }
    return null;
  }

  /**
   * Shells only prepare here: the ingress runs the command through the exec node, so neither an approval wait nor a
   * running command holds this generation or any provider generation. An older ingress gets the same steps inline.
   */
  private async callShell(
    scope: WorkbenchMcpScope, call: WorkbenchMcpToolCall, input: WorkbenchShellInput & { yield_ms?: number },
    tools: WorkbenchProviderTools,
  ): Promise<WorkbenchMcpToolStep> {
    const started = await this.startTranscript("shell", input, call.meta, scope.clientScope, call.signal, tools);
    if (started.kind === "failed") return { kind: "result", result: started.result };
    const finishFailure = async (error: unknown, signal: AbortSignal): Promise<WorkbenchMcpToolStep> => ({
      kind: "result", result: await this.finishTranscript(tools, started.reference, this.shellFailure(error, signal)),
    });
    let registration: ReturnType<WorkbenchAgentMcpRequestRegistry["register"]>;
    // Workbench-recorded items are named by their item id; Codex records its own item, named by the call id it sends.
    const nativeCallId = typeof call.meta?.callId === "string" && call.meta.callId ? call.meta.callId : null;
    const shellItemReferences = [started.reference?.itemId, nativeCallId].filter((reference): reference is string => Boolean(reference));
    // Only an ingress that backgrounds shells may let the command stop following its call.
    const yields = call.shellYields === true && call.detachableShell === true && input.yield_ms !== undefined;
    try {
      registration = this.requestRegistry.register(scope.clientScope, call.requestId, {
        owner: this.runtimeOwner, steerInterruptible: false, toolName: "shell", yields,
        shellItem: { references: shellItemReferences, ...(started.reference ? { threadId: started.reference.threadId } : {}) },
      });
    } catch (error) {
      return await finishFailure(error, call.signal);
    }
    registration.markDrainIndependent();
    const caller = yields ? linkWorkbenchMcpCallSignal(call.signal) : null;
    const signal = AbortSignal.any([caller?.signal ?? call.signal, registration.signal]);
    let prepared: WorkbenchPreparedShell;
    try {
      prepared = await this.prepareShell(input, call.meta, {
        clientScope: scope.clientScope,
        ...(started.reference ? { itemId: started.reference.itemId, turnId: started.reference.turnId } : {}),
      }, signal, tools);
    } catch (error) {
      caller?.unlink();
      registration.unregister();
      return await finishFailure(error, signal);
    }
    const detached: WorkbenchMcpDetachedCall = {
      ...(this.injectedExecuteShell ? { executeShell: this.injectedExecuteShell } : {}),
      shell: prepared, signal, toolName: "shell", transcript: started.reference,
      unregister: registration.unregister,
      ...(registration.shellQueue ? { shellQueue: registration.shellQueue } : {}),
      // The yield clock starts once the command is admitted, so an approval wait never counts against it; a steer yields at once.
      ...(caller && input.yield_ms !== undefined
        ? {
          yieldSignal: AbortSignal.any([this.createWaitDeadline(input.yield_ms), ...(registration.earlyYield ? [registration.earlyYield] : [])]),
          unlinkCaller: caller.unlink,
        }
        : {}),
    };
    if (call.detachableShell) return { kind: "detached", call: detached };
    let outcome: WorkbenchMcpCallOutcome;
    try {
      const shellResult = this.injectedExecuteShell
        ? await this.injectedExecuteShell(prepared.run, signal, registration.shellQueue)
        : await this.requestRegistry.executeShell(prepared.run, signal, registration.shellQueue);
      outcome = signal.aborted ? { error: signal.reason } : { shellResult };
    } catch (error) {
      outcome = { error };
    } finally {
      registration.unregister();
    }
    return { kind: "result", result: await this.finish(scope, detached, outcome) };
  }

  /** Every shell call goes through Workbench admission; only leaving the sandbox needs the approval port. */
  private async prepareShell(
    input: WorkbenchShellInput, meta: Record<string, unknown> | undefined, context: ProviderToolRequestContext,
    signal: AbortSignal, tools: WorkbenchProviderTools,
  ) {
    const metadata = ProviderToolMetadataSchema.parse(meta ?? {});
    const approve = this.approveHostedShell ?? (async () => {
      throw new Error("Workbench approval is unavailable for outside-sandbox commands.");
    });
    return await WorkbenchToolAdmissionController.prepareShell({ tools, approve }, input, metadata, signal, context);
  }

  private async shellResult(shell: WorkbenchPreparedShell, run: WorkbenchShellRunResult): Promise<CallToolResult> {
    const structured = { ...run, cwd: shell.cwd, shell: shell.shell };
    const result: CallToolResult = {
      content: [{ type: "text", text: `Exit code: ${structured.exitCode}\nOutput:\n${getWorkbenchShellAggregatedOutput(structured)}` }],
      isError: false,
      structuredContent: structured,
    };
    try {
      await validateToolOutput(WorkbenchShellResultSchema, result, WORKBENCH_SHELL_MCP_TOOL_NAME);
      return result;
    } catch (error) {
      return toolError(error);
    }
  }

  private shellFailure(error: unknown, signal: AbortSignal): CallToolResult {
    // Expected, not a failure: a stop by the user or by the turn ending already names what happened, so it is the whole result.
    if (signal.aborted && isWorkbenchAgentMcpShellStop(signal.reason)) {
      return { content: [{ type: "text", text: (signal.reason as Error).message }], isError: true };
    }
    // Only a queued shell is steer-interruptible, so the command never ran; an error keeps it a readable failed command.
    if (signal.aborted && isWorkbenchAgentMcpSteerInterruption(signal.reason)) {
      return { content: [{ type: "text", text: QUEUED_SHELL_STEER_INTERRUPTION_TEXT }], isError: true };
    }
    const message = sanitizeError(error) || "Workbench shell tool call failed.";
    if (!signal.aborted || error !== signal.reason) this.lifecycleLogError("workbench-mcp", message);
    return { content: [{ type: "text", text: `Workbench shell failed: ${message}` }], isError: true };
  }

  private async callTool(
    definition: WorkbenchAgentCommandDefinition,
    input: object,
    meta: Record<string, unknown> | undefined,
    clientScope: string,
    requestId: WorkbenchAgentMcpRequestId,
    signal: AbortSignal,
    tools: WorkbenchProviderTools,
    {
      decorate = result => result,
      transcript = { tool: getWorkbenchAgentCommandToolName(definition), input },
    }: { decorate?: (result: CallToolResult) => CallToolResult; transcript?: ToolTranscriptIdentity } = {},
  ) {
    const execute = async () => decorate(await this.executeTool(definition, input, meta, clientScope, requestId, signal, tools));
    if (definition.hideMcpTranscript) {
      return this.observeTool(transcript.tool, {}, meta, clientScope, signal, tools, execute,
        result => ({ content: [], isError: result.isError === true }));
    }
    return this.observeTool(transcript.tool, transcript.input, meta, clientScope, signal, tools, execute);
  }

  private listCommands() {
    return listWorkbenchAgentCommands(this.getReloadScopeCatalog(), "agent", { virtualRepos: this.virtualReposAvailable() });
  }

  /** The exact tool list a root Workbench-project thread on this provider is served, for prompt-cost accounting. */
  async listToolSpecs(provider: string, signal: AbortSignal = new AbortController().signal) {
    return (await this.describe(
      { clientScope: LEGACY_MCP_CLIENT_SCOPE, projectLocal: true, provider, subagent: false }, signal, { batchTurns: true, shellYields: true },
    )).tools;
  }

  listInstructionTools(): WorkbenchInstructionTool[] {
    return listWorkbenchInstructionTools(this.listCommands());
  }

  private async observeTool(
    tool: string, input: object, meta: Record<string, unknown> | undefined, clientScope: string, signal: AbortSignal,
    tools: WorkbenchProviderTools, execute: (reference: WorkbenchToolTranscriptReference | null) => Promise<CallToolResult>,
    capture: (result: CallToolResult) => CallToolResult = result => result,
  ): Promise<CallToolResult> {
    const started = await this.startTranscript(tool, input, meta, clientScope, signal, tools);
    if (started.kind === "failed") return started.result;
    const result = await execute(started.reference);
    return await this.finishTranscript(tools, started.reference, capture(result), result);
  }

  private async startTranscript(
    tool: string, input: object, meta: Record<string, unknown> | undefined, clientScope: string, signal: AbortSignal,
    tools: WorkbenchProviderTools,
  ): Promise<{ kind: "started"; reference: WorkbenchToolTranscriptReference | null } | { kind: "failed"; result: CallToolResult }> {
    try {
      return {
        kind: "started",
        reference: tools.transcript ? await tools.transcript.start({
          tool, arguments: ProviderToolMetadataSchema.parse(input), metadata: ProviderToolMetadataSchema.parse(meta ?? {}),
        }, signal, { clientScope }) : null,
      };
    } catch (error) {
      this.lifecycleLogError("workbench-mcp", sanitizeError(error));
      return { kind: "failed", result: { content: [{ type: "text", text: "Tool was not executed because transcript admission failed." }], isError: true } };
    }
  }

  private async finishTranscript(
    tools: WorkbenchProviderTools,
    reference: WorkbenchToolTranscriptReference | null,
    capturedResult: CallToolResult,
    returnedResult: CallToolResult = capturedResult,
  ): Promise<CallToolResult> {
    if (!reference || !tools.transcript) return returnedResult;
    try {
      await tools.transcript.finish(reference, ProviderToolResultSchema.parse(capturedResult));
      return returnedResult;
    } catch (error) {
      this.lifecycleLogError("workbench-mcp", sanitizeError(error));
      return {
        ...returnedResult, isError: true,
        content: [...returnedResult.content, {
          type: "text",
          text: "Operation finished, but transcript recording failed. The original result is retained above. Do not retry the operation.",
        }],
      };
    }
  }

  private async executeTool(
    definition: WorkbenchAgentCommandDefinition,
    input: object,
    meta: Record<string, unknown> | undefined,
    clientScope: string,
    requestId: WorkbenchAgentMcpRequestId,
    signal: AbortSignal,
    tools: WorkbenchProviderTools,
  ): Promise<CallToolResult> {
    const prepared = await this.prepareCommand(definition, input, meta, clientScope, requestId, signal, tools);
    if (prepared.kind === "result") {
      prepared.unregister?.();
      return prepared.result;
    }
    try {
      const upstream = await this.executeCommand(prepared.request, prepared.signal);
      if (prepared.signal.aborted) throw prepared.signal.reason;
      return await this.commandResult(prepared.request, upstream);
    } catch (error) {
      return this.commandFailure(definition, error, prepared.signal);
    } finally {
      prepared.unregister();
    }
  }

  /** Register, resolve the caller and build the command; failures come back as finished results. */
  private async prepareCommand(
    definition: WorkbenchAgentCommandDefinition,
    input: object,
    meta: Record<string, unknown> | undefined,
    clientScope: string,
    requestId: WorkbenchAgentMcpRequestId,
    signal: AbortSignal,
    tools: WorkbenchProviderTools,
    registered?: WorkbenchAgentMcpRegisteredCommand,
  ): Promise<
    | { kind: "ready"; request: WorkbenchAgentCommandRequest; signal: AbortSignal; unregister: () => void }
    | { kind: "result"; result: CallToolResult; unregister?: () => void }
  > {
    let unregister: (() => void) | undefined;
    try {
      const toolName = getWorkbenchAgentCommandToolName(definition);
      const { registration, signal: registeredSignal } = registered
        ?? this.registerCommand(definition, clientScope, requestId, signal);
      unregister = registration.unregister;
      signal = registeredSignal;
      const caller = await tools.caller(ProviderToolMetadataSchema.parse(meta ?? {}), signal, { clientScope });
      if (signal.aborted) throw signal.reason;
      registration.setWorkbenchThreadId(caller.threadId);
      // Root status follows the thread's own cwd, never a `workdir`.
      const workbenchRoot = this.isWorkbenchRootCaller(caller);
      const refusal = await refuseWorkbenchCommandCaller(
        definition,
        { harness: caller.harness, workbenchRoot },
        { isSubagent: async () => await this.isSubagentCaller(caller), readCapabilities: this.readLocalCapabilities },
      );
      if (refusal) {
        return {
          kind: "result", unregister,
          result: { isError: true, content: [{ type: "text" as const, text: describeWorkbenchCommandRefusal(refusal, toolName, caller.harness) }] },
        };
      }
      const { input: commandInput, cwd } = await resolveWorkbenchMcpWorkdir(definition, input, caller.cwd);
      if (signal.aborted) throw signal.reason;
      const request = await definition.buildRequestFromJson(commandInput, {
        callerHarness: caller.harness,
        callerThreadId: caller.threadId,
        cwd,
        workbenchRoot,
        workbenchOrigin: this.daemonOrigin,
      });
      if (
        request.waitForReload
        || definition.mcpRuntimeDrainPolicy === "preserve-across-reload"
      ) {
        registration.markDrainIndependent();
      }
      return { kind: "ready", request, signal, unregister };
    } catch (error) {
      return { kind: "result", unregister, result: this.commandFailure(definition, error, signal) };
    }
  }

  private async commandResult(request: WorkbenchAgentCommandRequest, upstream: Response): Promise<CallToolResult> {
    const text = await upstream.text();
    const adapted = adaptWorkbenchAgentCliResponse({ httpOk: upstream.ok, request, text });
    const success = adapted.exitCode === 0;
    return {
      content: [{ type: "text" as const, text: success ? adapted.stdout : adapted.stderr }],
      isError: !success,
      ...(adapted.structuredContent ? { structuredContent: adapted.structuredContent } : {}),
    };
  }

  /** `definition` is absent only when a reload dropped the command between a wait's start and its end. */
  private commandFailure(definition: WorkbenchAgentCommandDefinition | undefined, error: unknown, signal: AbortSignal): CallToolResult {
    const ended = this.expectedWaitEnd(definition ? getWorkbenchAgentCommandToolName(definition) : "the same tool", error, signal);
    if (ended) return ended;
    const message = sanitizeError(error) || "Workbench MCP tool call failed.";
    if (!signal.aborted || error !== signal.reason) this.lifecycleLogError("workbench-mcp", message);
    if (definition?.words[0] === "git" && (definition.words[1] === "arc" || definition.words[1] === "plan")) {
      const failure = createGitArcFailureFromError("unknown", error);
      return {
        content: [{ type: "text" as const, text: formatGitArcFailureReceipt(failure) }],
        isError: true,
        structuredContent: { kind: "failure", version: 1, failure },
      };
    }
    return { content: [{ type: "text" as const, text: `Workbench tool call failed: ${message}` }], isError: true };
  }
}
