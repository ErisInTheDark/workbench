/*
 * Exports:
 * - default ThreadAgentIncomingMessage: render an attributed cross-agent message with shared steer decoration and left alignment. Keywords: agent, incoming, message, steer, bubble.
 */
"use client";

import type { ReactNode } from "react";

import type { WorkbenchSubagentSummary } from "workbench-shared/types";

import ThreadAgentName from "./ThreadAgentName";

export default function ThreadAgentIncomingMessage ({
  children,
  name,
  subagent,
  steerState,
  timestamp,
}: {
  children: ReactNode;
  name: string;
  subagent?: WorkbenchSubagentSummary | null;
  steerState: "pending" | "unsent" | null;
  timestamp?: ReactNode;
}) {
  const decorated = steerState !== null;
  const steerMessageClass = steerState ? ` thread-${steerState}-steer-message px-0.5 py-0.5` : "";
  return (
    <section
      className="flex flex-col items-start py-2"
      data-thread-user-message-state={steerState ? `${steerState}-agent-message` : "agent-message"}
    >
      <div className={`w-full max-w-[42rem]${decorated ? steerMessageClass : " rounded-[1.15rem] bg-[color-mix(in_srgb,var(--text)_6%,transparent)] [--fg-bg:color-mix(in_srgb,var(--text)_6%,var(--app-bg-solid))] px-4 py-3"}`}>
        <div className={`space-y-2 text-left${decorated ? " rounded-[1.15rem] bg-[color-mix(in_srgb,var(--text)_6%,transparent)] [--fg-bg:color-mix(in_srgb,var(--text)_6%,var(--app-bg-solid))] px-4 py-3" : ""}`}>
          <p className="m-0 text-[0.78em] font-medium leading-[1.5] text-fg/muted">
            <ThreadAgentName subagent={subagent} thread={{ agentNickname: name, agentRole: null }} /> sent a message
          </p>
          {children}
        </div>
      </div>
      {timestamp}
    </section>
  );
}
