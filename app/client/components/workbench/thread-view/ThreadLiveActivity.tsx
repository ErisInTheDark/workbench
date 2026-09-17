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
      <span className="thread-live-status-enter thread-thinking-text -mt-0.5" key={activityTitle}>{activityTitle}</span>
    </span>
  );

  if (!activity) return null;
  return (
    <div className="py-4">
      <ThreadDisclosure
        hideChevron
        className="thread-live-disclosure"
        contentClassName="thread-live-content"
        open={isOpen}
        onOffscreen={() => setIsOpen(false)}
        onToggle={event => setIsOpen(event.currentTarget.open)}
        summaryClassName="thread-live-summary text-[0.92em] font-medium leading-[1.6]"
        summaryContentClassName="-mb-1"
        summary={<span aria-live="polite">{title}</span>}
      >
        {reasoningDisplay?.body || (activity?.kind === "webSearch" && activity.contextItems.length) ? (
          <ThreadScrollViewport resetKey={`${threadId}:${turnId}:reasoning`} className="thread-live-reasoning" contentClassName="px-3 py-2">
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
        <ThreadCommandTerminal items={items} context={terminalContext} retention={terminalRetention} open={isOpen} presentationSource={presentationSource} threadId={threadId} turnId={turnId} />
      </ThreadDisclosure>
    </div>
  );
}
