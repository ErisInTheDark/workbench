/*
 * Exports:
 * - LiveThreadActivity: current reasoning or web-search presentation input. Keywords: thread, live, reasoning, web search.
 * - default ThreadLiveActivity: render live activity and subscribe only to its exact reasoning field. Keywords: thread, live, presentation, leaf.
 */
"use client";

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import type { InlineMentionHighlightSources } from "../../../workbench/thread/inline-mention-highlights";
import type { ThreadTextPresentationSource } from "../../../workbench/thread/ThreadTextPresentationController";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadMarkdown from "./ThreadMarkdown";
import {
  projectThreadReasoningMarkdown,
  type ThreadReasoningStepReference,
} from "./thread-reasoning-display";
import { ThreadWebSearchActionRow } from "./ThreadWebSearchItem";
import useThreadPresentedText from "./use-thread-presented-text";

export type LiveThreadActivity =
  | {
    body: string | null;
    hiddenStep: ThreadReasoningStepReference | null;
    kind: "reasoning";
    markdown: string | null;
    title: string;
  }
  | {
    contextItems: Array<Extract<ThreadItem, { type: "webSearch" }>>;
    hiddenItemIds: string[];
    kind: "webSearch";
    title: string;
  };

export default function ThreadLiveActivity({
  activity,
  inlineMentionSources,
  isOpen,
  onOpenChange,
  presentationSource,
  projectFilePaths,
  projectId,
  projectRootPath,
  threadCwdPath,
  threadId,
  turnId,
  workspaceRoots,
}: {
  activity: LiveThreadActivity;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  presentationSource?: ThreadTextPresentationSource | null;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  threadCwdPath?: string;
  threadId: string;
  turnId: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const reasoningStep = activity.kind === "reasoning" ? activity.hiddenStep : null;
  const presentedMarkdown = useThreadPresentedText({
    canonicalText: activity.kind === "reasoning" ? activity.markdown ?? "" : "",
    field: reasoningStep?.source === "content" ? "reasoningContent" : "reasoningSummary",
    index: reasoningStep?.sectionIndex ?? null,
    itemId: reasoningStep?.itemId ?? "",
    source: reasoningStep ? presentationSource : null,
    threadId,
    turnId,
  });
  const reasoningDisplay = activity.kind === "reasoning" && reasoningStep
    ? projectThreadReasoningMarkdown(presentedMarkdown)
    : activity.kind === "reasoning"
      ? { body: activity.body, title: activity.title }
      : null;

  return (
    <div className="py-4" aria-live="polite">
      {activity.kind === "webSearch" ? (
        activity.contextItems.length ? (
          <ThreadDisclosure
            contentClassName="mt-2 space-y-1 pl-6"
            open={isOpen}
            onToggle={(event) => onOpenChange(event.currentTarget.open)}
            summary={<span className="thread-thinking-text">{activity.title}</span>}
            summaryClassName="text-[0.92em] font-medium leading-[1.6]"
          >
            {activity.contextItems.map((item) => (
              <p key={item.id} className="m-0 text-[0.92em] leading-[1.6] text-fg/muted">
                <ThreadWebSearchActionRow item={item} />
              </p>
            ))}
          </ThreadDisclosure>
        ) : (
          <p className="thread-thinking-text m-0 text-[0.92em] font-medium leading-[1.6]">
            {activity.title}
          </p>
        )
      ) : reasoningDisplay?.body ? (
        <ThreadDisclosure
          contentClassName="mt-2"
          open={isOpen}
          onToggle={(event) => onOpenChange(event.currentTarget.open)}
          summaryClassName="text-[0.92em] font-medium leading-[1.6]"
          summary={<span className="thread-thinking-text">{reasoningDisplay.title}</span>}
        >
          <ThreadMarkdown
            className="text-[0.8em] text-fg/muted"
            inlineMentionSources={inlineMentionSources}
            markdown={reasoningDisplay.body}
            threadCwdPath={threadCwdPath}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            revealAppends={Boolean(presentationSource)}
            workspaceRoots={workspaceRoots}
          />
        </ThreadDisclosure>
      ) : (
        <p className="thread-thinking-text m-0 text-[0.92em] font-medium leading-[1.6]">
          {reasoningDisplay?.title ?? activity.title}
        </p>
      )}
    </div>
  );
}
