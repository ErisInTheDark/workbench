/*
 * Exports:
 * - getWorkbenchMcpCommandRoute/shouldUseWorkbenchMcpSpecializedRenderer: route wb calls, including deferred tools run through `mcp_call`, and retain dedicated Git, title, and status failure presentation.
 * - getWorkbenchMcpCommandDisplay: match simple wb calls to shared summary presentation.
 * - WorkbenchMcpShellCommandItem/getWorkbenchMcpShellCommandItem: derive ordinary command presentation from wb shell evidence,
 *   including failures whose reason is only result text, the expensive mark, its recorded queue wait, its yield window and
 *   whether it yielded.
 * - WorkbenchShellWaitLink/WorkbenchMcpShellWaitCommandItem/getWorkbenchMcpShellWaitCommandItem/readWorkbenchShellWaitShellId:
 *   draw a `shell_wait` as the yielded command it collects, with the wait's own timing and outcome.
 * - readMcpTextContent: one MCP result content part's text.
 * - isWorkbenchFileRemoval/getWorkbenchFileRemovalChanges: present wb rm calls as file-change deletes.
 */
import type { JsonValue, ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { WORKBENCH_MCP_SERVER_NAME } from "workbench-shared/workbench/mcp/mcp-server-settings";
import type { NativeFileChange } from "./native-file-changes";
import {
  getWorkbenchShellAggregatedOutput,
  getWorkbenchShellInputSchema,
  WORKBENCH_SHELL_WAIT_MCP_TOOL_NAME,
  WorkbenchShellResultSchema,
} from "workbench-shared/workbench/commands/workbench-shell-command";

import type { CommandShell, ThreadCommandSummaryDisplay } from "./types";
import {
  getWorkbenchCommandRoute,
  getUnknownGitArcCommandRoute,
  getWorkbenchCommandRouteSummaryDisplay,
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
export type WorkbenchMcpShellCommandItem = CommandExecutionItem & {
  expensive?: true;
  /** Time the expensive command waited for a slot, once its result records it. */
  queuedMs?: number;
  shell: CommandShell;
  workbenchShell: true;
  /** The call answers once the command has run this long, and the command runs on in the background. */
  yieldMs?: number;
  /** The finished row records that its call answered first; a running row learns that from live shell state. */
  yielded?: true;
};

/**
 * The yielded shell a `shell_wait` collects, and how that wait ended: with the shell's result, or yielded again (at its
 * own `timeoutMs` or a steer) while the shell runs on; null while it waits or when it failed.
 */
export interface WorkbenchShellWaitLink {
  ended: "collected" | "yielded" | null;
  shellItemId: string;
}

/** A `shell_wait` drawn as the command it collects, with the wait's own timing and outcome. */
export type WorkbenchMcpShellWaitCommandItem = CommandExecutionItem & { shell: CommandShell; shellWait: WorkbenchShellWaitLink };

const ShellCallInputSchema = getWorkbenchShellInputSchema({ parallel: false, yields: true });

function isWorkbenchMcpServer(server: string) {
  return server === "wb" || server === "wbex";
}

/** One MCP result content part's text, or null when the part is not text. */
export function readMcpTextContent(value: JsonValue) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && value.type === "text"
    && typeof value.text === "string"
    ? value.text
    : null;
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
  const input = ShellCallInputSchema.safeParse(item.arguments);
  if (!input.success) return null;
  const result = WorkbenchShellResultSchema.safeParse(item.result?.structuredContent);
  // A failure says why in its error, or (when the user stopped it) as plain result text.
  const failureText = item.status === "failed"
    ? item.error?.message || item.result?.content.flatMap(part => readMcpTextContent(part) ?? []).join("\n") || null
    : null;
  if (!result.success && item.status !== "inProgress" && !failureText) return null;
  const requestedCwd = input.data.workdir;
  const cwd = result.success
    ? result.data.cwd
    : requestedCwd && (/^[A-Za-z]:[\\/]/u.test(requestedCwd) || requestedCwd.startsWith("/"))
      ? requestedCwd
      : fallbackCwd;

  return {
    aggregatedOutput: result.success
      ? getWorkbenchShellAggregatedOutput(result.data)
      : failureText,
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
    workbenchShell: true,
    ...(input.data.expensive ? { expensive: true as const } : {}),
    ...(result.success && result.data.queuedMs !== undefined ? { queuedMs: result.data.queuedMs } : {}),
    ...(input.data.yield_ms !== undefined ? { yieldMs: input.data.yield_ms } : {}),
    ...(readStructuredField(item, "shellId") ? { yielded: true as const } : {}),
  };
}

/** One string field of an MCP call's structured result, which may be any JSON. */
function readStructuredField(item: McpToolCallItem, key: string) {
  const structured = item.result?.structuredContent;
  const value = structured !== null && typeof structured === "object" && !Array.isArray(structured) ? structured[key] : null;
  return typeof value === "string" && value ? value : null;
}

/** The shell id a wb `shell_wait` call collects; a yielded shell's id is its row's item id. */
export function readWorkbenchShellWaitShellId(item: ThreadItem) {
  if (item.type !== "mcpToolCall" || !isWorkbenchMcpServer(item.server) || item.tool !== WORKBENCH_SHELL_WAIT_MCP_TOOL_NAME) return null;
  const args = item.arguments;
  const shellId = args !== null && typeof args === "object" && !Array.isArray(args) ? args.shellId : null;
  return typeof shellId === "string" && shellId ? shellId : null;
}

function readShellWaitEnd(item: McpToolCallItem): WorkbenchShellWaitLink["ended"] {
  if (item.status === "inProgress") return null;
  const kind = readStructuredField(item, "kind");
  if (kind === "timedOut" || kind === "interruptedBySteer") return "yielded";
  return WorkbenchShellResultSchema.safeParse(item.result?.structuredContent).success ? "collected" : null;
}

export function getWorkbenchMcpShellWaitCommandItem(
  wait: McpToolCallItem,
  shell: WorkbenchMcpShellCommandItem,
): WorkbenchMcpShellWaitCommandItem {
  const result = WorkbenchShellResultSchema.safeParse(wait.result?.structuredContent);
  const failureText = wait.status === "failed" && !result.success
    ? wait.error?.message || wait.result?.content.flatMap(part => readMcpTextContent(part) ?? []).join("\n") || null
    : null;
  return {
    aggregatedOutput: result.success ? getWorkbenchShellAggregatedOutput(result.data) : failureText ?? "",
    command: shell.command,
    commandActions: [],
    cwd: shell.cwd,
    durationMs: wait.durationMs,
    exitCode: result.success ? result.data.exitCode : null,
    id: wait.id,
    pluginId: wait.pluginId,
    processId: null,
    scriptPath: null,
    shell: shell.shell,
    shellWait: { ended: readShellWaitEnd(wait), shellItemId: shell.id },
    source: "agent",
    status: wait.status,
    type: "commandExecution",
  };
}

export function isWorkbenchFileRemoval(item: ThreadItem): item is McpToolCallItem & { tool: "rm" } {
  return item.type === "mcpToolCall" && isWorkbenchMcpServer(item.server) && item.tool === "rm";
}

export function getWorkbenchFileRemovalChanges(item: ThreadItem): NativeFileChange[] {
  if (!isWorkbenchFileRemoval(item)) return [];
  const args = item.arguments;
  const paths = args !== null && typeof args === "object" && !Array.isArray(args) && Array.isArray(args.paths)
    ? args.paths.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : [];
  return paths.map((path, sourceChangeIndex) => ({
    change: { path, kind: { type: "delete" }, diff: "" },
    sourceItemId: item.id, sourceChangeIndex, danger: item.status === "failed",
  }));
}

/** `mcp_call` on server `wb` runs a deferred Workbench tool; it presents as that tool. */
function readDeferredCall(tool: string, argumentsValue: JsonValue) {
  if (tool !== "mcp_call" || argumentsValue === null || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) return null;
  const { arguments: inner, server, tool: target } = argumentsValue;
  if (server !== WORKBENCH_MCP_SERVER_NAME || typeof target !== "string" || target === "mcp_call") return null;
  return { arguments: inner ?? {}, tool: target };
}

export function getWorkbenchMcpCommandRoute({
  argumentsValue,
  context,
  server,
  tool,
}: WorkbenchMcpCommandInput): WorkbenchCommandRoute | null {
  if (!isWorkbenchMcpServer(server)) return null;
  const deferred = readDeferredCall(tool, argumentsValue);
  if (deferred) {
    const route = getWorkbenchMcpCommandRoute({ argumentsValue: deferred.arguments, context, server, tool: deferred.tool });
    if (route) return route;
  }
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
    || route.operation.kind === "threadTitle"
    || route.operation.kind === "threadStatus"
    || route.operation.kind === "mcpDownload";
}

export function getWorkbenchMcpCommandDisplay({
  argumentsValue,
  context,
  server,
  tool,
}: WorkbenchMcpCommandInput): ThreadCommandSummaryDisplay | null {
  return getWorkbenchCommandRouteSummaryDisplay(getWorkbenchMcpCommandRoute({ argumentsValue, context, server, tool }));
}
