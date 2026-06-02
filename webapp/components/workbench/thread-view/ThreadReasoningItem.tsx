"use client";

import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";
import type { InlineMentionHighlightSources } from "../../../lib/workbench/thread/inline-mention-highlights";
import ThreadMarkdown from "./ThreadMarkdown";

function joinClasses (...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

export default function ThreadReasoningItem ({
  className,
  inlineMentionSources,
  item,
  projectFilePaths,
  projectId,
  projectRootPath,
}: {
  className?: string;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  item: Extract<ThreadItem, { type: "reasoning" }>;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
}) {
  const visibleSections = item.summary.length ? item.summary : item.content;

  return (
    <section className={joinClasses("space-y-2", className)}>
      {...visibleSections.map((summaryMarkdown, i) => (
        <ThreadMarkdown
          key={i}
          inlineMentionSources={inlineMentionSources}
          markdown={summaryMarkdown.replaceAll(/\n\n/g, "\n").trim()}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          className="text-[0.8em] text-muted"
        />
      ))}
    </section>
  );
}
