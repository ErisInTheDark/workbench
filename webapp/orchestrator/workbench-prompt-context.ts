/*
 * Exports:
 * - WORKBENCH_PROMPT_CONTEXT_FIELD: private bridge request key carrying Workbench prompt context. Keywords: prompt, context, bridge.
 * - readWorkbenchPromptContext: parse Workbench prompt context from a bridge request. Keywords: prompt, parser, harness.
 */
import type { WorkbenchHarness, WorkbenchProjectRoot } from "../lib/types";
import type { WorkbenchPromptContext } from "../lib/workbench/instructions/WorkbenchPromptFiles";
import type { JsonRpcRequest } from "./bridge-types";

export const WORKBENCH_PROMPT_CONTEXT_FIELD = "workbenchPromptContext";

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function readWorkbenchHarness(value: unknown): WorkbenchHarness | null {
  switch (value) {
    case "codex":
    case "copilot":
    case "opencode":
      return value;
    default:
      return null;
  }
}

function readWorkbenchProjectRoot(value: unknown): WorkbenchProjectRoot | null {
  const record = asRecord(value);
  return typeof record?.id === "string"
    && typeof record.name === "string"
    && typeof record.relativePath === "string"
    && typeof record.rootPath === "string"
    && typeof record.isPrimary === "boolean"
    ? {
      id: record.id,
      isPrimary: record.isPrimary,
      name: record.name,
      relativePath: record.relativePath,
      rootPath: record.rootPath,
    }
    : null;
}

export function readWorkbenchPromptContext(message: JsonRpcRequest): WorkbenchPromptContext | null {
  const value = asRecord(message[WORKBENCH_PROMPT_CONTEXT_FIELD]);
  if (!value) {
    return null;
  }

  const roots = Array.isArray(value.roots)
    ? value.roots.map(readWorkbenchProjectRoot).filter((root): root is WorkbenchProjectRoot => root !== null)
    : undefined;
  const workflowIds = Array.isArray(value.workflowIds)
    ? value.workflowIds.filter((workflowId): workflowId is string => typeof workflowId === "string")
    : undefined;

  return {
    agentPath: asString(value.agentPath),
    harness: readWorkbenchHarness(value.harness),
    projectId: asString(value.projectId),
    roots,
    threadId: asString(value.threadId),
    workbenchOrigin: asString(value.workbenchOrigin),
    workflowIds,
  };
}
