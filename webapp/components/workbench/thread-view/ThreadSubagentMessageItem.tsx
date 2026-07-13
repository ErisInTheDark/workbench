/*
 * Exports:
 * - default ThreadSubagentMessageItem: render a sent subagent steer as a relationship disclosure with a left-aligned user-style bubble. Keywords: workbench, thread, subagent, message, steer, user bubble.
 */
"use client";

import type { ReactNode } from "react";

import type { ThreadPayload, WorkbenchSubagentSummary } from "../../../lib/types";

import ThreadAgentName from "./ThreadAgentName";
import ThreadDisclosure from "./ThreadDisclosure";

export default function ThreadSubagentMessageItem ({
  children,
  subagent,
  thread,
  threadId,
}: {
  children: ReactNode;
  subagent?: WorkbenchSubagentSummary | null;
  thread?: ThreadPayload | null;
  threadId: string;
}) {
  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 pl-6"
      summary={(
        <span>
          Messaged <ThreadAgentName fallbackKey={threadId} subagent={subagent} thread={thread} />
        </span>
      )}
      summaryClassName="text-[0.92em] leading-[1.6] text-muted"
    >
      <section className="flex flex-col items-start py-2">
        <div className="w-full max-w-[42rem] rounded-[1.15rem] bg-[color-mix(in_srgb,var(--text)_6%,transparent)] px-4 py-3 text-left">
          {children}
        </div>
      </section>
    </ThreadDisclosure>
  );
}
