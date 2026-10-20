/*
 * Exports:
 * - default ThreadActivityRun: one run of consecutive work as a tinted summary (finished steps as counted chips, live duration,
 *   current step) that expands into its steps; a settled run holding one step, or a lone sleep, shows that step alone.
 */
"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { getThreadItemTimelineDurationMs, type WorkbenchThreadItemTimelineEntry } from "workbench-shared/workbench/thread/thread-item-timeline";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { shimmerTextClassName } from "../../../tailwind/shimmer-text-classes";
import { LoaderIcon } from "../workbench-icons";
import { isNativeFileOperation } from "../../../workbench/thread/thread-command-matchers";
import { parseSleepCommandMs } from "../../../workbench/thread/command-matchers/sleep-command";
import { matchThreadGenericItem } from "../../../workbench/thread/thread-generic-item-matchers";
import { getActivityChips, getCommandItemDisplay, type ActivityChip, type CommandChipContext } from "./thread-activity-chips";
import { describeBrowseStep, getBrowseItemSteps, getCurrentBrowseStep } from "./thread-browse-steps";
import type { ActivitySegment, ThreadRenderableBlock } from "./thread-render-blocks";
import { getThreadFileChangeEntries, ThreadFileChangeTotals } from "./ThreadFileChangeItem";
import ThreadDurationText from "./ThreadDurationText";
import ProjectFilePath from "../ProjectFilePath";
import { ThreadRowChromeContext } from "./thread-row-chrome";
import { ThreadEntryAnimation } from "./ThreadRevealText";
import { useThreadLiveDuration } from "./use-thread-live-duration";
import useThreadActivityRun from "./use-thread-activity-run";
import {
  getActivityRunPresentation, getActivitySegmentItems, getSettledActivitySegments, RUN_SEGMENT_KINDS,
} from "./thread-activity-runs";
import { useProject } from "../use-projects";
import { useTranscript } from "../use-transcript";

type ReasoningItem = Extract<ThreadItem, { type: "reasoning" }>;
const REASONING_SWAP_MS = 800;
const FILE_VERBS = { add: "Creating", delete: "Deleting", update: "Editing" } as const;

/** Each segment kind's existing renderer draws its steps; the run owns only summary, status and layout. */
export type ThreadActivityRunRenderers = {
  readonly [Kind in ActivitySegment["kind"]]: (segment: Extract<ActivitySegment, { kind: Kind }>, isLastSegment: boolean) => ReactNode;
};

function renderSegment(renderers: ThreadActivityRunRenderers, segment: ActivitySegment, isLast: boolean) {
  // The renderer table is keyed by kind, so each renderer receives its own segment type.
  return (renderers[segment.kind] as (segment: ActivitySegment, isLast: boolean) => ReactNode)(segment, isLast);
}

function firstSentence(text: string) {
  return text.trim().match(/^.*?[.!?](?=\s|$)/su)?.[0] ?? text.trim().split("\n")[0] ?? "";
}

function latestParagraph(item: ReasoningItem) {
  const sections = item.summary.length ? item.summary : item.content;
  return sections.at(-1)?.split(/\n\s*\n/u).filter(part => part.trim()).at(-1) ?? "";
}

/** The latest paragraph's first sentence, changing at most every 800ms; newer paragraphs wait their turn. */
function useThrottledSentence(sentence: string) {
  const [shown, setShown] = useState(sentence);
  const lastSwap = useRef(0);
  useEffect(() => {
    if (sentence === shown) return;
    const timer = window.setTimeout(() => {
      lastSwap.current = performance.now();
      setShown(sentence);
    }, Math.max(0, lastSwap.current + REASONING_SWAP_MS - performance.now()));
    return () => window.clearTimeout(timer);
  }, [sentence, shown]);
  return shown;
}

function ChipRow({ chips }: { chips: ActivityChip[] }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-3.5 overflow-hidden whitespace-nowrap">
      {chips.map(chip => (
        <span className="inline-flex items-center gap-1" key={chip.key}>
          <chip.Icon size={14} />
          <b className="inline-block animate-tick font-semibold text-text motion-reduce:animate-none" key={chip.count}>{chip.count}</b>
          {chip.verb}
          {chip.additions !== undefined || chip.deletions !== undefined ? (
            <span className="ml-0.5"><ThreadFileChangeTotals additions={chip.additions ?? 0} animateChanges deletions={chip.deletions ?? 0} /></span>
          ) : null}
        </span>
      ))}
    </span>
  );
}

function ReasoningStatus({ item }: { item: ReasoningItem }) {
  const sentence = useThrottledSentence(firstSentence(latestParagraph(item)));
  return <span className={shimmerTextClassName} key={sentence}>{sentence || "Thinking"}</span>;
}

