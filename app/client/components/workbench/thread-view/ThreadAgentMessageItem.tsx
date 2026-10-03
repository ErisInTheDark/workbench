/*
 * Exports:
 * - default ThreadAgentMessageItem: render a sent cross-thread message as a disclosure naming the target thread button, with a left-aligned user-style bubble.
 */
"use client";

import type { ReactNode } from "react";

import type { ThreadPayload, WorkbenchSubagentSummary } from "workbench-shared/types";

import WorkbenchThreadButton from "../WorkbenchThreadButton";
import ThreadAgentName from "./ThreadAgentName";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadSubagentUserMessage from "./ThreadSubagentUserMessage";

export default function ThreadAgentMessageItem ({
  children,
  fallbackName,
  subagent,
  target,
  thread,
}: {
  children: ReactNode;
  fallbackName?: string | null;
  subagent?: WorkbenchSubagentSummary | null;
  /** The messaged thread, or `parent` of the messaging subagent; shown as a thread button once loaded. */
  target?: { relation: "self" | "parent"; threadId: string } | null;
  thread?: ThreadPayload | null;
}) {
  const name = (
    <ThreadAgentName
      subagent={subagent}
      thread={thread ?? (fallbackName ? { agentNickname: fallbackName, agentRole: null } : null)}
    />
  );
  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 pl-6"
      summary={(
        <span className="inline-flex flex-wrap items-center gap-x-1.5">
          <span>Messaged</span>
          {/* Subagents keep their identity-coloured name as the link; other threads get the compact thread row. */}
          {target ? <WorkbenchThreadButton fallback={name} label={subagent ? name : undefined} relation={target.relation} threadId={target.threadId} /> : name}
        </span>
      )}
      summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
    >
      <ThreadSubagentUserMessage>{children}</ThreadSubagentUserMessage>
    </ThreadDisclosure>
  );
}
