"use client";

import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";
import type { WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import type { InlineMentionHighlightSources } from "../../../lib/workbench/thread/inline-mention-highlights";
import ThreadMarkdown from "./ThreadMarkdown";

function joinClasses (...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

export default function ThreadReasoningItem ({
  className,
  inlineMentionSources,
  item,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  className?: string;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  item: Extract<ThreadItem, { type: "reasoning" }>;
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const visibleSections = item.summary.length ? item.summary : item.content;

  return (
    <section className={joinClasses("space-y-2", className)}>
      {...visibleSections.map((summaryMarkdown, i) => (
        <ThreadMarkdown
          key={i}
          inlineMentionSources={inlineMentionSources}
          markdown={summaryMarkdown.replaceAll(/\n\n/g, "\n").trim()}
          threadCwdPath={threadCwdPath}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          workspaceRoots={workspaceRoots}
          className="text-[0.8em] text-muted"
        />
      ))}
    </section>
  );
}