function StatusContent({ context, item }: { context: CommandChipContext; item: ThreadItem }) {
  const project = useProject.contextual();
  if (item.type === "reasoning") return <ReasoningStatus item={item} />;
  if (item.type === "fileChange" || isNativeFileOperation(item)) {
    const file = getThreadFileChangeEntries([item]).at(-1);
    if (!file) return <span className={shimmerTextClassName}>Editing files</span>;
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className={shimmerTextClassName}>{FILE_VERBS[file.kind]}</span>
        {/* A static pill: the status sits inside the run's toggle button, which a file-open button cannot nest in. */}
        <ProjectFilePath className="min-w-0 shrink" path={project?.displayPath(file.path) ?? file.path} projectId={null} />
        <ThreadFileChangeTotals additions={file.additions} animateChanges deletions={file.deletions} />
      </span>
    );
  }
  if ((item.type === "commandExecution" && parseSleepCommandMs(item.command) !== null)
    || (item.type === "generic" && matchThreadGenericItem(item)?.kind === "sleep")) {
    return <span className={shimmerTextClassName}>Sleeping</span>;
  }
  if (item.type !== "commandExecution" && item.type !== "mcpToolCall" && item.type !== "dynamicToolCall") {
    return <span className={shimmerTextClassName}>Working</span>;
  }
  const display = getCommandItemDisplay(item, context);
  const browseStep = getCurrentBrowseStep(getBrowseItemSteps(item, display, context.browseResultEntries ?? []) ?? []);
  // Plain text, like the live status panel: shimmer cannot paint through rich summary chips.
  const text = browseStep ? `Browsing: ${describeBrowseStep(browseStep)}` : display?.ongoingSummaryText;
  return <span className={shimmerTextClassName}>{text || "Working"}</span>;
}

export default function ThreadActivityRun({
  animateEntries,
  block,
  isMostRecent,
  itemTimeline,
  renderers,
  turnLive,
}: {
  /** The turn plays entry motion: a status row that appears under the summary animates in like a new block. */
  animateEntries: boolean;
  block: Extract<ThreadRenderableBlock, { kind: "activityRun" }>;
  isMostRecent: boolean;
  itemTimeline?: readonly WorkbenchThreadItemTimelineEntry[];
  renderers: ThreadActivityRunRenderers;
  turnLive: boolean;
}) {
  const project = useProject.contextual();
  const browseResultEntries = useTranscript.turn().browseResultEntries;
  const context = useMemo<CommandChipContext>(
    () => ({ ...project?.matcherContext, browseResultEntries, cwd: project?.cwd }),
    [browseResultEntries, project],
  );
  const run = useThreadActivityRun(block.items[0]?.id ?? "");
  const lastItem = block.items.at(-1);
  // Reasoning has no lifecycle of its own; it is current while nothing has followed it in a live turn.
  const running = lastItem && "status" in lastItem && lastItem.status === "inProgress";
  const current = lastItem && (running || (lastItem.type === "reasoning" && turnLive && isMostRecent)) ? lastItem : null;
  // The summary counts what has happened; a step still running shows as the status line instead.
  const chips = getActivityChips(getSettledActivitySegments(block.segments), context);
  const settledDurationMs = getThreadItemTimelineDurationMs(block.items.map(item => item.id), itemTimeline);
  const startedAtMs = block.items.flatMap(item => {
    const entry = itemTimeline?.find(candidate => candidate.itemId === item.id);
    return entry ? [entry.startedAt ?? entry.firstSeenAt] : [];
  }).find((time): time is number => time !== null) ?? null;
  // While the turn works and nothing has followed this run, it stays live: between steps it is thinking,
  // so its status row never collapses and re-expands from one step to the next.
  const live = Boolean(current) || (turnLive && isMostRecent);
  const durationMs = useThreadLiveDuration(live ? 0 : settledDurationMs, live ? startedAtMs : null);
  const status = current
    ? <StatusContent context={context} item={current} />
    : live ? <span className={shimmerTextClassName}>Thinking</span> : null;
  const steps = block.segments.map((segment, index) => {
    const previous = block.segments[index - 1];
    const kind = RUN_SEGMENT_KINDS[segment.kind];
    // Adjacent action groups sit tight; prose-like steps get breathing room either side.
    const gap = !previous ? "" : !kind.prose && !RUN_SEGMENT_KINDS[previous.kind].prose ? "mt-0.5" : "mt-2";
    const content = renderSegment(renderers, segment, index === block.segments.length - 1);
    return (
      <div className={kind.tinted ? `rounded-lg bg-fg/4 px-3 ${gap}` : gap} key={getActivitySegmentItems(segment)[0]?.id ?? index}>
        {kind.tinted ? <ThreadRowChromeContext.Provider value="step">{content}</ThreadRowChromeContext.Provider> : content}
      </div>
    );
  });

  if (getActivityRunPresentation(block.segments, live) === "bare") return <div className="my-1.5">{steps}</div>;

  return (
    <div className="my-1.5" data-thread-activity-run="true">
      <button
        aria-expanded={run.open}
        className="block w-full rounded-lg bg-fg/4 px-3 text-left text-[0.86em] text-fg/muted"
        onClick={run.toggle}
        type="button"
      >
        <span className="flex min-w-0 items-center gap-2 py-2 leading-[1.6]">
          <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap">
            {chips.length ? <ChipRow chips={chips} /> : status
              ? <span className="flex min-w-0 items-center gap-2 font-medium"><LoaderIcon className="shrink-0" /><span className="min-w-0 truncate">{status}</span></span>
              // Nothing countable (only reasoning, or only failed steps): name what the run actually held.
              : <span>{block.segments.every(segment => segment.kind === "reasoning") ? "Reasoned" : "Worked"}</span>}
          </span>
          {durationMs ? <ThreadDurationText className="shrink-0" durationMs={durationMs} /> : null}
        </span>
        {chips.length && status ? (
          <ThreadEntryAnimation
            className="-mt-1 flex h-7 min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap pb-0.5 text-[1.05em] font-medium"
            inline
            play={animateEntries}
          >
            <LoaderIcon className="shrink-0" />
            <span className="min-w-0 truncate">{status}</span>
          </ThreadEntryAnimation>
        ) : null}
      </button>
      {run.open ? <div className="px-3 pt-1.5">{steps}</div> : null}
    </div>
  );
}
