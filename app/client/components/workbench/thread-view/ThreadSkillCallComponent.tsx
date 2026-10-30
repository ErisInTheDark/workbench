/*
 * Exports:
 * - default ThreadSkillCallComponent: one settled MCP call's skill component, rendered once by the daemon and kept, given
 *   the call (and any props its matcher added); the call's own details show instead when it cannot render.
 * - ThreadSkillComponentPreview/ThreadSkillComponentPreviewContext: a vis preview's own drawing of call components.
 */
"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import type { SkillMcpCall } from "workbench-shared/workbench/skills/skill-mcp-matcher-contract";
import useWorkspaceObservation from "../../../workbench/app/use-workspace-observation";
import { readSkillMcpCallOutcome, readSkillMcpTextResult } from "../../../workbench/thread/command-matchers/skill-mcp";
import { getThreadCommandExecutionOutcome, type ThreadCommandSkillMcp } from "../../../workbench/thread/thread-command-matchers";
import WorkbenchWorkspaceContext, { useWorkbenchDaemonClient } from "../WorkbenchWorkspaceContext";
import { useTranscript } from "../use-transcript";
import ThreadComponentTree, { useThreadComponentRender } from "./ThreadComponentTree";
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

/** Draws a call's skill component in place of the daemon's kept render; only vis previews provide one. */
export type ThreadSkillComponentPreview = (input: {
  component: string; props: Record<string, unknown> & { call: SkillMcpCall }; fallback: ReactNode;
}) => ReactNode;
export const ThreadSkillComponentPreviewContext = createContext<ThreadSkillComponentPreview | null>(null);

export default function ThreadSkillCallComponent(props: SkillCallComponentProps) {
  const preview = useContext(ThreadSkillComponentPreviewContext);
  if (!preview) return <DaemonSkillCallComponent {...props} />;
  const { fallback, item, skill } = props;
  return preview({ component: skill.component, fallback, props: { ...skill.props, call: readCall(item, skill) } });
}

function DaemonSkillCallComponent({ fallback, item, skill }: SkillCallComponentProps) {
  const daemon = useWorkbenchDaemonClient();
  const workspace = useContext(WorkbenchWorkspaceContext);
  const { threadId } = useTranscript();
  const query = useMemo(() => ({ kind: "thread" as const, threadId: ThreadReferenceSchema.parse(threadId) }), [threadId]);
  const observed = useWorkspaceObservation(workspace, query);
  const call = readCall(item, skill);
  const key = JSON.stringify([threadId, item.id, skill.skillPath, skill.component]);
  const state = useThreadComponentRender({
    key,
    ready: call.status !== "inProgress",
    refreshKey: JSON.stringify(observed.value?.runtime[threadId]?.skills ?? []),
    request: () => daemon.threads.components.renderCall({
      threadId: ThreadReferenceSchema.parse(threadId), itemId: item.id, skillPath: skill.skillPath, component: skill.component,
      props: { ...skill.props, call },
    }),
  });
  if (state.error) {
    return <>
      <p className="m-0 text-[0.78em] leading-[1.6] text-fg/muted" title={state.error}>{skill.component} could not render: {state.error.slice(0, 300)}</p>
      {fallback}
    </>;
  }
  if (!state.result) return null;
  return <ThreadComponentTree fallback={fallback} key={key} tree={state.result.tree} />;
}
