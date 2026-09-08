/*
 * Keywords: MCP, commands, routing, shell, Git arc failures.
 * Exports:
 * - getWorkbenchMcpCommandRoute/shouldUseWorkbenchMcpSpecializedRenderer: resolve a recorded wb MCP call and keep failed Recall calls on the generic MCP error surface. Keywords: workbench, MCP, command, route, failure.
 * - getWorkbenchMcpCommandDisplay: match a simple recorded wb MCP call to its shared summary presentation. Keywords: workbench, MCP, command, rendering.
 * - WorkbenchMcpShellCommandItem/getWorkbenchMcpShellCommandItem: derive valid wb shell evidence and its matcher shell into the ordinary command presentation shape. Keywords: workbench, MCP, shell, command, presentation.
 */
import type { JsonValue } from "workbench-shared/codex/generated/app-server/serde_json/JsonValue";
import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import {
  getWorkbenchShellAggregatedOutput,
  WorkbenchShellInputSchema,
  WorkbenchShellResultSchema,
} from "workbench-shared/workbench/commands/workbench-shell-command";

import type { CommandShell, ThreadCommandSummaryDisplay } from "./types";
import {
  getWorkbenchCommandRoute,
  getUnknownGitArcCommandRoute,
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
export type WorkbenchMcpShellCommandItem = CommandExecutionItem & { shell: CommandShell };

function isWorkbenchMcpServer(server: string) {
  return server === "wb" || server === "wbex";
}

function inferWorkbenchShellFromCwd(cwd: string): CommandShell {
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/u.test(cwd)) return "pwsh";
  if (cwd.startsWith("/")) return "shell";
  return null;
}

export function getWorkbenchMcpShellCommandItem(
  item: McpToolCallItem,
  fallbackCwd = ".",
): WorkbenchMcpShellCommandItem | null {
  if (!isWorkbenchMcpServer(item.server) || item.tool !== "shell") return null;
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
    shell: result.success
      ? result.data.shell ?? inferWorkbenchShellFromCwd(cwd)
      : inferWorkbenchShellFromCwd(cwd),
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
  if (!isWorkbenchMcpServer(server)) return null;
  if (!isWorkbenchCommandPresentationName(tool)) {
    return /^git_(?:arc|plan)(?:_|$)/u.test(tool) ? getUnknownGitArcCommandRoute() : null;
  }
  return getWorkbenchCommandRoute(tool, argumentsValue, context);
}

export function shouldUseWorkbenchMcpSpecializedRenderer(
  route: WorkbenchCommandRoute | null,
  isFailure: boolean,
) {
  if (route?.kind !== "specialized") return false;
  return !isFailure
    || route.operation.kind === "gitArc"
    || route.operation.kind === "gitArcWait"
    || route.operation.kind === "threadTitle";
}

export function getWorkbenchMcpCommandDisplay({
  argumentsValue,
  context,
  server,
  tool,
}: WorkbenchMcpCommandInput): ThreadCommandSummaryDisplay | null {
  if (!isWorkbenchMcpServer(server) || !isWorkbenchCommandPresentationName(tool)) return null;
  return getWorkbenchCommandSummaryDisplay(tool, argumentsValue, context);
}
