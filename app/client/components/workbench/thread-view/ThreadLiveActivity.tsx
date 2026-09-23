/*
 * Exports:
 * - default ThreadLiveActivity: render user-owned live reasoning and terminal disclosure.
 */
"use client";

import { useState } from "react";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import type { InlineMentionHighlightSources } from "../../../workbench/thread/inline-mention-highlights";
import type { ThreadTextPresentationSource } from "../../../workbench/thread/ThreadTextPresentationController";
import { enterMotionClassName } from "../../../tailwind/enter-motion-classes";
import { shimmerTextClassName } from "../../../tailwind/shimmer-text-classes";
import ThreadDisclosure from "./ThreadDisclosure";
import { LoaderIcon } from "../workbench-icons";
import ThreadMarkdown from "./ThreadMarkdown";
import {
  projectThreadReasoningMarkdown,
} from "./thread-reasoning-display";
import { ThreadWebSearchActionRow } from "./ThreadWebSearchItem";
import useThreadPresentedText from "./use-thread-presented-text";
import type { LiveThreadActivity, ThreadTerminalContext, ThreadTerminalRetention } from "./thread-live-activity";
import ThreadCommandTerminal from "./ThreadCommandTerminal";
import ThreadScrollViewport, { ThreadScrollViewportEnd } from "./ThreadScrollViewport";

export default function ThreadLiveActivity({
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
  turnId: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const [isOpen, setIsOpen] = useState(false);
  const reasoningStep = activity?.kind === "reasoning" ? activity.hiddenStep : null;
  const presentedMarkdown = useThreadPresentedText({
    canonicalText: activity?.kind === "reasoning" ? activity.markdown ?? "" : "",
    field: reasoningStep?.source === "content" ? "reasoningContent" : "reasoningSummary",
    index: reasoningStep?.sectionIndex ?? null,
    itemId: reasoningStep?.itemId ?? "",
    source: reasoningStep ? presentationSource : null,
    threadId,
    turnId,
  });
  const reasoningDisplay = activity?.kind === "reasoning" && reasoningStep
    ? projectThreadReasoningMarkdown(presentedMarkdown)
    : activity?.kind === "reasoning"
      ? { body: activity.body, title: activity.title }
      : null;
  const activityTitle = reasoningDisplay?.title ?? activity?.title ?? "";

  const title = (
    <span className="inline-flex items-center gap-2">
      <LoaderIcon className="shrink-0" />
      <span className={`inline-block ${enterMotionClassName} ${shimmerTextClassName} -mt-0.5`} key={activityTitle}>{activityTitle}</span>
    </span>
  );

  if (!activity) return null;
  const showReasoning = Boolean(reasoningDisplay?.body || (activity.kind === "webSearch" && activity.contextItems.length));
  return (
    <div className="py-4">
      <ThreadDisclosure
        hideChevron
        className="group/live overflow-hidden rounded-[0.8rem] border border-transparent open:border-fg-alpha/16 open:bg-fg-alpha/3"
        contentClassName="flex h-[min(100vh,24rem)] flex-col"
        open={isOpen}
        onOffscreen={() => setIsOpen(false)}
        onToggle={event => setIsOpen(event.currentTarget.open)}
        summaryClassName="group-open/live:border-b group-open/live:border-fg-alpha/16 px-3 py-2 text-[0.92em] font-medium leading-[1.6]"
        summaryContentClassName="-mb-1"
        summary={<span aria-live="polite">{title}</span>}
      >
        {showReasoning ? (
          <ThreadScrollViewport resetKey={`${threadId}:${turnId}:reasoning`} className="flex-[0_1_auto] max-h-[30%] overscroll-contain border-b border-fg-alpha/16 [&_[data-thread-scroll-end=true]]:[scroll-margin-block-start:0]" contentClassName="px-3 py-2">
            {reasoningDisplay?.body ? <ThreadMarkdown
              className="text-[0.8em] text-fg/muted"
              inlineMentionSources={inlineMentionSources}
              markdown={reasoningDisplay.body}
              threadCwdPath={threadCwdPath}
              projectFilePaths={projectFilePaths}
              projectId={projectId}
              projectRootPath={projectRootPath}
              revealAppends={Boolean(presentationSource)}
              workspaceRoots={workspaceRoots}
            /> : activity?.kind === "webSearch" ? activity.contextItems.map(item => (
              <p key={item.id} className="m-0 text-[0.8em] text-fg/muted"><ThreadWebSearchActionRow item={item} /></p>
            )) : null}
            <ThreadScrollViewportEnd />
          </ThreadScrollViewport>
        ) : null}
        <ThreadCommandTerminal items={items} context={terminalContext} retention={terminalRetention} hasReasoning={showReasoning} open={isOpen} presentationSource={presentationSource} threadId={threadId} turnId={turnId} />
      </ThreadDisclosure>
    </div>
  );
}
