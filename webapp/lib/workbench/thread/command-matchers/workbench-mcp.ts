/*
 * Exports:
 * - getWorkbenchMcpCommandRoute/shouldUseWorkbenchMcpSpecializedRenderer: resolve a recorded wb MCP call and keep failed Recall calls on the generic MCP error surface. Keywords: workbench, MCP, command, route, failure.
 * - getWorkbenchMcpCommandDisplay: match a simple recorded wb MCP call to its shared summary presentation. Keywords: workbench, MCP, command, rendering.
 * - getWorkbenchMcpShellCommandItem: derive valid wb shell evidence into the ordinary command presentation shape. Keywords: workbench, MCP, shell, command, presentation.
 */
import type { JsonValue } from "../../../codex/generated/app-server/serde_json/JsonValue";
import type { ThreadItem } from "../../../codex/generated/app-server/v2/ThreadItem";
import {
  getWorkbenchShellAggregatedOutput,
  WorkbenchShellInputSchema,
  WorkbenchShellResultSchema,
} from "../../commands/workbench-shell-command";

import type { ThreadCommandSummaryDisplay } from "./types";
import {
  getWorkbenchCommandRoute,
  getWorkbenchCommandSummaryDisplay,
  isWorkbenchCommandPresentationName,
  type WorkbenchCommandPresentationContext,
  type WorkbenchCommandRoute,
} from "./workbench-command-rendering";

interface WorkbenchMcpCommandInput {
  argumentsValue: JsonValue;
  context?: WorkbenchCommandPresentationContext;
  server: string;
  tool: string;
}

type McpToolCallItem = Extract<ThreadItem, { type: "mcpToolCall" }>;
type CommandExecutionItem = Extract<ThreadItem, { type: "commandExecution" }>;

export function getWorkbenchMcpShellCommandItem(
  item: McpToolCallItem,
  fallbackCwd = ".",
): CommandExecutionItem | null {
  if (item.server !== "wb" || item.tool !== "shell") return null;
  const input = WorkbenchShellInputSchema.safeParse(item.arguments);
  if (!input.success) return null;
  const result = WorkbenchShellResultSchema.safeParse(item.result?.structuredContent);
  if (
    !result.success
    && item.status !== "inProgress"
    && !(item.status === "failed" && item.error?.message)
  ) {
    return null;
  }
  const requestedCwd = input.data.workdir;
  const cwd = result.success
    ? result.data.cwd
    : requestedCwd && (/^[A-Za-z]:[\\/]/u.test(requestedCwd) || requestedCwd.startsWith("/"))
      ? requestedCwd
      : fallbackCwd;

  return {
    aggregatedOutput: result.success
      ? getWorkbenchShellAggregatedOutput(result.data)
      : item.error?.message ?? null,
    command: input.data.command,
    commandActions: [],
    cwd,
    durationMs: item.durationMs,
    exitCode: result.success ? result.data.exitCode : null,
    id: item.id,
    pluginId: item.pluginId,
    processId: null,
    scriptPath: null,
    source: "agent",
    status: item.status,
    type: "commandExecution",
  };
}

export function getWorkbenchMcpCommandRoute({
  argumentsValue,
  context,
  server,
  tool,
}: WorkbenchMcpCommandInput) {
  if (server !== "wb" || !isWorkbenchCommandPresentationName(tool)) return null;
  return getWorkbenchCommandRoute(tool, argumentsValue, context);
}

export function shouldUseWorkbenchMcpSpecializedRenderer(
  route: WorkbenchCommandRoute | null,
  isFailure: boolean,
) {
  if (route?.kind !== "specialized") return false;
  return !isFailure
    || route.operation.kind === "gitArc"
    || route.operation.kind === "threadTitle";
}

export function getWorkbenchMcpCommandDisplay({
  argumentsValue,
  context,
  server,
  tool,
}: WorkbenchMcpCommandInput): ThreadCommandSummaryDisplay | null {
  if (server !== "wb" || !isWorkbenchCommandPresentationName(tool)) return null;
  return getWorkbenchCommandSummaryDisplay(tool, argumentsValue, context);
}
