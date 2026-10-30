/*
 * Exports:
 * - default ThreadSkillMcpCard: one MCP call (direct, wb `mcp_call` or `wb mcp call`) an active skill draws as its own card:
 *   the skill's line and chip icon, opening onto its component once settled, else the call's own details.
 */
"use client";

import { createElement, type ReactNode } from "react";

import type { WorkbenchThreadItemTimelineEntry } from "workbench-shared/workbench/thread/thread-item-timeline";
import {
  getThreadCommandExecutionOutcome, getThreadCommandOutcomeDisplay, getWorkbenchCommandRouteSummaryDisplay, getWorkbenchMcpCommandRoute,
  type ThreadCommandExecutionOutcome, type ThreadCommandSummaryDisplay,
} from "../../../workbench/thread/thread-command-matchers";
import { useProject } from "../use-projects";
import ThreadCard from "./ThreadCard";
import ThreadCodeDisplay, { ThreadCommandHeader } from "./ThreadCodeDisplay";
import { getMcpCallOutcome, ThreadMcpCallDetails } from "./ThreadMcpToolCallItem";
import ThreadSkillCallComponent from "./ThreadSkillCallComponent";
import { getCommandIcon } from "./thread-activity-chips";
import type { CommandSequenceItem } from "./thread-render-blocks";
import { ThreadCommandSummary } from "./thread-view-primitives";
import { ThreadRegularCommandItem } from "./transcript/ThreadCommandSequence";
import { getActiveItemStartedAtMs } from "./transcript/transcript-blocks";
import { useThreadItemLiveDuration } from "./use-thread-live-duration";

type CallItem = Extract<CommandSequenceItem, { type: "commandExecution" | "mcpToolCall" }>;

function useCallPresentation(item: CallItem): { details: ReactNode; display: ThreadCommandSummaryDisplay | null; outcome: ThreadCommandExecutionOutcome } {
  const project = useProject.contextual();
  if (item.type === "mcpToolCall") {
    const route = getWorkbenchMcpCommandRoute({
      argumentsValue: item.arguments, context: project?.mcpMatcherContext, item, server: item.server, tool: item.tool,
    });
    return { details: <ThreadMcpCallDetails item={item} />, display: getWorkbenchCommandRouteSummaryDisplay(route), outcome: getMcpCallOutcome(item) };
  }
  const input = { command: item.command, commandActions: item.commandActions, cwd: item.cwd, shell: item.shell };
  return {
    details: <ThreadCodeDisplay header={<ThreadCommandHeader command={item.command} surface="framed" />} output={item.aggregatedOutput?.trim() || undefined} preview variant="plain" />,
    display: project ? project.commandDisplay(input) : null,
    outcome: getThreadCommandExecutionOutcome(item.status, item.exitCode),
  };
}

export default function ThreadSkillMcpCard({ item, itemTimeline, open }: {
  item: CommandSequenceItem;
  itemTimeline: readonly WorkbenchThreadItemTimelineEntry[] | undefined;
  open: boolean;
}) {
  const activeStartedAtMs = getActiveItemStartedAtMs(item, itemTimeline);
  const durationMs = useThreadItemLiveDuration(item.durationMs, activeStartedAtMs);
  if (item.type === "dynamicToolCall") return <ThreadRegularCommandItem item={item} itemTimeline={itemTimeline} />;
  return <SkillCard durationMs={durationMs ?? null} item={item} itemTimeline={itemTimeline} open={open} />;
}

function SkillCard({ durationMs, item, itemTimeline, open }: {
  durationMs: number | null; item: CallItem; itemTimeline: readonly WorkbenchThreadItemTimelineEntry[] | undefined; open: boolean;
}) {
  const { details, display, outcome } = useCallPresentation(item);
  const skill = display?.skillMcp;
  // Matchers reloading between block building and this render: the call draws as the step it otherwise is.
  if (!display || !skill) return <ThreadRegularCommandItem item={item} itemTimeline={itemTimeline} />;
  const component = skill.component && outcome === "completed"
    ? <ThreadSkillCallComponent fallback={details} item={item} skill={{ ...skill, component: skill.component }} />
    : null;
  return (
    <ThreadCard
      defaultOpen={open}
      icon={createElement(getCommandIcon(display.summaryStats, skill.icon), { size: 16 })}
      iconClassName={outcome === "failed" ? "text-danger" : undefined}
      progress={{ durationMs, state: outcome }}
      renderContent={() => component ?? details}
      summary={<ThreadCommandSummary danger={outcome === "failed"} display={getThreadCommandOutcomeDisplay(display, outcome)} line />}
    />
  );
}
