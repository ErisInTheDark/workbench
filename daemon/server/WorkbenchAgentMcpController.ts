/*
 * Exports:
 * - WorkbenchAgentMcpControllerOptions: inject trusted identity resolution, cancellation, hosted-shell approval, and command execution ports.
 * - default WorkbenchAgentMcpController: one MCP generation's short steps (list, call, finish) for typed wb tools, served through the thin ingress, plus the served tool specs for prompt-cost accounting.
 */
import type http from "node:http";

import { getParseErrorMessage, normalizeObjectSchema, safeParseAsync, type AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { createGitArcFailureFromError, formatGitArcFailureReceipt } from "workbench-shared/workbench/git/git-arc-failures";
import {
  ProviderToolMetadataSchema, ProviderToolResultSchema,
  type ProviderToolRequestContext, type WorkbenchPreparedShell, type WorkbenchShellRun, type WorkbenchShellRunResult,
  type WorkbenchToolTranscriptReference, type WorkbenchProviderTools,
} from "./provider-execution";
import { ErrorCode, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";

import { adaptWorkbenchAgentCliResponse } from "./lib/workbench/cli/workbench-agent-cli-responses";
import type { DaemonReloadScopeDescriptor } from "workbench-shared/workbench/daemon-reload";
import { listWorkbenchAgentCommands } from "./lib/workbench/commands/workbench-agent-command-registry";
import {
  getWorkbenchAgentCommandToolName,
  isWorkbenchAgentCommandVisibleTo,
  type WorkbenchAgentCommandDefinition,
  type WorkbenchAgentCommandRequest,
} from "./lib/workbench/commands/workbench-agent-command-definition";
import type { WorkbenchInstructionTool } from "./lib/workbench/instructions/instruction-tool-reference";
import { isWorkbenchToolVisibleTo } from "workbench-shared/workbench/commands/workbench-tool-audience";
import type { WorkbenchProviderCaller } from "./provider-execution";
import {
  getWorkbenchShellAggregatedOutput,
  WORKBENCH_SHELL_MCP_TOOL_NAME,
  WorkbenchEscalatingShellInputSchema,
  WorkbenchShellInputSchema,
  WorkbenchShellResultSchema,
  type WorkbenchEscalatingShellInput,
} from "workbench-shared/workbench/commands/workbench-shell-command";
import { logError } from "./process-helpers";
import WorkbenchToolAdmissionController, { type WorkbenchToolAdmissionOptions } from "./WorkbenchToolAdmissionController";
import {
  getProcessWorkbenchAgentMcpRequestRegistry,
  isWorkbenchAgentMcpSteerInterruption,
  isWorkbenchAgentMcpUserStop,
  type WorkbenchAgentMcpRequestRegistry,
} from "./workbench-agent-mcp-request-registry";
import {
  sanitizeWorkbenchMcpError as sanitizeError,
  scheduleWorkbenchMcpProgress,
  sendWorkbenchMcpJsonRpcError as sendJsonRpcError,
  serveWorkbenchMcpHttpRequest,
  type WorkbenchMcpCallOutcome,
  type WorkbenchMcpDetachedCall,
  type WorkbenchMcpScope,
  type WorkbenchMcpToolCall,
  type WorkbenchMcpToolGeneration,
  type WorkbenchMcpToolStep,
} from "./workbench-mcp-ingress";

const LEGACY_MCP_CLIENT_SCOPE = "legacy";
/** McpServer's schema for tools without an object input, so hand-served lists match what it served before. */
const EMPTY_OBJECT_JSON_SCHEMA = { type: "object" as const, properties: {} };
const STEER_INTERRUPTION_TEXT = "Wait interrupted: a new message arrived for this thread. Read it, then call this tool again if you still need to wait.";
const MCP_CLIENT_SCOPE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
type WorkbenchAgentMcpRequestId = number | string;

export interface WorkbenchAgentMcpControllerOptions {
  isSubagentCaller?: (caller: WorkbenchProviderCaller) => Promise<boolean>;
  tools: (provider: string) => WorkbenchProviderTools;
  /** Workbench approval for outside-sandbox commands on the Workbench-hosted shell. */
  approveHostedShell?: WorkbenchToolAdmissionOptions["approve"];
  /** Defaults to the registry's generation-reentrant executor; tests inject their own. */
  executeCommand?: (request: WorkbenchAgentCommandRequest, signal: AbortSignal) => Promise<Response>;
  /** Defaults to the registry's exec-node shell runner; tests inject their own. */
  executeShell?: (run: WorkbenchShellRun, signal: AbortSignal) => Promise<WorkbenchShellRunResult>;
  getReloadScopeCatalog?: () => readonly DaemonReloadScopeDescriptor[];
  /** Read per request so the catalogue follows the virtual repository runtime as it appears or disappears. */
  virtualReposAvailable?: () => boolean;
  lifecycleLogError?: (name: string, message: string) => void;
  daemonOrigin: string;
  requestRegistry?: WorkbenchAgentMcpRequestRegistry;
  scheduleProgress?: (pulse: () => Promise<void>, signal: AbortSignal) => () => void;
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

function readClientScope(url: URL) {
  const value = url.searchParams.get("client")?.trim();
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
  }: WorkbenchAgentMcpControllerOptions) {
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

    const url = new URL(request.url ?? "/", "http://localhost");
    let scope: WorkbenchMcpScope;
    try {
      const clientScope = readClientScope(url);
      const provider = url.searchParams.get("provider");
      if (!provider) throw new Error("Workbench MCP requires a provider selector.");
      this.tools(provider);
      scope = {
        clientScope, provider,
        projectLocal: url.searchParams.get("project-local") === "true",
        subagent: url.searchParams.get("subagent") === "true",
      };
    } catch (error) {
      sendJsonRpcError(response, 400, sanitizeError(error) || "Workbench MCP client scope is invalid.");
      return;
    }
    // The ingress owns the accepted request and resolves the current generation for each of its steps.
    serveWorkbenchMcpHttpRequest(request, response, { logError: this.lifecycleLogError, registry: this.requestRegistry, scope });
  }

  /** Visible commands for one request, in catalogue order; duplicate names are a catalogue defect. */
  private visibleCommands(scope: WorkbenchMcpScope) {
    const names = new Set<string>([WORKBENCH_SHELL_MCP_TOOL_NAME]);
    const visible = new Map<string, WorkbenchAgentCommandDefinition>();
    for (const definition of this.listCommands()) {
      const name = getWorkbenchAgentCommandToolName(definition);
      if (!isWorkbenchToolVisibleTo(name, scope.subagent)) continue;
      if (definition.hideFromMcp || (definition.managedThreadRootOnly && !scope.projectLocal)
        || !isWorkbenchAgentCommandVisibleTo(definition, scope.provider)) continue;
      if (names.has(name)) throw new Error(`Duplicate Workbench MCP tool name: ${name}`);
      names.add(name);
      visible.set(name, definition);
    }
    return visible;
  }

  async describe(scope: WorkbenchMcpScope, signal: AbortSignal) {
    const description = await this.tools(scope.provider).describe();
    signal.throwIfAborted();
    const shellInputSchema = description.shellEscalation ? WorkbenchEscalatingShellInputSchema : WorkbenchShellInputSchema;
    const tools: Tool[] = [{
      name: WORKBENCH_SHELL_MCP_TOOL_NAME,
      description: description.shellDescription,
      inputSchema: toolJsonSchema(shellInputSchema, "input") as Tool["inputSchema"],
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false, readOnlyHint: false },
      outputSchema: toolJsonSchema(WorkbenchShellResultSchema, "output") as Tool["outputSchema"],
    }];
    for (const [name, definition] of this.visibleCommands(scope)) {
      tools.push({
        name,
        description: `${definition.description}\n\nCLI equivalent: ${definition.usage}`,
        inputSchema: toolJsonSchema(definition.inputSchema, "input") as Tool["inputSchema"],
        annotations: {
          destructiveHint: definition.effects.destructive ?? false,
          idempotentHint: definition.effects.idempotent ?? false,
          openWorldHint: definition.effects.openWorld ?? false,
          readOnlyHint: definition.effects.readOnly ?? false,
        },
      });
    }
    return { experimental: description.experimental, tools };
  }

  async call(scope: WorkbenchMcpScope, call: WorkbenchMcpToolCall): Promise<WorkbenchMcpToolStep> {
    const tools = this.tools(scope.provider);
    try {
      if (call.name === WORKBENCH_SHELL_MCP_TOOL_NAME) {
        const { shellEscalation } = await tools.describe();
        const shellInputSchema = shellEscalation ? WorkbenchEscalatingShellInputSchema : WorkbenchShellInputSchema;
        const input = shellInputSchema.parse(await validateToolInput(shellInputSchema, call.arguments, call.name));
        return await this.callShell(scope, call, input, tools, shellEscalation);
      }
      const definition = this.visibleCommands(scope).get(call.name);
      if (!definition) throw new McpError(ErrorCode.InvalidParams, `Tool ${call.name} not found`);
      const input = await validateToolInput(definition.inputSchema, call.arguments, call.name) as object;
      if (definition.mcpRuntimeDrainPolicy === "preserve-across-reload") {
        return await this.detachTool(definition, input, call, scope.clientScope, tools);
      }
      return { kind: "result", result: await this.callTool(definition, input, call.meta, scope.clientScope, call.requestId, call.signal, tools) };
    } catch (error) {
      return { kind: "result", result: toolError(error) };
    }
  }

  /**
   * Long waits only prepare here; the ingress awaits them outside this generation, and whichever generation is
   * current when they end formats and records the outcome.
   */
  private async detachTool(
    definition: WorkbenchAgentCommandDefinition, input: object, call: WorkbenchMcpToolCall, clientScope: string,
    tools: WorkbenchProviderTools,
  ): Promise<WorkbenchMcpToolStep> {
    const toolName = getWorkbenchAgentCommandToolName(definition);
    const started = await this.startTranscript(toolName, input, call.meta, clientScope, call.signal, tools);
    if (started.kind === "failed") return { kind: "result", result: started.result };
    const prepared = await this.prepareCommand(definition, input, call.meta, clientScope, call.requestId, call.signal, tools);
    if (prepared.kind === "result") {
      prepared.unregister?.();
      return { kind: "result", result: await this.finishTranscript(tools, started.reference, prepared.result) };
    }
    return {
      kind: "detached",
      call: {
        ...(this.injectedExecuteCommand ? { execute: this.injectedExecuteCommand } : {}),
        ...(this.injectedScheduleProgress ? { scheduleProgress: this.injectedScheduleProgress } : {}),
        keepalive: definition.mcpCodeModeEligible === true,
        request: prepared.request,
        signal: prepared.signal,
        toolName,
        transcript: started.reference,
        unregister: prepared.unregister,
      },
    };
  }

  async finish(scope: WorkbenchMcpScope, call: WorkbenchMcpDetachedCall, outcome: WorkbenchMcpCallOutcome) {
    const tools = this.tools(scope.provider);
    let result: CallToolResult;
    if (call.shell) {
      result = "shellResult" in outcome
        ? await this.shellResult(call.shell, outcome.shellResult)
        : this.shellFailure("error" in outcome ? outcome.error : new Error("The shell finished without a result."), call.signal);
    } else {
      const definition = this.listCommands().find(candidate => getWorkbenchAgentCommandToolName(candidate) === call.toolName);
      result = "response" in outcome
        ? await this.commandResult(call.request, outcome.response)
        : this.commandFailure(definition, "error" in outcome ? outcome.error : new Error("The command finished without a response."), call.signal);
    }
    return await this.finishTranscript(tools, call.transcript as WorkbenchToolTranscriptReference | null, result);
  }

  private startProgressKeepalive(
    sendProgress: ((progress: number) => Promise<void>) | undefined,
    signal: AbortSignal,
  ): (() => void) | null {
    if (!sendProgress) return null;
    let progress = 0;
    return (this.injectedScheduleProgress ?? scheduleWorkbenchMcpProgress)(async () => {
      try {
        await sendProgress(++progress);
      } catch (error) {
        this.lifecycleLogError("workbench-mcp-progress", sanitizeError(error) || "Workbench MCP progress failed.");
      }
    }, signal);
  }

  /**
   * Shells only prepare here: the ingress runs the command through the exec node, so neither an approval wait nor a
   * running command holds this generation or any provider generation. An older ingress gets the same steps inline.
   */
  private async callShell(
    scope: WorkbenchMcpScope, call: WorkbenchMcpToolCall, input: WorkbenchEscalatingShellInput,
    tools: WorkbenchProviderTools, hosted: boolean,
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
    try {
      registration = this.requestRegistry.register(scope.clientScope, call.requestId, {
        owner: this.runtimeOwner, steerInterruptible: false, toolName: "shell",
        shellItem: { references: shellItemReferences, ...(started.reference ? { threadId: started.reference.threadId } : {}) },
      });
    } catch (error) {
      return await finishFailure(error, call.signal);
    }
    registration.markDrainIndependent();
    const signal = AbortSignal.any([call.signal, registration.signal]);
    let prepared: WorkbenchPreparedShell;
    try {
      prepared = await this.prepareShell(input, call.meta, {
        clientScope: scope.clientScope,
        ...(started.reference ? { itemId: started.reference.itemId, turnId: started.reference.turnId } : {}),
      }, signal, tools, hosted);
    } catch (error) {
      registration.unregister();
      return await finishFailure(error, signal);
    }
    const detached: WorkbenchMcpDetachedCall = {
      ...(this.injectedExecuteShell ? { executeShell: this.injectedExecuteShell } : {}),
      ...(this.injectedScheduleProgress ? { scheduleProgress: this.injectedScheduleProgress } : {}),
      keepalive: true, shell: prepared, signal, toolName: "shell", transcript: started.reference,
      unregister: registration.unregister,
    };
    if (call.detachableShell) return { kind: "detached", call: detached };
    const stopProgress = this.startProgressKeepalive(call.sendProgress, signal);
    let outcome: WorkbenchMcpCallOutcome;
    try {
      const shellResult = this.injectedExecuteShell
        ? await this.injectedExecuteShell(prepared.run, signal)
        : await this.requestRegistry.executeShell(prepared.run, signal);
      outcome = signal.aborted ? { error: signal.reason } : { shellResult };
    } catch (error) {
      outcome = { error };
    } finally {
      stopProgress?.();
      registration.unregister();
    }
    return { kind: "result", result: await this.finish(scope, detached, outcome) };
  }

  /** Escalating providers get the Workbench-hosted shell, including its approval; others prepare their native shell. */
  private async prepareShell(
    input: WorkbenchEscalatingShellInput, meta: Record<string, unknown> | undefined, context: ProviderToolRequestContext,
    signal: AbortSignal, tools: WorkbenchProviderTools, hosted: boolean,
  ) {
    const metadata = ProviderToolMetadataSchema.parse(meta ?? {});
    if (!hosted) {
      if (!tools.prepareShell) throw new Error("This provider has no native shell.");
      return await tools.prepareShell(input, metadata, signal, context);
    }
    const approve = this.approveHostedShell;
    if (!approve) throw new Error("Workbench approval is unavailable for the hosted shell.");
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
    // Expected, not a failure: the user's stop already names what happened, so it is the whole result.
    if (signal.aborted && isWorkbenchAgentMcpUserStop(signal.reason)) {
      return { content: [{ type: "text", text: (signal.reason as Error).message }], isError: true };
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
  ) {
    if (definition.hideMcpTranscript) {
      return this.observeTool(getWorkbenchAgentCommandToolName(definition), {}, meta, clientScope, signal, tools,
        () => this.executeTool(definition, input, meta, clientScope, requestId, signal, tools),
        result => ({ content: [], isError: result.isError === true }));
    }
    return this.observeTool(getWorkbenchAgentCommandToolName(definition), input, meta, clientScope, signal, tools,
      () => this.executeTool(definition, input, meta, clientScope, requestId, signal, tools));
  }

  private listCommands() {
    return listWorkbenchAgentCommands(this.getReloadScopeCatalog(), "agent", { virtualRepos: this.virtualReposAvailable() });
  }

  /** The exact tool list a root Workbench-project thread on this provider is served, for prompt-cost accounting. */
  async listToolSpecs(provider: string, signal: AbortSignal = new AbortController().signal) {
    return (await this.describe({ clientScope: LEGACY_MCP_CLIENT_SCOPE, projectLocal: true, provider, subagent: false }, signal)).tools;
  }

  listInstructionTools(): WorkbenchInstructionTool[] {
    return [
      { id: WORKBENCH_SHELL_MCP_TOOL_NAME, codeModeEligible: true },
      ...this.listCommands()
        .filter(definition => !definition.hideFromMcp)
        .map(definition => ({
          id: getWorkbenchAgentCommandToolName(definition),
          codeModeEligible: definition.mcpCodeModeEligible === true,
        })),
    ];
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
  ): Promise<
    | { kind: "ready"; request: WorkbenchAgentCommandRequest; signal: AbortSignal; unregister: () => void }
    | { kind: "result"; result: CallToolResult; unregister?: () => void }
  > {
    let unregister: (() => void) | undefined;
    try {
      const toolName = getWorkbenchAgentCommandToolName(definition);
      const registration = this.requestRegistry.register(clientScope, requestId, {
        owner: this.runtimeOwner,
        policy: definition.mcpRuntimeDrainPolicy,
        steerInterruptible: definition.mcpSteerInterruptible,
        toolName,
      });
      unregister = registration.unregister;
      signal = AbortSignal.any([signal, registration.signal]);
      const caller = await tools.caller(ProviderToolMetadataSchema.parse(meta ?? {}), signal, { clientScope });
      if (signal.aborted) throw signal.reason;
      registration.setWorkbenchThreadId(caller.threadId);
      if (!isWorkbenchToolVisibleTo(toolName, true) && await this.isSubagentCaller(caller)) {
        return {
          kind: "result", unregister,
          result: {
            isError: true,
            content: [{ type: "text" as const, text: "Subagents leave claims for parent adoption; the parent creates commit proposals." }],
          },
        };
      }
      const request = await definition.buildRequestFromJson(input, {
        callerHarness: caller.harness,
        callerThreadId: caller.threadId,
        cwd: caller.cwd,
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
    if (isWorkbenchAgentMcpSteerInterruption(error)) {
      // Expected, not a failure: an empty error result reaches agents as an opaque "Unknown error".
      return {
        content: [{ type: "text" as const, text: STEER_INTERRUPTION_TEXT }],
        isError: false,
        structuredContent: { kind: "interruptedBySteer", version: 1 },
      };
    }
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
