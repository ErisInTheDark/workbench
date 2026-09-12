/*
 * Exports:
 * - default ThreadSubagentMessageItem: render a sent subagent steer as a relationship disclosure with a left-aligned user-style bubble. Keywords: workbench, thread, subagent, message, steer, user bubble.
 */
"use client";

import type { ReactNode } from "react";

import type { ThreadPayload, WorkbenchSubagentSummary } from "workbench-shared/types";

import ThreadAgentName from "./ThreadAgentName";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadSubagentUserMessage from "./ThreadSubagentUserMessage";

export default function ThreadSubagentMessageItem ({
  children,
  fallbackName,
  subagent,
  thread,
}: {
  children: ReactNode;
  fallbackName?: string | null;
  subagent?: WorkbenchSubagentSummary | null;
  thread?: ThreadPayload | null;
}) {
  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 pl-6"
      summary={(
        <span>
          Messaged <ThreadAgentName
            subagent={subagent}
            thread={thread ?? (fallbackName ? { agentNickname: fallbackName, agentRole: null } : null)}
          />
        </span>
      )}
      summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
    >
      <ThreadSubagentUserMessage>{children}</ThreadSubagentUserMessage>
    </ThreadDisclosure>
  );
}
