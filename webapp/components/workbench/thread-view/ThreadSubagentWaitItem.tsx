/*
 * Exports:
 * - default ThreadSubagentWaitItem: render a relationship-aware subagent wait disclosure with a live child-thread preview. Keywords: workbench, thread, subagent, wait, preview.
 */
"use client";

import type { ReactNode } from "react";

import type { ThreadPayload, WorkbenchSubagentSummary } from "../../../lib/types";

import ThreadAgentName from "./ThreadAgentName";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadPreviewFrame from "./ThreadPreviewFrame";

export default function ThreadSubagentWaitItem ({
  active,
  children,
  subagent,
  thread,
  threadId,
}: {
  active: boolean;
  children?: ReactNode;
  subagent?: WorkbenchSubagentSummary | null;
  thread?: ThreadPayload | null;
  threadId: string;
}) {
  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 pl-6"
      defaultOpen={active}
      summary={(
        <span>
          {active ? "Waiting for " : "Waited for "}
          <ThreadAgentName fallbackKey={threadId} subagent={subagent} thread={thread} />
        </span>
      )}
      summaryClassName="text-[0.92em] leading-[1.6] text-muted"
    >
      {active && children ? (
        <ThreadPreviewFrame
          contentClassName="px-4 py-3 md:px-12"
          contentPadding="none"
          height="22rem"
          scale={0.9}
        >
          {children}
        </ThreadPreviewFrame>
      ) : null}
    </ThreadDisclosure>
  );
}
