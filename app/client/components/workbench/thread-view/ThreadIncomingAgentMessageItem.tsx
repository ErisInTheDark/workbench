/*
 * Keywords: incoming agent, attribution, legacy steer, native output.
 * Exports:
 * - default ThreadIncomingAgentMessageItem: shared attributed message body and delivery decoration.
 */
"use client";

import type { ComponentProps, ReactNode } from "react";
import type { WorkbenchAgentMessage } from "workbench-shared/workbench/thread/thread-agent-message";
import type { WorkbenchSubagentSummary } from "workbench-shared/types";
import ThreadAgentIncomingMessage from "./ThreadAgentIncomingMessage";
import ThreadMarkdown from "./ThreadMarkdown";

export default function ThreadIncomingAgentMessageItem({
  message,
  steerState = null,
  subagent,
  timestamp,
  ...markdownProps
}: Omit<ComponentProps<typeof ThreadMarkdown>, "markdown"> & {
  message: WorkbenchAgentMessage;
  steerState?: "pending" | "unsent" | null;
  subagent?: WorkbenchSubagentSummary | null;
  timestamp?: ReactNode;
}) {
  return (
    <ThreadAgentIncomingMessage name={message.senderName} steerState={steerState} subagent={subagent} timestamp={timestamp}>
      <ThreadMarkdown {...markdownProps} markdown={message.message} />
    </ThreadAgentIncomingMessage>
  );
}
