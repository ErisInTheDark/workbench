/*
 * Exports:
 * - default ThreadSubagentTargetActionItem: an active or successful stop/settle command as one step line naming its
 *   subagents in their identity colours. Keywords: workbench, thread, subagent, stop, settle, target, identity.
 */
"use client";

import { BotIcon } from "../workbench-icons";
import ThreadAgentNameList, { type ThreadAgentNameListEntry } from "./ThreadAgentNameList";
import ThreadStepRow from "./ThreadStepRow";
import { stepLabel, stepLabels } from "./thread-step";

const LABELS = {
  settle: stepLabels("Settling", "Settled", "Failed to settle"),
  stop: stepLabels("Stopping", "Stopped", "Failed to stop"),
} as const;

export default function ThreadSubagentTargetActionItem ({
  action,
  active,
  entries,
}: {
  action: "settle" | "stop";
  active: boolean;
  entries: readonly ThreadAgentNameListEntry[];
}) {
  const state = active ? "inProgress" : "completed";
  return (
    <ThreadStepRow
      icon={<BotIcon size={16} />}
      label={stepLabel(LABELS[action], state)}
      progress={{ state }}
      subject={<ThreadAgentNameList entries={entries} />}
    />
  );
}
