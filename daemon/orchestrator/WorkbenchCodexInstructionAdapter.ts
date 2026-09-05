/*
 * Exports:
 * - WorkbenchCodexInstructionSource: explicit request-inherited or cwd-owned context for internal Codex resume configuration. Keywords: Codex, context, cwd, request.
 * - WorkbenchCodexInstructionPort: narrow Codex request-augmentation boundary consumed by the bridge. Keywords: Codex, instructions, MCP, adapter.
 * - WorkbenchCodexThreadConfiguration: daemon-resolved settings and validated thread ownership.
 * - default WorkbenchCodexInstructionAdapter: adapt stable thread instructions, disabled native project docs, activated skill input, and project-local MCP config into Codex requests. Keywords: Codex, project, instructions, skills, prompt, MCP.
 */
import path from "node:path";
import type { WorkbenchComposerSettings, WorkbenchProjectRoot } from "workbench-shared/types";

import * as workbenchPromptFiles from "../lib/workbench/instructions/WorkbenchPromptFiles";
import type { WorkbenchPromptInstructions } from "../lib/workbench/instructions/WorkbenchPromptFiles";
import { createWorkbenchActivatedSkillsInput } from "workbench-shared/workbench/thread/thread-activated-skills";
import type { JsonRpcRequest } from "./bridge-types";
import { logError } from "./process-helpers";
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
  threadId: string;
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
  return {
    ...params,
    baseInstructions: promptInstructions.baseInstructions,
    developerInstructions: promptInstructions.developerInstructions,
    config: buildWorkbenchManagedThreadConfig(params, {
      developer_instructions: "",
      instructions: "",
      project_doc_max_bytes: 0,
    }),
    personality: "none",
  };
}

function pathsEqual(left: string, right: string) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase()
    : normalizedLeft === normalizedRight;
}

export default class WorkbenchCodexInstructionAdapter implements WorkbenchCodexInstructionPort {
  private readonly workbenchRoot: string;

  constructor(
    private readonly bridgeUrl: string,
    workbenchRoot: string,
  ) {
    this.workbenchRoot = path.resolve(workbenchRoot);
  }

  private withMcpConfig(params: Record<string, unknown>, cwd?: string | null) {
    return withWorkbenchCodexMcpConfig(params, this.bridgeUrl, {
      projectLocal: typeof cwd === "string" && cwd.trim() !== "" && pathsEqual(cwd, this.workbenchRoot),
    });
  }

  createThreadResume(params: Record<string, unknown>, source: WorkbenchCodexInstructionSource): JsonRpcRequest {
    const promptContext = source.kind === "request" ? readWorkbenchPromptContext(source.request) : null;
    const sourceCwd = source.kind === "request"
      ? promptContext?.cwd ?? (typeof params.cwd === "string" ? params.cwd : null)
      : source.cwd;
    return {
      method: "thread/resume",
      params: this.withMcpConfig(params, sourceCwd),
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
          config: { ...asRecord(params.config), model: settings.model, model_reasoning_effort: settings.reasoningEffort },
        }),
      },
    };
  }

  async augment(message: JsonRpcRequest, method: string | null) {
    if (!isPromptAugmentedThreadMethod(method) && !isPromptAugmentedTurnMethod(method)) return message;
    const promptContext = readWorkbenchPromptContext(message);
    if (!promptContext) return message;
    const params = asRecord(message.params);
    const available = await workbenchPromptFiles.listWorkbenchInstructionMechanics({ ...promptContext, harness: "codex" });
    const filter = (value: string | null, field: string) => workbenchPromptFiles.filterWorkbenchInstructionContent(value, {
      available,
      field,
      harness: "codex",
      onWarning: (warning) => logError("instruction-filter", `\u001b[31m${warning.field}:${warning.line} ${warning.recovery}: ${warning.source}\u001b[0m`),
      shell: process.platform === "win32" ? "pwsh" : "bash",
    });
    const context = { ...promptContext, harness: "codex" as const };

    if (isPromptAugmentedTurnMethod(method)) {
      const activatedSkillCatalog = filter(
        await workbenchPromptFiles.buildWorkbenchActivatedSkillCatalog(context),
        "input.wb:activated-skills",
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

    const promptInstructions = await workbenchPromptFiles.buildWorkbenchPromptInstructions(context);
    return {
      ...message,
      params: this.withMcpConfig(buildWorkbenchOwnedPromptParams(params, {
        baseInstructions: filter(promptInstructions.baseInstructions, "baseInstructions"),
        developerInstructions: filter(promptInstructions.developerInstructions, "developerInstructions"),
      }), context.cwd),
    };
  }
}
