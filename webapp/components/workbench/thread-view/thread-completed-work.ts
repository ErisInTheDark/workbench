/*
 * Exports:
 * - CompletedThreadWorkPartition: one completed turn split into collapsible work and always-mounted terminal output. Keywords: thread, completed, worked, terminal, status.
 * - partitionCompletedThreadWork: use the last successful task-status command as the terminal boundary, with a legacy final-message fallback. Keywords: thread, completed, status, partition, duration.
 */
import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";
import {
  getThreadItemTimelineDurationMs,
  type WorkbenchThreadItemTimelineEntry,
} from "../../../lib/workbench/thread/thread-item-timeline";
import {
  getThreadCommandExecutionOutcome,
  parseWorkbenchThreadStatusCommand,
} from "../../../lib/workbench/thread/thread-command-matchers";
import { unwrapShellCommand } from "../../../lib/workbench/thread/command-matchers/shells";

export interface CompletedThreadWorkPartition {
  statusMarkerId: string | null;
  terminalItems: ThreadItem[];
  workedDurationMs: number | null;
  workedItems: ThreadItem[];
}

function isSuccessfulThreadStatusItem(item: ThreadItem) {
  if (item.type !== "commandExecution") return false;
  if (getThreadCommandExecutionOutcome(item.status, item.exitCode) !== "completed") return false;
  const unwrappedCommand = unwrapShellCommand(item.command).command;
  return Boolean(parseWorkbenchThreadStatusCommand(unwrappedCommand, item.commandActions));
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
  if (statusMarkerIndex >= 0) {
    const workedItems = items.slice(0, statusMarkerIndex).filter(withoutPrimaryUser);
    return {
      statusMarkerId: items[statusMarkerIndex]!.id,
      terminalItems: items.slice(statusMarkerIndex).filter(withoutPrimaryUser),
      workedDurationMs: getThreadItemTimelineDurationMs(workedItems.map((item) => item.id), itemTimeline),
      workedItems,
    };
  }

  return {
    statusMarkerId: null,
    terminalItems: finalAgentMessageId
      ? items.filter((item) => item.id === finalAgentMessageId)
      : [],
    workedDurationMs: null,
    workedItems: items.filter((item) => item.id !== primaryUserItemId && item.id !== finalAgentMessageId),
  };
}
