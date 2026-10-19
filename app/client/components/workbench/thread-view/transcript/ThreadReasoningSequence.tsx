/*
 * Exports:
 * - default ThreadReasoningSequence: consecutive reasoning as one step row: a single step reads as its title and streams its body,
 *   several steps open onto each item's reasoning.
 */
"use client";

import MarkdownRender from "../../../ui/MarkdownRender";
import { CheckIcon, LoaderIcon } from "../../workbench-icons";
import { useTranscript } from "../../use-transcript";
import ThreadReasoningItem from "../ThreadReasoningItem";
import ThreadStepRow from "../ThreadStepRow";
import { getThreadReasoningSteps, projectThreadReasoningMarkdown } from "../thread-reasoning-display";
import { hasReasoningSteps, type ThreadRenderableBlock } from "../thread-render-blocks";

export default function ThreadReasoningSequence ({
  block,
  isMostRecent,
}: {
  block: Extract<ThreadRenderableBlock, { kind: "reasoningSequence" }>;
  isMostRecent: boolean;
}) {
  const transcript = useTranscript();
  const turn = useTranscript.turn();
  const markdownProps = useTranscript.markdownProps();
  const presentationSource = turn.presentationSource;
  const visibleItems = block.items.filter(hasReasoningSteps);
  const steps = getThreadReasoningSteps(visibleItems);
  const canonicalOnlyStep = steps.length === 1 ? steps[0] : null;
  const presentedOnlyStepMarkdown = useTranscript.presentedText({
    canonicalText: canonicalOnlyStep?.markdown ?? "",
    field: canonicalOnlyStep?.source === "content" ? "reasoningContent" : "reasoningSummary",
    index: canonicalOnlyStep?.sectionIndex ?? null,
    itemId: canonicalOnlyStep?.itemId ?? "",
    source: canonicalOnlyStep ? presentationSource : null,
    threadId: transcript.threadId,
    turnId: turn.id,
  });
  if (!steps.length) {
    return null;
  }
  const onlyStep = canonicalOnlyStep ? {
    ...canonicalOnlyStep,
    ...projectThreadReasoningMarkdown(presentedOnlyStepMarkdown),
    markdown: presentedOnlyStepMarkdown,
  } : null;
  const summary = onlyStep ? (
    <span className="truncate">
      <span>Reasoned: </span>
      <span className="thread-item-disclosure-prominent-text-portion font-medium text-text">{onlyStep.title}</span>
    </span>
  ) : (
    <span className="truncate">
      <span>Reasoned over </span>
      <span className="thread-item-disclosure-prominent-text-portion text-text">{steps.length}</span>
      <span> steps</span>
    </span>
  );
  const icon = isMostRecent && presentationSource ? <LoaderIcon /> : <CheckIcon size={16} />;

  if (onlyStep && !onlyStep.body) {
    return <ThreadStepRow icon={icon} summary={summary} />;
  }

  return (
    <ThreadStepRow defaultOpen={isMostRecent} icon={icon} summary={summary}>
      {onlyStep ? (
        <MarkdownRender
          {...markdownProps}
          className="text-[0.8em] text-fg/muted"
          live={Boolean(presentationSource)}
          markdown={onlyStep.body ?? ""}
          streaming={Boolean(presentationSource) && (isMostRecent || presentedOnlyStepMarkdown !== canonicalOnlyStep?.markdown)}
        />
      ) : (
        <div className="space-y-4">
          {visibleItems.map((item, index) => (
            <ThreadReasoningItem
              {...markdownProps}
              key={item.id}
              className={index ? "border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] pt-4" : undefined}
              isMostRecent={isMostRecent && index === visibleItems.length - 1}
              item={item}
              presentationSource={presentationSource}
              threadId={transcript.threadId}
              turnId={turn.id}
            />
          ))}
        </div>
      )}
    </ThreadStepRow>
  );
}
