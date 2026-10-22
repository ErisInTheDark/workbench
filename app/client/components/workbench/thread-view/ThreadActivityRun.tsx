/*
 * Exports:
 * - default ThreadActivityRun: one run of consecutive work as a tinted activity card (finished steps as counted chips, live
 *   duration, and while live its status: the step actually running or last done, drawn as its own row) that expands into
 *   its steps; a settled run holding one step, or a lone sleep or command, shows that step alone.
 * - ThreadActivitySteps: a run's steps laid out as the run lays them out, for other hosts of run segments.
 * - ThreadActivityRunRenderers: each step kind's renderer.
 */
"use client";

import { useContext, useMemo, type ReactNode } from "react";

import { getThreadItemTimelineDurationMs, type WorkbenchThreadItemTimelineEntry } from "workbench-shared/workbench/thread/thread-item-timeline";
import { shimmerTextClassName } from "../../../tailwind/shimmer-text-classes";
import { ThreadItemShellQueueContext } from "../../../workbench/thread/thread-item-shell-queue";
import { LoaderIcon } from "../workbench-icons";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { getActivityChips, getCommandItemDisplay, type ActivityChip, type CommandChipContext } from "./thread-activity-chips";
import { getLiftedBrowseSteps } from "./thread-browse-steps";
import type { ActivitySegment, ThreadRenderableBlock } from "./thread-render-blocks";
import { ThreadFileChangeTotals } from "./ThreadFileChangeItem";
import ThreadDurationText from "./ThreadDurationText";
import { ThreadRowChromeContext } from "./thread-row-chrome";
import { ThreadStepEntryAnimation } from "./ThreadRevealText";
import { useThreadLiveDuration } from "./use-thread-live-duration";
import useThreadActivityRun from "./use-thread-activity-run";
import {
  getActivityRunPresentation, getActivitySegmentItems, getActivityStatusStep, getSettledActivitySegments, RUN_SEGMENT_KINDS,
} from "./thread-activity-runs";
import { useProject } from "../use-projects";
import { useTranscript } from "../use-transcript";

/**
 * Each segment kind's existing renderer draws its steps; the run owns only summary, status and layout. `status` mode
 * draws the one step the card's status shows, where a multi-row call (Browse) shows only the row it is on.
 */
export type ThreadActivityRunRenderers = {
  readonly [Kind in ActivitySegment["kind"]]: (
    segment: Extract<ActivitySegment, { kind: Kind }>, isLastSegment: boolean, mode: "status" | "step",
  ) => ReactNode;
};

