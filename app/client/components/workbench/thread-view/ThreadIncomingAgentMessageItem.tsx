/*
 * Exports:
 * - default ThreadIncomingAgentMessageItem: shared attributed message body and delivery decoration.
 */
"use client";

import type { ComponentProps, ReactNode } from "react";
import type { WorkbenchAgentMessage } from "workbench-shared/workbench/thread/thread-agent-message";
import type { WorkbenchSubagentSummary } from "workbench-shared/types";
import ThreadAgentIncomingMessage from "./ThreadAgentIncomingMessage";
import ThreadMarkdown from "./ThreadMarkdown";
import type { ThreadSteerState } from "./ThreadSteerDecoration";

export default function ThreadIncomingAgentMessageItem({
  message,
  steerActions,
  steerState = null,
  subagent,
  timestamp,
  ...markdownProps
}: Omit<ComponentProps<typeof ThreadMarkdown>, "markdown"> & {
  message: WorkbenchAgentMessage;
  /** Resend/dismiss controls for an undelivered message. */
  steerActions?: ReactNode;
  steerState?: ThreadSteerState;
  subagent?: WorkbenchSubagentSummary | null;
  timestamp?: ReactNode;
}) {
  return (
    <ThreadAgentIncomingMessage
      name={message.senderName}
      senderThreadId={message.senderThreadId}
      steerActions={steerActions}
      steerState={steerState}
      subagent={subagent}
      timestamp={timestamp}
    >
      <ThreadMarkdown {...markdownProps} markdown={message.message} />
    </ThreadAgentIncomingMessage>
  );
}
