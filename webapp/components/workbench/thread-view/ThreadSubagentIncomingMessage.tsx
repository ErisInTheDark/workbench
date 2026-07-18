/*
 * Exports:
 * - default ThreadSubagentIncomingMessage: render a direct child-to-parent message with sender heading, shared steer decoration, and left alignment. Keywords: subagent, parent, incoming, message, steer, bubble.
 */
"use client";

import type { ReactNode } from "react";

import type { WorkbenchSubagentSummary } from "../../../lib/types";

import ThreadAgentName from "./ThreadAgentName";

export default function ThreadSubagentIncomingMessage ({
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
      data-thread-user-message-state={steerState ? `${steerState}-subagent-message` : "subagent-message"}
    >
      <div className={`w-full max-w-[42rem]${decorated ? steerMessageClass : " rounded-[1.15rem] bg-[color-mix(in_srgb,var(--text)_6%,transparent)] px-4 py-3"}`}>
        <div className={`space-y-2 text-left${decorated ? " rounded-[1.15rem] bg-[color-mix(in_srgb,var(--text)_6%,transparent)] px-4 py-3" : ""}`}>
          <p className="m-0 text-[0.78em] font-medium leading-[1.5] text-muted">
            <ThreadAgentName subagent={subagent} thread={{ agentNickname: name, agentRole: null }} /> sent a message
          </p>
          {children}
        </div>
      </div>
      {timestamp}
    </section>
  );
}
