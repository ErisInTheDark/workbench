/*
 * Exports:
 * - default ThreadUserMessageItem: one user message as right-aligned bubbles (references, steer state, copy and undelivered-steer actions),
 *   or the agent message or screenshot steer it carries.
 * - ThreadUserMessageSequence: consecutive steers merged into one bubble stamped with the last one's time.
 * Keep runtime exports component-only for React Refresh.
 */
"use client";

import type { ThreadItem, UserInput } from "workbench-shared/workbench/thread/workbench-thread-items";
import { readComposerReferenceMessage, type ComposerReference } from "workbench-shared/workbench/thread/composer-reference";
import { readWorkbenchAgentMessageInput } from "workbench-shared/workbench/thread/thread-agent-message";
import { unwrapWorkbenchSteerDisplayInput } from "workbench-shared/workbench/thread/thread-steer-display";
import {
  getAgentScreenshotSteerImages,
  isAgentScreenshotSteerUserMessage,
  isHiddenAgentScreenshotContent,
} from "workbench-shared/workbench/thread/thread-steer-markers";
import { isUndeliveredInitialOptimisticInputItem } from "../../../../workbench/thread/thread-optimistic-items";
import { getSubagentSummary } from "../../../../workbench/thread/thread-subagents";
import MarkdownRender from "../../../ui/MarkdownRender";
import { useTranscript } from "../../use-transcript";
import { getUserMessageCopyMarkdown } from "../bubble-copy";
import ComposerReferencePills from "../ComposerReferencePills";
import ThreadAgentScreenshotItem from "../ThreadAgentScreenshotItem";
import ThreadBubbleCopyButton from "../ThreadBubbleCopyButton";
import ThreadIncomingAgentMessageItem from "../ThreadIncomingAgentMessageItem";
import ThreadMessageTimestamp from "../ThreadMessageTimestamp";
import ThreadSteerDecoration from "../ThreadSteerDecoration";
import ThreadUserImage from "../ThreadUserImage";
import { getUserMessageDeliveryState } from "../thread-render-blocks";
import { splitUserMessageBubbles } from "../user-message-bubbles";
import { UndeliveredSteerActions } from "./ThreadItemActionControls";

type UserMessageItem = Extract<ThreadItem, { type: "userMessage" }>;

function ThreadUserInputLine ({ input }: { input: UserInput }) {
  const markdownProps = useTranscript.markdownProps();
  switch (input.type) {
    case "text": {
      const text = input.text.trim();
      return <MarkdownRender {...markdownProps} className="[&>p]:mb-[0.45em]" markdown={text || "No text captured."} />;
    }
    case "image":
      return <ThreadUserImage alt="User-provided image" className="max-w-[22rem]" src={input.url} />;
    case "localImage":
      return (
        <p className="m-0 break-all font-mono text-[0.78em] leading-[1.6] text-fg/muted">
          Local image: {input.path}
        </p>
      );
    case "skill":
      return (
        <p className="m-0 text-[0.92em] leading-[1.6] text-fg/muted">
          Skill: <span className="text-text">{input.name}</span>{" "}
          <span className="break-all font-mono text-[0.78em]">({input.path})</span>
        </p>
      );
    case "mention":
      return (
        <p className="m-0 text-[0.92em] leading-[1.6] text-fg/muted">
          Mention: <span className="text-text">{input.name}</span>{" "}
          <span className="break-all font-mono text-[0.78em]">({input.path})</span>
        </p>
      );
    default:
      return null;
  }
}

/** References lead a message's first text part; the rest of that part is the user's own words. */
function splitLeadingComposerReferences(content: UserInput[]): { content: UserInput[]; references: ComposerReference[] } {
  const [first, ...rest] = content;
  const read = first?.type === "text" ? readComposerReferenceMessage(first.text) : null;
  if (!first || first.type !== "text" || !read) return { content, references: [] };
  return {
    content: read.message ? [{ ...first, text: read.message, text_elements: [] }, ...rest] : rest,
    references: read.references,
  };
}

