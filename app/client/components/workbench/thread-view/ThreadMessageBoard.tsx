/*
 * Exports:
 * - default ThreadMessageBoard: list a thread's direct subagents as forum-style message topics, settled first then oldest to newest activity so the latest sits nearest the composer.
 */
"use client";

import { useMemo } from "react";

import type { WorkbenchSubagentSummary } from "workbench-shared/types";
import ThreadMessageBoardTopic, { type ThreadMessageBoardMarkdownProps } from "./ThreadMessageBoardTopic";

export default function ThreadMessageBoard({
  markdownProps,
  projectId,
  subagents,
}: {
  markdownProps: ThreadMessageBoardMarkdownProps;
  projectId: string;
  /** Direct subagents of the thread; also used to colour sibling senders. */
  subagents: readonly WorkbenchSubagentSummary[];
}) {
  // Newest at the bottom, nearest the composer, like transcripts: settled topics first, then by ascending activity.
  const topics = useMemo(() => [...subagents].sort((left, right) => (
    Number(Boolean(right.lifecycle?.settled)) - Number(Boolean(left.lifecycle?.settled))
    || left.lastActivityAt - right.lastActivityAt
  )), [subagents]);
  return (
    <section aria-label="Subagent message board" className="flex flex-col gap-2 py-4">
      {topics.length ? topics.map((subagent) => (
        <ThreadMessageBoardTopic
          key={subagent.threadId}
          markdownProps={markdownProps}
          projectId={projectId}
          subagent={subagent}
          subagents={subagents}
        />
      )) : (
        <p className="m-0 py-6 text-center text-[0.92em] text-fg/muted">No subagents have messages yet.</p>
      )}
    </section>
  );
}
