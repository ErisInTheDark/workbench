/*
 * Exports:
 * - ThreadSubagentCoordinationRole/findThreadSubagentCoordinationSpans: identify qualifying subagent coordination runs.
 * - readThreadSubagentCoordinationOutgoingMessage: read one visible CLI or MCP outgoing message.
 * - readThreadSubagentCoordinationWait: read one CLI or MCP wait with its targets and outcome.
 * - readThreadSubagentCoordinationClaimAction: read a successful subagent-targeted claim transfer.
 */

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import {
  getThreadCommandDisplay,
  getThreadCommandExecutionOutcome,
  getThreadSubagentWaitMcpOutcome,
  getWorkbenchMcpCommandRoute,
  parseGitArcCommand,
  parseWorkbenchMessageCommand,
  parseWorkbenchSubagentCommand,
  type CommandShell,
  type ThreadCommandExecutionOutcome,
} from "../../../workbench/thread/thread-command-matchers";
import type { WorkbenchSubagentCommandTarget } from "../../../workbench/thread/command-matchers/workbench-cli";
import { getWorkbenchSubagentCommandTargetKey } from "../../../workbench/thread/thread-subagents";

export interface ThreadSubagentCoordinationRole {
  incoming: boolean;
  itemCount: number;
  outgoing: boolean;
}

export interface ThreadSubagentCoordinationOutgoingMessage {
  message: string;
  target: { kind: "name" | "parent" | "thread"; value: string | null };
  userVisibleSimpleVersion?: string | null;
}

type CoordinationWaitItem = Extract<ThreadItem, { type: "commandExecution" | "mcpToolCall" }>;

export interface ThreadSubagentCoordinationWait {
  item: CoordinationWaitItem;
  outcome: ThreadCommandExecutionOutcome;
  targetKeys: string[];
  targets: WorkbenchSubagentCommandTarget[];
}

export interface ThreadSubagentCoordinationClaimAction {
  action: "adopt" | "release";
  paths: string[];
  target: { kind: "id" | "name"; value: string };
}

function getCommandDisplay(item: Extract<ThreadItem, { type: "commandExecution" }>) {
  return getThreadCommandDisplay({
    command: item.command,
    commandActions: item.commandActions,
    cwd: item.cwd,
    shell: (item as typeof item & { shell?: CommandShell }).shell,
  });
}

export function readThreadSubagentCoordinationOutgoingMessage(
  item: ThreadItem,
): ThreadSubagentCoordinationOutgoingMessage | null {
  if (item.type === "commandExecution") {
    const outcome = getThreadCommandExecutionOutcome(item.status, item.exitCode);
    if (outcome !== "completed" && outcome !== "inProgress") return null;
    const operation = parseWorkbenchMessageCommand(getCommandDisplay(item).unwrappedCommand, item.commandActions);
    return operation?.message ? operation : null;
  }
  if (item.type !== "mcpToolCall" || item.status === "failed" || item.error) return null;
  const route = getWorkbenchMcpCommandRoute({
    argumentsValue: item.arguments,
    server: item.server,
    tool: item.tool,
  });
  if (route?.kind !== "specialized" || route.operation.kind !== "message") return null;
  const operation = route.operation.operation;
  return operation.message ? {
    message: operation.message,
    target: operation.target,
    userVisibleSimpleVersion: operation.userVisibleSimpleVersion,
  } : null;
}

export function readThreadSubagentCoordinationWait(item: ThreadItem): ThreadSubagentCoordinationWait | null {
  if (item.type === "commandExecution") {
    const operation = parseWorkbenchSubagentCommand(getCommandDisplay(item).unwrappedCommand, item.commandActions);
    return operation?.action === "wait" && operation.targets.length ? {
      item,
      outcome: getThreadCommandExecutionOutcome(item.status, item.exitCode),
      targetKeys: operation.targets.map(getWorkbenchSubagentCommandTargetKey),
      targets: operation.targets,
    } : null;
  }
  if (item.type !== "mcpToolCall") return null;
  const route = getWorkbenchMcpCommandRoute({
    argumentsValue: item.arguments,
    server: item.server,
    tool: item.tool,
  });
  return route?.kind === "specialized"
    && route.operation.kind === "subagent"
    && route.operation.operation.action === "wait"
    && route.operation.operation.targets.length
      ? {
        item,
        outcome: getThreadSubagentWaitMcpOutcome(item),
        targetKeys: route.operation.operation.targets.map(getWorkbenchSubagentCommandTargetKey),
        targets: route.operation.operation.targets,
      }
      : null;
}

export function readThreadSubagentCoordinationClaimAction(
  item: ThreadItem,
): ThreadSubagentCoordinationClaimAction | null {
  const operation = item.type === "commandExecution"
    ? (() => {
      const outcome = getThreadCommandExecutionOutcome(item.status, item.exitCode);
      return outcome === "completed" || outcome === "inProgress"
        ? parseGitArcCommand(getCommandDisplay(item).unwrappedCommand)
        : null;
    })()
    : item.type === "mcpToolCall" && item.status !== "failed" && !item.error
      ? (() => {
        const route = getWorkbenchMcpCommandRoute({
          argumentsValue: item.arguments,
          server: item.server,
          tool: item.tool,
        });
        return route?.kind === "specialized" && route.operation.kind === "gitArc"
          ? route.operation.operation
          : null;
      })()
      : null;
  if (operation?.action === "release" && operation.toSubagent) {
    return {
      action: "release",
      paths: operation.paths,
      target: { kind: "name", value: operation.toSubagent },
    };
  }
  if (operation?.action !== "adopt") return null;
  if (operation.source?.threadId) {
    return {
      action: "adopt",
      paths: operation.paths,
      target: { kind: "id", value: operation.source.threadId },
    };
  }
  return operation.source?.name ? {
    action: "adopt",
    paths: operation.paths,
    target: { kind: "name", value: operation.source.name },
  } : null;
}

export function findThreadSubagentCoordinationSpans(
  roles: readonly (ThreadSubagentCoordinationRole | null)[],
): Array<{ end: number; start: number }> {
  const spans: Array<{ end: number; start: number }> = [];
  let index = 0;
  while (index < roles.length) {
    if (!roles[index]) {
      index += 1;
      continue;
    }
    const start = index;
    let itemCount = 0;
    let incoming = false;
    let outgoing = false;
    while (index < roles.length && roles[index]) {
      itemCount += roles[index]!.itemCount;
      incoming ||= roles[index]!.incoming;
      outgoing ||= roles[index]!.outgoing;
      index += 1;
    }
    if (itemCount >= 3 || incoming && outgoing) spans.push({ end: index, start });
  }
  return spans;
}
