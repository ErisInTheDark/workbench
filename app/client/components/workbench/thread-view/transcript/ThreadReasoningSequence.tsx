/*
 * Exports:
 * - default ThreadReasoningSequence: consecutive reasoning as one step row: a single step reads as its title and streams its body,
 *   several steps open onto each item's reasoning; while live, the row reads as its latest sentence. Rows open only when clicked.
 */
"use client";

import MarkdownRender from "../../../ui/MarkdownRender";
import { CheckIcon, LoaderIcon } from "../../workbench-icons";
import { useTranscript } from "../../use-transcript";
import ThreadInlineCode from "../ThreadInlineCode";
import ThreadReasoningItem from "../ThreadReasoningItem";
import ThreadStepRow from "../ThreadStepRow";
import { getThreadReasoningSteps, projectThreadReasoningMarkdown } from "../thread-reasoning-display";
import { hasReasoningSteps, type ThreadRenderableBlock } from "../thread-render-blocks";
import useReasoningSentence from "../use-reasoning-sentence";

/** Inline code in the sentence keeps its code look; the rest is plain text. */
function ReasoningSentence({ sentence }: { sentence: string }) {
  return sentence.split(/(`[^`]*`)/u).map((part, index) => part.length > 1 && part.startsWith("`") && part.endsWith("`")
    ? <ThreadInlineCode key={index}>{part.slice(1, -1)}</ThreadInlineCode>
    : part);
}

export default function ThreadReasoningSequence ({
  block,
  isMostRecent,
  mode = "step",
}: {
  block: Extract<ThreadRenderableBlock, { kind: "reasoningSequence" }>;
  isMostRecent: boolean;
  /** `status`: one closed line for an activity card's status slot. */
  mode?: "status" | "step";
}) {
  const transcript = useTranscript();
  const turn = useTranscript.turn();
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
  const live = isMostRecent && Boolean(presentationSource);
  const latestMarkdown = canonicalOnlyStep ? presentedOnlyStepMarkdown : steps.at(-1)?.markdown ?? "";
  const sentence = useReasoningSentence(latestMarkdown, live);
  if (!steps.length) {
    return null;
  }
  const onlyStep = canonicalOnlyStep ? {
    ...canonicalOnlyStep,
    ...projectThreadReasoningMarkdown(presentedOnlyStepMarkdown),
    markdown: presentedOnlyStepMarkdown,
  } : null;
  const summary = live ? (
    <span className="truncate">
      <span>Thinking{sentence ? ": " : ""}</span>
      {sentence ? <span className="thread-item-disclosure-prominent-text-portion font-medium text-text"><ReasoningSentence sentence={sentence} /></span> : null}
    </span>
  ) : onlyStep ? (
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
  const icon = live ? <LoaderIcon /> : <CheckIcon size={16} />;

  if (mode === "status" || (onlyStep && !onlyStep.body)) {
    return <ThreadStepRow icon={icon} live={live} summary={summary} />;
  }

  return (
    <ThreadStepRow icon={icon} live={live} summary={summary}>
      {onlyStep ? (
        <MarkdownRender
          className="text-[0.8em] text-fg/muted"
          live={Boolean(presentationSource)}
          markdown={onlyStep.body ?? ""}
          streaming={Boolean(presentationSource) && (isMostRecent || presentedOnlyStepMarkdown !== canonicalOnlyStep?.markdown)}
        />
      ) : (
        <div className="space-y-4">
          {visibleItems.map((item, index) => (
            <ThreadReasoningItem
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
