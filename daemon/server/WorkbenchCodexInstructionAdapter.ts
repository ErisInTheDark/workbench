/*
 * Exports:
 * - WorkbenchCodexInstructionSource: request-inherited or cwd-owned context for internal resume configuration.
 * - WorkbenchCodexInstructionPort: request-augmentation boundary consumed by the bridge.
 * - WorkbenchCodexThreadConfiguration: daemon-resolved settings and validated thread ownership.
 * - default WorkbenchCodexInstructionAdapter: adapt model-filtered thread instructions, skills, settings and project-local MCP config into Codex requests.
 */
import path from "node:path";
import buildWorkbenchOwnedPromptFields from "./codex-owned-prompt";
import type { WorkbenchComposerSettings, WorkbenchProjectRoot, WorkbenchLocalCapabilitySettings } from "workbench-shared/types";
import { contextCompactionThreshold } from "workbench-shared/workbench/thread/thread-profile";

import * as workbenchPromptFiles from "./lib/workbench/instructions/WorkbenchPromptFiles";
import type { WorkbenchPromptInstructions } from "./lib/workbench/instructions/WorkbenchPromptFiles";
import type { WorkbenchInstructionTool } from "./lib/workbench/instructions/instruction-tool-reference";
import { listWorkbenchAgentCommands } from "./lib/workbench/commands/workbench-agent-command-registry";
import { getWorkbenchAgentCommandToolName } from "./lib/workbench/commands/workbench-agent-command-definition";
import { WORKBENCH_SHELL_MCP_TOOL_NAME } from "workbench-shared/workbench/commands/workbench-shell-command";
import { createWorkbenchActivatedSkillsInput } from "workbench-shared/workbench/thread/thread-activated-skills";
import type { JsonRpcRequest } from "./bridge-types";
import { withWorkbenchCodexMcpConfig } from "./workbench-codex-mcp-config";
import { readWorkbenchPromptContext, WORKBENCH_PROMPT_CONTEXT_FIELD } from "./workbench-prompt-context";

export type WorkbenchCodexInstructionSource =
  | { readonly kind: "cwd"; readonly cwd?: string | null }
  | { readonly kind: "request"; readonly request: JsonRpcRequest };

export interface WorkbenchCodexThreadConfiguration {
  cwd: string;
  projectId: string;
  roots: readonly WorkbenchProjectRoot[];
  settings: WorkbenchComposerSettings;
  subagentName: string | null;
  threadId: string | null;
}

export interface WorkbenchCodexInstructionPort {
  augment(message: JsonRpcRequest, method: string | null): Promise<JsonRpcRequest>;
  createThreadResume(params: Record<string, unknown>, source: WorkbenchCodexInstructionSource): JsonRpcRequest;
}

function isPromptAugmentedThreadMethod(method: string | null) {
  return method === "thread/start" || method === "thread/resume" || method === "thread/fork";
}

function isPromptAugmentedTurnMethod(method: string | null) {
  return method === "turn/start" || method === "turn/steer";
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function buildWorkbenchManagedThreadConfig(params: Record<string, unknown>, overrides: Record<string, unknown>) {
  return {
    ...asRecord(params.config),
    bypass_hook_trust: true,
    ...overrides,
  };
}

function buildWorkbenchOwnedPromptParams(params: Record<string, unknown>, promptInstructions: WorkbenchPromptInstructions) {
  const fields = buildWorkbenchOwnedPromptFields(promptInstructions.baseInstructions, promptInstructions.developerInstructions);
  return {
    ...params,
    ...fields,
    config: buildWorkbenchManagedThreadConfig(params, fields.config),
  };
}

function pathsEqual(left: string, right: string) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase()
    : normalizedLeft === normalizedRight;
}

function readDefaultInstructionTools(): Promise<readonly WorkbenchInstructionTool[]> {
  return Promise.resolve([
    { id: WORKBENCH_SHELL_MCP_TOOL_NAME, codeModeEligible: true },
    ...listWorkbenchAgentCommands()
      .filter(definition => !definition.hideFromMcp)
      .map(definition => ({
        id: getWorkbenchAgentCommandToolName(definition),
        codeModeEligible: definition.mcpCodeModeEligible === true,
      })),
  ]);
}

export default class WorkbenchCodexInstructionAdapter implements WorkbenchCodexInstructionPort {
  private readonly workbenchRoot: string;

