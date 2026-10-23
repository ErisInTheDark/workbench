/*
 * Exports:
 * - default ThreadReasoningItem: render exact-field reasoning sections with compact Markdown presentation, hydrating a
 *   deferred item's full text on mount (so mount it only where it shows). Keywords: reasoning, text, presentation, leaf.
 * Local component binds one reasoning section to its exact presentation field. Keywords: reasoning, section, subscription.
 */
"use client";

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { ThreadTextPresentationSource } from "../../../workbench/thread/ThreadTextPresentationController";
import MarkdownRender from "../../ui/MarkdownRender";
import { useTranscript } from "../use-transcript";
import ThreadDeferredBodyAlert from "./ThreadDeferredBodyAlert";

function joinClasses (...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

function ThreadReasoningSection({
  canonicalMarkdown,
  index,
  isMostRecent,
  itemId,
  presentationSource,
  source,
  threadId,
  turnId,
}: {
  canonicalMarkdown: string;
  index: number;
  isMostRecent: boolean;
  itemId: string;
  presentationSource?: ThreadTextPresentationSource | null;
  source: "content" | "summary";
  threadId: string;
  turnId: string;
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
      className="text-[0.8em] text-fg/muted"
      live={Boolean(presentationSource)}
      markdown={markdown.replaceAll(/\n\n/g, "\n").trim()}
      streaming={Boolean(presentationSource) && (isMostRecent || markdown !== canonicalMarkdown)}
    />
  );
}

export default function ThreadReasoningItem ({
  className,
  isMostRecent = false,
  item,
  presentationSource,
  threadId = "",
  turnId = "",
}: {
  className?: string;
  /** Nothing follows this item yet, so its last section may still be streaming. */
  isMostRecent?: boolean;
  item: Extract<ThreadItem, { type: "reasoning" }>;
  presentationSource?: ThreadTextPresentationSource | null;
  threadId?: string;
  turnId?: string;
}) {
  const body = useTranscript.item(item);
  const visible = body.item.summary.length
    ? { sections: body.item.summary, source: "summary" as const }
    : { sections: body.item.content, source: "content" as const };

  return (
    <section className={joinClasses("space-y-2", className)}>
      {...visible.sections.map((summaryMarkdown, i) => (
        <ThreadReasoningSection
          key={i}
          canonicalMarkdown={summaryMarkdown}
          index={i}
          isMostRecent={isMostRecent && i === visible.sections.length - 1}
          itemId={item.id}
          presentationSource={presentationSource}
          source={visible.source}
          threadId={threadId}
          turnId={turnId}
        />
      ))}
      <ThreadDeferredBodyAlert body={body} noun="Reasoning" />
    </section>
  );
}