export default function ThreadUserMessageItem ({
  item,
  sourceItems,
  startedAt,
}: {
  item: UserMessageItem;
  /** The stored messages a merged bubble shows; defaults to `item` itself. */
  sourceItems?: readonly UserMessageItem[];
  startedAt: number | null;
}) {
  const transcript = useTranscript();
  const markdownProps = useTranscript.markdownProps();
  const agentMessage = readWorkbenchAgentMessageInput(item.content);
  if (agentMessage) {
    const steerState = getUserMessageDeliveryState(item);
    return (
      <ThreadIncomingAgentMessageItem
        {...markdownProps}
        messages={[agentMessage]}
        steerState={steerState}
        steerActions={steerState === "unsent" ? <UndeliveredSteerActions items={sourceItems ?? [item]} /> : undefined}
        subagent={getSubagentSummary(transcript.subagents, agentMessage.senderThreadId)}
        timestamp={<ThreadMessageTimestamp className="mt-1" timestampSeconds={startedAt} />}
      />
    );
  }

  if (isAgentScreenshotSteerUserMessage(item)) {
    if (isHiddenAgentScreenshotContent(item.content)) return null;
    return (
      <ThreadAgentScreenshotItem
        images={getAgentScreenshotSteerImages(item).map((image) => image.url)}
        timestamp={<ThreadMessageTimestamp className="mt-1" timestampSeconds={startedAt} />}
      />
    );
  }

  const steerState = getUserMessageDeliveryState(item);
  const isPendingInitial = isUndeliveredInitialOptimisticInputItem(item);
  const { content: displayContent, references } = splitLeadingComposerReferences(unwrapWorkbenchSteerDisplayInput(item.content));
  // `=====` lines split one stored message into several bubbles; the agent still receives the whole message.
  const bubbles = splitUserMessageBubbles(displayContent);
  if (!bubbles.length && !references.length) return null;
  return (
    <section
      className="flex flex-col items-end gap-2 py-2"
      data-thread-user-message-state={isPendingInitial ? "pending-initial" : steerState ? `${steerState}-steer` : undefined}
    >
      {(bubbles.length ? bubbles : [[]]).map((bubble, bubbleIndex) => (
        <div className="group/thread-bubble relative w-fit max-w-[min(100%,42rem)]" key={`${item.id}:bubble:${bubbleIndex}`}>
          <ThreadSteerDecoration className="space-y-2 text-left" state={isPendingInitial ? "pending" : steerState}>
            {/* References lead the first bubble like its opening paragraph. */}
            {bubbleIndex === 0 ? <ComposerReferencePills references={references} /> : null}
            {bubble.map((content, index) => (
              <ThreadUserInputLine key={`${item.id}:content:${bubbleIndex}:${index}:${content.type}`} input={content} />
            ))}
          </ThreadSteerDecoration>
          <ThreadBubbleCopyButton
            actions={steerState === "unsent" && bubbleIndex === bubbles.length - 1
              ? <UndeliveredSteerActions items={sourceItems ?? [item]} />
              : undefined}
            markdown={getUserMessageCopyMarkdown(bubble)}
            side="right"
          />
        </div>
      ))}
      <ThreadMessageTimestamp align="right" className="-mt-1" timestampSeconds={startedAt} />
    </section>
  );
}

function mergeSteerUserMessages(items: readonly UserMessageItem[]): UserMessageItem {
  const first = items[0]!;
  const last = items.at(-1)!;
  return {
    ...last,
    content: [{
      text: items.map((item) => getUserMessageCopyMarkdown(unwrapWorkbenchSteerDisplayInput(item.content))).join("\n\n"),
      text_elements: [],
      type: "text" as const,
    }],
    id: `${first.id}:through:${last.id}`,
  };
}

export function ThreadUserMessageSequence ({ items, startedAt }: { items: readonly UserMessageItem[]; startedAt: number | null }) {
  return <ThreadUserMessageItem item={mergeSteerUserMessages(items)} sourceItems={items} startedAt={startedAt} />;
}