  constructor(
    private readonly bridgeUrl: string,
    workbenchRoot: string,
    private readonly readLocalCapabilities: () => Promise<WorkbenchLocalCapabilitySettings>,
    private readonly readInstructionTools: () => Promise<readonly WorkbenchInstructionTool[]> = readDefaultInstructionTools,
  ) {
    this.workbenchRoot = path.resolve(workbenchRoot);
  }

  private withMcpConfig(params: Record<string, unknown>, cwd?: string | null, subagentName?: string | null) {
    return withWorkbenchCodexMcpConfig(params, this.bridgeUrl, {
      projectLocal: typeof cwd === "string" && cwd.trim() !== "" && pathsEqual(cwd, this.workbenchRoot),
      subagent: Boolean(subagentName?.trim()),
    });
  }

  createThreadResume(params: Record<string, unknown>, source: WorkbenchCodexInstructionSource): JsonRpcRequest {
    const promptContext = source.kind === "request" ? readWorkbenchPromptContext(source.request) : null;
    const sourceModel = source.kind === "request" ? asRecord(source.request.params).model : null;
    const sourceCwd = source.kind === "request"
      ? promptContext?.cwd ?? (typeof params.cwd === "string" ? params.cwd : null)
      : source.cwd;
    return {
      method: "thread/resume",
      params: this.withMcpConfig({
        ...params,
        ...(typeof sourceModel === "string" ? { model: sourceModel } : {}),
      }, sourceCwd, promptContext?.subagentName),
      ...(promptContext ? { [WORKBENCH_PROMPT_CONTEXT_FIELD]: promptContext } : {}),
    };
  }

  withThreadConfiguration(message: JsonRpcRequest, configuration: WorkbenchCodexThreadConfiguration): JsonRpcRequest {
    const { settings, ...ownership } = configuration;
    if (settings.harness !== "codex") throw new Error("Codex admission requires a Codex composer profile.");
    const params = asRecord(message.params);
    const caller = readWorkbenchPromptContext(message);
    const collaborationMode = asRecord(params.collaborationMode);
    return {
      ...message,
      [WORKBENCH_PROMPT_CONTEXT_FIELD]: {
        ...caller, ...ownership, agentPath: settings.agentPath,
        workflowIds: caller?.workflowIds ?? [configuration.subagentName ? "subagent" : "default"],
      },
      params: {
        ...params, cwd: configuration.cwd, model: settings.model, serviceTier: settings.serviceTier,
        ...(message.method === "turn/start" ? {
          effort: settings.reasoningEffort,
          ...(params.collaborationMode ? {
            collaborationMode: {
              ...collaborationMode,
              settings: { ...asRecord(collaborationMode.settings), model: settings.model, reasoning_effort: settings.reasoningEffort },
            },
          } : {}),
        } : {
          config: {
            ...asRecord(params.config), model: settings.model, model_reasoning_effort: settings.reasoningEffort,
            ...(settings.contextWindowTokens != null ? {
              model_context_window: settings.contextWindowTokens,
              model_auto_compact_token_limit: contextCompactionThreshold(settings.contextWindowTokens),
            } : {}),
          },
        }),
      },
    };
  }

  async augment(message: JsonRpcRequest, method: string | null) {
    if (!isPromptAugmentedThreadMethod(method) && !isPromptAugmentedTurnMethod(method)) return message;
    const promptContext = readWorkbenchPromptContext(message);
    if (!promptContext) return message;
    const params = asRecord(message.params);
    // This adapter installs Workbench MCP even before native creation returns an id.
    const context = {
      ...promptContext,
      harness: "codex" as const,
      managedThread: true,
      model: typeof params.model === "string" ? params.model : null,
      readInstructionTools: this.readInstructionTools,
    };
    if (isPromptAugmentedTurnMethod(method)) {
      const activatedSkillCatalog = await workbenchPromptFiles.buildWorkbenchManagedThreadActivatedSkills(
        context,
        this.readLocalCapabilities,
      );
      if (!activatedSkillCatalog) return message;
      const input = Array.isArray(params.input) ? params.input : [];
      return {
        ...message,
        params: {
          ...params,
          input: [
            ...input,
            createWorkbenchActivatedSkillsInput(activatedSkillCatalog),
          ],
        },
      };
    }

    const promptInstructions = await workbenchPromptFiles.buildWorkbenchManagedThreadInstructions(
      context,
      this.readLocalCapabilities,
    );
    return {
      ...message,
      params: this.withMcpConfig(buildWorkbenchOwnedPromptParams(params, promptInstructions), context.cwd, context.subagentName),
    };
  }
}
