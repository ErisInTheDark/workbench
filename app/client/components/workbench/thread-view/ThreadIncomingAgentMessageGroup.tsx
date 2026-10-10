/*
 * Exports:
 * - default ThreadIncomingAgentMessageGroup: right-aligned disclosure grouping incoming agent messages, labelled by senders when delivered or by held counts (pending shimmering).
 */
"use client";

import { Fragment, type ReactNode } from "react";

import type { WorkbenchSubagentSummary } from "workbench-shared/types";
import { readWorkbenchAgentMessageItem } from "workbench-shared/workbench/thread/thread-agent-message";
import { shimmerTextClassName } from "../../../tailwind/shimmer-text-classes";
import { getSubagentSummary } from "../../../workbench/thread/thread-subagents";
import ThreadAgentName from "./ThreadAgentName";
import Disclosure from "../../ui/Disclosure";
import { getUserMessageDeliveryState, type IncomingAgentMessageItem } from "./thread-render-blocks";

function countLabel(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function ThreadIncomingAgentMessageGroupLabel({
  items,
  state,
  subagents,
}: {
  items: readonly IncomingAgentMessageItem[];
  state: "delivered" | "held";
  subagents: readonly WorkbenchSubagentSummary[];
}) {
  if (state === "held") {
    const unsent = items.filter((item) => item.type === "userMessage" && getUserMessageDeliveryState(item) === "unsent").length;
    const pending = items.length - unsent;
    // Pending messages are still on their way, so they shimmer like other live activity.
    return (
      <>
        {pending ? <span className={shimmerTextClassName}>{countLabel(pending, "incoming message")}…</span> : null}
        {pending && unsent ? ", " : null}
        {unsent ? countLabel(unsent, "undelivered message") : null}
      </>
    );
  }
  const senders = new Map<string, string>();
  for (const item of items) {
    const message = readWorkbenchAgentMessageItem(item);
    if (message && !senders.has(message.senderThreadId)) senders.set(message.senderThreadId, message.senderName);
  }
  return (
    <>
      Messaged by{" "}
      {[...senders].map(([threadId, name], index) => (
        <Fragment key={threadId}>
          {index ? ", " : null}
          <ThreadAgentName subagent={getSubagentSummary(subagents, threadId)} thread={{ agentNickname: name, agentRole: null }} />
        </Fragment>
      ))}
    </>
  );
}

export default function ThreadIncomingAgentMessageGroup({
  children,
  items,
  state,
  subagents,
}: {
  children: ReactNode;
  items: readonly IncomingAgentMessageItem[];
  state: "delivered" | "held";
  subagents: readonly WorkbenchSubagentSummary[];
}) {
  return (
    <Disclosure
      chevronSide="end"
      className="py-2"
      contentClassName="mt-1"
      // Agent chatter is rarely relevant to the user, so every group starts closed.
      // Collapsed messages stay in the DOM so find-in-page still reaches them.
      keepMounted
      summary={(
        <span className="block text-right">
          <ThreadIncomingAgentMessageGroupLabel items={items} state={state} subagents={subagents} />
        </span>
      )}
      summaryClassName="ml-auto w-fit text-[0.92em] leading-[1.6]"
    >
      {children}
    </Disclosure>
  );
}
