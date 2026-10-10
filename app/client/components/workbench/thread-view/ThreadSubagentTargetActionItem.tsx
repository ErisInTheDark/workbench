/*
 * Exports:
 * - default ThreadSubagentTargetActionItem: render active or successful stop/settle commands with one or many durable person identities. Keywords: workbench, thread, subagent, stop, settle, target, identity.
 */
"use client";

import type { WorkbenchSubagentSummary } from "workbench-shared/types";
import type { RelatedThread } from "../../../workbench/thread/ThreadStore";

import ThreadAgentName from "./ThreadAgentName";
import Disclosure from "../../ui/Disclosure";

interface ThreadSubagentTargetActionEntry {
  fallbackName?: string | null;
  subagent?: WorkbenchSubagentSummary | null;
  targetKey: string;
  thread?: RelatedThread | null;
}

export default function ThreadSubagentTargetActionItem ({
  action,
  active,
  entries,
}: {
  action: "settle" | "stop";
  active: boolean;
  entries: ThreadSubagentTargetActionEntry[];
}) {
  const verb = action === "settle"
    ? active ? "Settling " : "Settled "
    : active ? "Stopping " : "Stopped ";
  return (
    <Disclosure
      className="py-2"
      contentClassName="mt-2 pl-6"
      summary={(
        <span>
          {verb}
          {entries.map((entry, index) => (
            <span key={`${entry.targetKey}:${index}`}>
              {index === 0
                ? null
                : index === entries.length - 1
                  ? entries.length === 2 ? " and " : ", and "
                  : ", "}
              <ThreadAgentName
                subagent={entry.subagent}
                thread={entry.thread ?? (entry.fallbackName ? { agentNickname: entry.fallbackName, agentRole: null } : null)}
              />
            </span>
          ))}
        </span>
      )}
      summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
    >
      <></>
    </Disclosure>
  );
}
