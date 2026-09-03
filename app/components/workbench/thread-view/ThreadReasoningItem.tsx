/*
 * Exports:
 * - default ThreadReasoningItem: render exact-field reasoning sections with compact Markdown presentation. Keywords: reasoning, text, presentation, leaf.
 * Local component binds one reasoning section to its exact presentation field. Keywords: reasoning, section, subscription.
 */
"use client";

import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import type { InlineMentionHighlightSources } from "../../../workbench/thread/inline-mention-highlights";
import type { ThreadTextPresentationSource } from "../../../workbench/thread/ThreadTextPresentationController";
import ThreadMarkdown from "./ThreadMarkdown";
import useThreadPresentedText from "./use-thread-presented-text";

function joinClasses (...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

function ThreadReasoningSection({
  canonicalMarkdown,
  index,
  inlineMentionSources,
  itemId,
  presentationSource,
  source,
  threadCwdPath,
  threadId,
  turnId,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  canonicalMarkdown: string;
  index: number;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  itemId: string;
  presentationSource?: ThreadTextPresentationSource | null;
  source: "content" | "summary";
  threadCwdPath?: string;
  threadId: string;
  turnId: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const markdown = useThreadPresentedText({
    canonicalText: canonicalMarkdown,
    field: source === "summary" ? "reasoningSummary" : "reasoningContent",
    index,
    itemId,
    source: presentationSource,
    threadId,
    turnId,
  });
  return (
    <ThreadMarkdown
      inlineMentionSources={inlineMentionSources}
      markdown={markdown.replaceAll(/\n\n/g, "\n").trim()}
      threadCwdPath={threadCwdPath}
      projectFilePaths={projectFilePaths}
      projectId={projectId}
      projectRootPath={projectRootPath}
      revealAppends={Boolean(presentationSource)}
      workspaceRoots={workspaceRoots}
      className="text-[0.8em] text-muted"
    />
  );
}

export default function ThreadReasoningItem ({
  className,
  inlineMentionSources,
  item,
  presentationSource,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  threadId = "",
  turnId = "",
  workspaceRoots,
}: {
  className?: string;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  item: Extract<ThreadItem, { type: "reasoning" }>;
  presentationSource?: ThreadTextPresentationSource | null;
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  threadId?: string;
  turnId?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const visible = item.summary.length
    ? { sections: item.summary, source: "summary" as const }
    : { sections: item.content, source: "content" as const };

  return (
    <section className={joinClasses("space-y-2", className)}>
      {...visible.sections.map((summaryMarkdown, i) => (
        <ThreadReasoningSection
          key={i}
          canonicalMarkdown={summaryMarkdown}
          index={i}
          inlineMentionSources={inlineMentionSources}
          itemId={item.id}
          presentationSource={presentationSource}
          source={visible.source}
          threadCwdPath={threadCwdPath}
          threadId={threadId}
          turnId={turnId}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          workspaceRoots={workspaceRoots}
        />
      ))}
    </section>
  );
}
