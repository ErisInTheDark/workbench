/*
 * Exports:
 * - default ThreadAgentMessageItem: render a sent cross-thread message as a disclosure naming the target thread button, with a left-aligned user-style bubble.
 * - ThreadAgentMessageTarget: render a sent message's resolved destination name or thread link.
 * - ThreadAgentMessageBubble: render only the sent-message bubble, optionally with destination attribution.
 */
"use client";

import type { ReactNode } from "react";

import type { ThreadPayload, WorkbenchSubagentSummary } from "workbench-shared/types";

import WorkbenchThreadButton from "../WorkbenchThreadButton";
import ThreadAgentName from "./ThreadAgentName";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadSubagentUserMessage from "./ThreadSubagentUserMessage";

interface ThreadAgentMessageTargetProps {
  fallbackName?: string | null;
  subagent?: WorkbenchSubagentSummary | null;
  /** The messaged thread, or `parent` of the messaging subagent; shown as a thread button once loaded. */
  target?: { relation: "self" | "parent"; threadId: string } | null;
  thread?: ThreadPayload | null;
}

export function ThreadAgentMessageTarget({
  fallbackName,
  subagent,
  target,
  thread,
}: ThreadAgentMessageTargetProps) {
  const name = (
    <ThreadAgentName
      subagent={subagent}
      thread={thread ?? (fallbackName ? { agentNickname: fallbackName, agentRole: null } : null)}
    />
  );
  return target
    ? <WorkbenchThreadButton fallback={name} label={subagent ? name : undefined} relation={target.relation} threadId={target.threadId} />
    : name;
}

export function ThreadAgentMessageBubble({
  children,
  recipient,
}: {
  children: ReactNode;
  recipient?: ReactNode;
}) {
  return (
    <ThreadSubagentUserMessage>
      {recipient ? (
        <div className="space-y-1.5">
          <p className="m-0 flex flex-wrap items-center gap-x-1.5 text-[0.78em] font-medium leading-[1.5] text-fg/muted">
            <span>Messaged</span>
            {recipient}
          </p>
          {children}
        </div>
      ) : children}
    </ThreadSubagentUserMessage>
  );
}

export default function ThreadAgentMessageItem ({
  children,
  ...targetProps
}: ThreadAgentMessageTargetProps & {
  children: ReactNode;
}) {
  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 pl-6"
      summary={(
        <span className="inline-flex flex-wrap items-center gap-x-1.5">
          <span>Messaged</span>
          <ThreadAgentMessageTarget {...targetProps} />
        </span>
      )}
      summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
    >
      <ThreadAgentMessageBubble>{children}</ThreadAgentMessageBubble>
    </ThreadDisclosure>
  );
}
