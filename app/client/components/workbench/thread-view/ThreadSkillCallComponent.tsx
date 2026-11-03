/*
 * Exports:
 * - default ThreadSkillCallComponent: one settled MCP call's skill component, given the call (and any props its matcher
 *   added), drawn from its kept snapshot once the call's result expired; the call's own details show instead when it
 *   cannot render.
 * - ThreadSkillComponentPreview/ThreadSkillComponentPreviewContext: a vis preview's own drawing of call and inline components.
 */
"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { SkillMcpCall } from "workbench-shared/workbench/skills/skill-mcp-matcher-contract";
import { readSkillMcpCallOutcome, readSkillMcpTextResult } from "../../../workbench/thread/command-matchers/skill-mcp";
import { getThreadCommandExecutionOutcome, type ThreadCommandSkillMcp } from "../../../workbench/thread/thread-command-matchers";
import ThreadComponentTree from "./ThreadComponentTree";
import { useThreadSkillComponent } from "./ThreadSkillExtensions";
import type { CommandSequenceItem } from "./thread-render-blocks";

type CallItem = Extract<CommandSequenceItem, { type: "commandExecution" | "mcpToolCall" }>;

/** The call as its component sees it: the matched invocation with the item's own outcome. */
function readCall(item: CallItem, skill: ThreadCommandSkillMcp): SkillMcpCall {
  if (item.type === "mcpToolCall") return { ...skill.call, ...readSkillMcpCallOutcome(item) };
  const outcome = getThreadCommandExecutionOutcome(item.status, item.exitCode);
  const output = item.aggregatedOutput ?? "";
  const status = outcome === "inProgress" ? "inProgress" : outcome === "completed" ? "completed" : "failed";
  return {
    ...skill.call, status,
    error: status === "failed" ? output.trim() || null : null,
    result: status === "completed" && output.trim() ? readSkillMcpTextResult(output) : null,
  };
}

type SkillCallComponentProps = { fallback: ReactNode; item: CallItem; skill: ThreadCommandSkillMcp & { component: string } };

/**
 * Draws a skill component in place of the daemon's kept render: a call's own (given the call) or one inline in its line.
 * Only vis previews provide one.
 */
export type ThreadSkillComponentPreview = (input: {
  component: string; props: Record<string, unknown>; fallback: ReactNode; inline?: boolean;
}) => ReactNode;
export const ThreadSkillComponentPreviewContext = createContext<ThreadSkillComponentPreview | null>(null);

export default function ThreadSkillCallComponent(props: SkillCallComponentProps) {
  const preview = useContext(ThreadSkillComponentPreviewContext);
  if (!preview) return <LiveSkillCallComponent {...props} />;
  const { fallback, item, skill } = props;
  return preview({ component: skill.component, fallback, props: { ...skill.props, call: readCall(item, skill) } });
}

function LiveSkillCallComponent({ fallback, item, skill }: SkillCallComponentProps) {
  const call = readCall(item, skill);
  const ready = call.status !== "inProgress";
  const expired = item.resultExpiredAt !== undefined;
  const key = ready ? JSON.stringify(["call", item.id, skill.skillPath, skill.component, call.status, expired, skill.props ?? null]) : null;
  const state = useThreadSkillComponent(key, ready ? {
    kind: "call", itemId: item.id, skillPath: skill.skillPath, component: skill.component,
    props: { ...skill.props, call }, keep: call.keep, expired,
  } : null);
  if (state.status === "failed") {
    return <>
      <p className="m-0 text-[0.78em] leading-[1.6] text-fg/muted" title={state.error}>{skill.component} could not render: {state.error.slice(0, 300)}</p>
      {fallback}
    </>;
  }
  if (state.status === "pending") return null;
  return <ThreadComponentTree fallback={fallback} key={key} tree={state.tree} />;
}
