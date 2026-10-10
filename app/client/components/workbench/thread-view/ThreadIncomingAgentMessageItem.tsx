/*
 * Exports:
 * - default ThreadIncomingAgentMessageItem: shared attributed bubble for one sender's consecutive messages (simple versions first) and delivery decoration.
 */
"use client";

import type { ComponentProps, ReactNode } from "react";
import type { WorkbenchAgentMessage } from "workbench-shared/workbench/thread/thread-agent-message";
import type { WorkbenchSubagentSummary } from "workbench-shared/types";
import ThreadAgentIncomingMessage from "./ThreadAgentIncomingMessage";
import ThreadAgentMessageBody from "./ThreadAgentMessageBody";
import MarkdownRender from "../../ui/MarkdownRender";
import type { ThreadSteerState } from "./ThreadSteerDecoration";

export default function ThreadIncomingAgentMessageItem({
  messages,
  steerActions,
  steerState = null,
  subagent,
  timestamp,
  ...markdownProps
}: Omit<ComponentProps<typeof MarkdownRender>, "markdown"> & {
  /** One sender's messages, oldest first; the bubble is attributed to the first. */
  messages: readonly [WorkbenchAgentMessage, ...WorkbenchAgentMessage[]];
  /** Resend/dismiss controls for undelivered messages. */
  steerActions?: ReactNode;
  steerState?: ThreadSteerState;
  subagent?: WorkbenchSubagentSummary | null;
  timestamp?: ReactNode;
}) {
  const [first] = messages;
  return (
    <ThreadAgentIncomingMessage
      name={first.senderName}
      senderThreadId={first.senderThreadId}
      steerActions={steerActions}
      steerState={steerState}
      subagent={subagent}
      timestamp={timestamp}
    >
      <ThreadAgentMessageBody
        {...markdownProps}
        parts={messages.map((message) => ({ markdown: message.message, userVisibleSimpleVersion: message.userVisibleSimpleVersion }))}
      />
    </ThreadAgentIncomingMessage>
  );
}
