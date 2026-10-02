/*
 * Exports:
 * - CompletedThreadWorkPartition: one completed turn split into collapsible work and always-mounted terminal output.
 * - partitionCompletedThreadWork: use the last successful CLI or MCP task-status operation as the terminal boundary, with a legacy final-message fallback that keeps trailing compaction visible.
 */
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import {
  getThreadItemTimelineDurationMs,
  type WorkbenchThreadItemTimelineEntry,
} from "workbench-shared/workbench/thread/thread-item-timeline";
import {
  getThreadCommandExecutionOutcome,
  getWorkbenchMcpCommandRoute,
  parseWorkbenchTaskStatusCommand,
} from "../../../workbench/thread/thread-command-matchers";
import { unwrapShellCommand } from "../../../workbench/thread/command-matchers/shells";

export interface CompletedThreadWorkPartition {
  statusMarkerId: string | null;
  terminalItems: ThreadItem[];
  workedDurationMs: number | null;
  workedItems: ThreadItem[];
}

function isSuccessfulThreadStatusItem(item: ThreadItem) {
  if (item.type === "mcpToolCall") {
    if (item.status !== "completed" || item.error) return false;
    const route = getWorkbenchMcpCommandRoute({ argumentsValue: item.arguments, server: item.server, tool: item.tool });
    return route?.kind === "specialized" && route.operation.kind === "threadStatus";
  }
  if (item.type !== "commandExecution") return false;
  if (getThreadCommandExecutionOutcome(item.status, item.exitCode) !== "completed") return false;
  const unwrappedCommand = unwrapShellCommand(item.command).command;
  return Boolean(parseWorkbenchTaskStatusCommand(unwrappedCommand, item.commandActions));
}

export function partitionCompletedThreadWork({
  finalAgentMessageId,
  itemTimeline,
  items,
  primaryUserItemId,
}: {
  finalAgentMessageId: string | null;
  itemTimeline?: readonly WorkbenchThreadItemTimelineEntry[];
  items: readonly ThreadItem[];
  primaryUserItemId: string | null;
}): CompletedThreadWorkPartition {
  let statusMarkerIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (isSuccessfulThreadStatusItem(items[index]!)) {
      statusMarkerIndex = index;
      break;
    }
  }

  const withoutPrimaryUser = (item: ThreadItem) => item.id !== primaryUserItemId;
  // Compaction after the turn's work, such as a manual compaction, follows the outcome instead of folding into it.
  let trailingCompactionIndex = items.length;
  while (trailingCompactionIndex > 0 && items[trailingCompactionIndex - 1]!.type === "contextCompaction") trailingCompactionIndex -= 1;
  const trailingCompactions = items.slice(trailingCompactionIndex);
  if (statusMarkerIndex >= 0) {
    const workedItems = items.slice(0, statusMarkerIndex).filter(withoutPrimaryUser);
    return {
      statusMarkerId: items[statusMarkerIndex]!.id,
      terminalItems: items.slice(statusMarkerIndex).filter(withoutPrimaryUser),
      workedDurationMs: getThreadItemTimelineDurationMs(workedItems.map((item) => item.id), itemTimeline),
      workedItems,
    };
  }

  const trailing = new Set(trailingCompactions.map((item) => item.id));
  return {
    statusMarkerId: null,
    terminalItems: [
      ...(finalAgentMessageId ? items.filter((item) => item.id === finalAgentMessageId) : []),
      ...trailingCompactions,
    ],
    workedDurationMs: null,
    workedItems: items.filter((item) => item.id !== primaryUserItemId && item.id !== finalAgentMessageId && !trailing.has(item.id)),
  };
}
