"use client";

import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";
import type { WorkbenchFileOpenTarget } from "../../../lib/types";
import type { InlineMentionHighlightSources } from "../../../lib/workbench/thread/inline-mention-highlights";
import ThreadMarkdown from "./ThreadMarkdown";

function joinClasses (...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

export default function ThreadReasoningItem ({
  className,
  inlineMentionSources,
  item,
  onOpenFile,
  projectRootPath,
}: {
  className?: string;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  item: Extract<ThreadItem, { type: "reasoning" }>;
  onOpenFile?: (target: WorkbenchFileOpenTarget) => Promise<void>;
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
          onOpenFile={onOpenFile}
          projectRootPath={projectRootPath}
          className="text-[0.8em] text-muted"
        />
      ))}
    </section>
  );
}
