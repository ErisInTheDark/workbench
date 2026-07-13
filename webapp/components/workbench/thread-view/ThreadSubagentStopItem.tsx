/*
 * Exports:
 * - default ThreadSubagentStopItem: render a successful or active subagent stop command with its durable person identity. Keywords: workbench, thread, subagent, stop, identity.
 */
"use client";

import type { ThreadPayload, WorkbenchSubagentSummary } from "../../../lib/types";

import ThreadAgentName from "./ThreadAgentName";
import ThreadDisclosure from "./ThreadDisclosure";

export default function ThreadSubagentStopItem ({
  active,
  subagent,
  thread,
  threadId,
}: {
  active: boolean;
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
          {active ? "Stopping " : "Stopped "}
          <ThreadAgentName fallbackKey={threadId} subagent={subagent} thread={thread} />
        </span>
      )}
      summaryClassName="text-[0.92em] leading-[1.6] text-muted"
    >
      <></>
    </ThreadDisclosure>
  );
}
