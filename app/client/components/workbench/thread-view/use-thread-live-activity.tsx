/*
 * Exports:
 * - ThreadLiveActivityView: a live turn's status title and its reasoning and terminal body, for the thread status row.
 * - default useThreadLiveActivity: present one live turn's reasoning and terminal activity.
 */
"use client";

import type { ReactNode } from "react";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import type { InlineMentionHighlightSources } from "../../../workbench/thread/inline-mention-highlights";
import type { ThreadTextPresentationSource } from "../../../workbench/thread/ThreadTextPresentationController";
import { enterMotionClassName } from "../../../tailwind/enter-motion-classes";
import { shimmerTextClassName } from "../../../tailwind/shimmer-text-classes";
import { LoaderIcon } from "../workbench-icons";
import MarkdownRender from "../../ui/MarkdownRender";
import { projectThreadReasoningMarkdown } from "./thread-reasoning-display";
import { ThreadWebSearchActionRow } from "./ThreadWebSearchItem";
import useThreadPresentedText from "./use-thread-presented-text";
import type { LiveThreadActivity, ThreadTerminalContext, ThreadTerminalRetention } from "./thread-live-activity";
import ThreadCommandTerminal from "./ThreadCommandTerminal";
import ThreadScrollViewport, { ThreadScrollViewportEnd } from "./ThreadScrollViewport";

export interface ThreadLiveActivityView {
  /** Changes with each turn, so a reopened row never shows the previous turn's panel. */
  key: string;
  title: ReactNode;
  renderBody(open: boolean): ReactNode;
}

export default function useThreadLiveActivity({
  activity,
  items,
  terminalContext,
  terminalRetention,
  inlineMentionSources,
  presentationSource,
  projectFilePaths,
  projectId,
  projectRootPath,
  threadCwdPath,
  threadId,
  turnId,
  workspaceRoots,
}: {
  activity: LiveThreadActivity | null;
  items: readonly ThreadItem[];
  terminalContext: ThreadTerminalContext;
  terminalRetention: Omit<ThreadTerminalRetention, "now">;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  presentationSource?: ThreadTextPresentationSource | null;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  threadCwdPath?: string;
  threadId: string;
  /** Null without a live turn. */
  turnId: string | null;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}): ThreadLiveActivityView | null {
  const reasoningStep = activity?.kind === "reasoning" ? activity.hiddenStep : null;
  const presentedMarkdown = useThreadPresentedText({
    canonicalText: activity?.kind === "reasoning" ? activity.markdown ?? "" : "",
    field: reasoningStep?.source === "content" ? "reasoningContent" : "reasoningSummary",
    index: reasoningStep?.sectionIndex ?? null,
    itemId: reasoningStep?.itemId ?? "",
    source: reasoningStep ? presentationSource : null,
    threadId,
    turnId: turnId ?? "",
  });
  if (!activity || !turnId) return null;
  const reasoningDisplay = activity.kind === "reasoning" && reasoningStep
    ? projectThreadReasoningMarkdown(presentedMarkdown)
    : activity.kind === "reasoning"
      ? { body: activity.body, title: activity.title }
      : null;
  const activityTitle = reasoningDisplay?.title ?? activity.title ?? "";
  const showReasoning = Boolean(reasoningDisplay?.body || (activity.kind === "webSearch" && activity.contextItems.length));
  return {
    key: `${threadId}:${turnId}`,
    title: (
      <span className="flex min-w-0 items-center gap-2">
        <LoaderIcon className="shrink-0" />
        <span className={`inline-block truncate ${enterMotionClassName} ${shimmerTextClassName} -mt-0.5`} key={activityTitle}>{activityTitle}</span>
      </span>
    ),
    renderBody: (open) => (
      <div className="flex h-full flex-col">
        {showReasoning ? (
          <ThreadScrollViewport resetKey={`${threadId}:${turnId}:reasoning`} className="flex-[0 1 auto] max-h-[30%] overscroll-contain border-b border-fg-alpha/16 [& [data-thread-scroll-end=true]]:[scroll-margin-block-start: 0]" contentClassName="px-3 py-2">
            {reasoningDisplay?.body ? <MarkdownRender
              className="text-[0.8em] text-fg/muted"
              inlineMentionSources={inlineMentionSources}
              markdown={reasoningDisplay.body}
              threadCwdPath={threadCwdPath}
              projectFilePaths={projectFilePaths}
              projectId={projectId}
              projectRootPath={projectRootPath}
              revealAppends={Boolean(presentationSource)}
              workspaceRoots={workspaceRoots}
            /> : activity.kind === "webSearch" ? activity.contextItems.map(item => (
              <p key={item.id} className="m-0 text-[0.8em] text-fg/muted"><ThreadWebSearchActionRow item={item} /></p>
            )) : null}
            <ThreadScrollViewportEnd />
          </ThreadScrollViewport>
        ) : null}
        <ThreadCommandTerminal items={items} context={terminalContext} retention={terminalRetention} hasReasoning={showReasoning} open={open} presentationSource={presentationSource} threadId={threadId} turnId={turnId} />
      </div>
    ),
  };
}
