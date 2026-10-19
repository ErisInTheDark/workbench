/*
 * Exports:
 * - default ThreadReasoningItem: render exact-field reasoning sections with compact Markdown presentation. Keywords: reasoning, text, presentation, leaf.
 * Local component binds one reasoning section to its exact presentation field. Keywords: reasoning, section, subscription.
 */
"use client";

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import type { InlineMentionHighlightSources } from "../../../workbench/thread/inline-mention-highlights";
import type { ThreadTextPresentationSource } from "../../../workbench/thread/ThreadTextPresentationController";
import MarkdownRender from "../../ui/MarkdownRender";
import { useTranscript } from "../use-transcript";

function joinClasses (...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

function ThreadReasoningSection({
  canonicalMarkdown,
  index,
  inlineMentionSources,
  isMostRecent,
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
  isMostRecent: boolean;
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
  const markdown = useTranscript.presentedText({
    canonicalText: canonicalMarkdown,
    field: source === "summary" ? "reasoningSummary" : "reasoningContent",
    index,
    itemId,
    source: presentationSource,
    threadId,
    turnId,
  });
  return (
    <MarkdownRender
      inlineMentionSources={inlineMentionSources}
      markdown={markdown.replaceAll(/\n\n/g, "\n").trim()}
      threadCwdPath={threadCwdPath}
      projectFilePaths={projectFilePaths}
      projectId={projectId}
      projectRootPath={projectRootPath}
      live={Boolean(presentationSource)}
      streaming={Boolean(presentationSource) && (isMostRecent || markdown !== canonicalMarkdown)}
      workspaceRoots={workspaceRoots}
      className="text-[0.8em] text-fg/muted"
    />
  );
}

export default function ThreadReasoningItem ({
  className,
  inlineMentionSources,
  isMostRecent = false,
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
  /** Nothing follows this item yet, so its last section may still be streaming. */
  isMostRecent?: boolean;
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
          isMostRecent={isMostRecent && i === visible.sections.length - 1}
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