function renderSegment(renderers: ThreadActivityRunRenderers, segment: ActivitySegment, isLast: boolean, mode: "status" | "step") {
  // The renderer table is keyed by kind, so each renderer receives its own segment type.
  return (renderers[segment.kind] as (segment: ActivitySegment, isLast: boolean, mode: "status" | "step") => ReactNode)(segment, isLast, mode);
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

/**
 * Run steps in order: action groups tinted as steps, prose-like steps (reasoning, sleeps) bare with room around them.
 * `inset` lines untinted action groups (files, searches) up with the tinted groups' padding, inside a card.
 */
export function ThreadActivitySteps({ inset = false, renderers, segments }: {
  inset?: boolean;
  renderers: ThreadActivityRunRenderers;
  segments: readonly ActivitySegment[];
}) {
  return segments.map((segment, index) => {
    const previous = segments[index - 1];
    const kind = RUN_SEGMENT_KINDS[segment.kind];
    const gap = !previous ? "" : !kind.prose && !RUN_SEGMENT_KINDS[previous.kind].prose ? "mt-0.5" : "mt-2";
    const content = renderSegment(renderers, segment, index === segments.length - 1, "step");
    const className = kind.tinted ? `step-rows-packed rounded-lg bg-fg/4 px-3 py-1.5 ${gap}` : inset && !kind.prose ? `px-3 ${gap}` : gap;
    return (
      <div className={className} key={getActivitySegmentItems(segment)[0]?.id ?? index}>
        {kind.tinted ? <ThreadRowChromeContext.Provider value="step">{content}</ThreadRowChromeContext.Provider> : content}
      </div>
    );
  });
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
  const shellQueue = useContext(ThreadItemShellQueueContext);
  const running = block.items.some(item => "status" in item && item.status === "inProgress");
  // The summary counts what has happened; the status shows the step being worked on.
  const chips = getActivityChips(getSettledActivitySegments(block.segments), context);
  const settledDurationMs = getThreadItemTimelineDurationMs(block.items.map(item => item.id), itemTimeline);
  const startedAtMs = block.items.flatMap(item => {
    const entry = itemTimeline?.find(candidate => candidate.itemId === item.id);
    return entry ? [entry.startedAt ?? entry.firstSeenAt] : [];
  }).find((time): time is number => time !== null) ?? null;
  // While the turn works and nothing has followed this run, it stays live, so its status never collapses and
  // re-expands from one step to the next.
  const live = running || (turnLive && isMostRecent);
  const durationMs = useThreadLiveDuration(live ? 0 : settledDurationMs, live ? startedAtMs : null);
  const statusStep = live ? getActivityStatusStep(block.segments, itemId => shellQueue.get(itemId)?.admittedAt === null) : null;
  const statusItemId = statusStep ? getActivitySegmentItems(statusStep)[0]?.id : null;
  const commandRows = (item: ThreadItem) => (item.type === "commandExecution" || item.type === "mcpToolCall" || item.type === "dynamicToolCall")
    ? getLiftedBrowseSteps(item, getCommandItemDisplay(item, context), browseResultEntries)?.length ?? 1 : 1;
  if (getActivityRunPresentation(block.segments, live, commandRows) === "bare") {
    return <div className="my-1.5"><ThreadActivitySteps renderers={renderers} segments={block.segments} /></div>;
  }
  const steps = <ThreadActivitySteps inset renderers={renderers} segments={block.segments} />;

  return (
    <div className="my-1.5" data-thread-activity-run="true">
      <div className="rounded-lg bg-fg/4 px-3">
        <button
          aria-expanded={run.open}
          className="flex w-full min-w-0 items-center gap-2 py-2 text-left text-[0.86em] leading-[1.6] text-fg/muted"
          onClick={run.toggle}
          type="button"
        >
          <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap">
            {chips.length ? <ChipRow chips={chips} /> : live
              ? <span className="flex min-w-0 items-center gap-2 font-medium"><LoaderIcon className="shrink-0" /><span className={shimmerTextClassName}>Working</span></span>
              // Nothing countable (only reasoning, or only failed steps): name what the run actually held.
              : <span>{block.segments.every(segment => segment.kind === "reasoning") ? "Reasoned" : "Worked"}</span>}
          </span>
          {durationMs ? <ThreadDurationText className="shrink-0" durationMs={durationMs} /> : null}
        </button>
        {statusStep ? (
          // The step itself, drawn as the opened card draws it, in a fixed one-row slot so steps of different heights
          // never shift the card. It is a preview: inert, and tapping it toggles the card like the line above.
          <div className="-mt-1 mb-1 flex h-8 cursor-pointer items-center overflow-hidden" data-thread-expander="true" onClick={run.toggle}>
            <ThreadStepEntryAnimation className="step-rows-packed pointer-events-none min-w-0 flex-1" key={statusItemId} play={animateEntries}>
              <ThreadRowChromeContext.Provider value="step">{renderSegment(renderers, statusStep, true, "status")}</ThreadRowChromeContext.Provider>
            </ThreadStepEntryAnimation>
          </div>
        ) : null}
      </div>
      {run.open ? <div className="px-5 pt-1.5">{steps}</div> : null}
    </div>
  );
}
