/*
 * Exports:
 * - default ThreadAgentIncomingMessage: render a cross-agent message attributed by a sender thread button, with shared steer delivery decoration, undelivered controls and right alignment.
 */
"use client";

import type { ReactNode } from "react";

import type { WorkbenchSubagentSummary } from "workbench-shared/types";

import WorkbenchThreadButton from "../WorkbenchThreadButton";
import ThreadAgentName from "./ThreadAgentName";
import ThreadBubbleCopyButton from "./ThreadBubbleCopyButton";
import ThreadSteerDecoration, { type ThreadSteerState } from "./ThreadSteerDecoration";

export default function ThreadAgentIncomingMessage ({
  children,
  name,
  senderThreadId,
  steerActions,
  subagent,
  steerState,
  timestamp,
}: {
  children: ReactNode;
  name: string;
  senderThreadId?: string | null;
  /** Resend/dismiss controls shown on hover while the message is undelivered. */
  steerActions?: ReactNode;
  subagent?: WorkbenchSubagentSummary | null;
  steerState: ThreadSteerState;
  timestamp?: ReactNode;
}) {
  return (
    <section
      className="flex flex-col items-end py-2"
      data-thread-user-message-state={steerState ? `${steerState}-agent-message` : "agent-message"}
    >
      <div className="group/thread-bubble relative w-fit min-w-0 max-w-[min(100%,42rem)] [overflow-wrap:anywhere]">
        <ThreadSteerDecoration className="space-y-2 text-left" state={steerState}>
          <p className="m-0 flex flex-wrap items-center gap-x-1.5 text-[0.78em] font-medium leading-[1.5] text-fg/muted">
            {/* Subagents keep their identity-coloured name as the link; other threads get the compact thread row. */}
            {senderThreadId ? (
              <WorkbenchThreadButton
                fallback={<ThreadAgentName subagent={subagent} thread={{ agentNickname: name, agentRole: null }} />}
                label={subagent ? <ThreadAgentName subagent={subagent} thread={{ agentNickname: name, agentRole: null }} /> : undefined}
                threadId={senderThreadId}
              />
            ) : <ThreadAgentName subagent={subagent} thread={{ agentNickname: name, agentRole: null }} />}
            <span>sent a message</span>
          </p>
          {children}
        </ThreadSteerDecoration>
        {steerActions ? <ThreadBubbleCopyButton actions={steerActions} markdown="" side="right" /> : null}
      </div>
      {timestamp}
    </section>
  );
}
