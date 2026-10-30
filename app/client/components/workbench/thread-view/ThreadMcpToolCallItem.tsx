/*
 * Exports:
 * - default ThreadMcpToolCallItem: one MCP call as a step row (approval glyph, summary, trailing outcome and duration) opening onto results and errors; structured details (or a skill's component) replace the raw invocation unless the call failed; a running `mcp_call` offers the user a stop.
 * - ThreadMcpCallDetails: a call's resource, error, structured details and raw invocation, shared by rows and skill cards.
 * - getMcpCallOutcome: a call item's settled or running outcome.
 * - getSkillCallComponent: a completed call's skill component, when its matcher names one.
 */
"use client";

import type { ReactNode } from "react";

import { WORKBENCH_MCP_SERVER_NAME } from "workbench-shared/workbench/mcp/mcp-server-settings";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import {
  getThreadCommandOutcomeDisplay,
  getWorkbenchCommandRouteSummaryDisplay,
  type ThreadCommandExecutionOutcome,
  type ThreadCommandSummaryDisplay,
  type WorkbenchCommandRoute,
} from "../../../workbench/thread/thread-command-matchers";
import ThreadSkillCallComponent from "./ThreadSkillCallComponent";
import ThreadBubbleCopyButton from "./ThreadBubbleCopyButton";
import ThreadStepRow from "./ThreadStepRow";
import { ThreadCallStopAction } from "./transcript/ThreadItemActionControls";
import ThreadSummaryText from "./ThreadSummaryText";
import { getCommandIcon } from "./thread-activity-chips";
import { ThreadHydratedToolCallDetails } from "./ThreadToolCallDetails";
import { formatMcpToolInvocation, formatToolCallOutput } from "./format-thread-tool-call";
import { humanizeThreadLabel } from "./thread-view-formatters";
import { ThreadApprovalGlyph, ThreadCommandSummary } from "./thread-view-primitives";
import type { ThreadItemApprovalState } from "../../../workbench/thread/thread-item-approvals";

type McpToolCallItem = Extract<ThreadItem, { type: "mcpToolCall" }>;

const INLINE_CODE_CLASS = "rounded-[0.35rem] bg-[color-mix(in_srgb,var(--text)_7%,transparent)] px-[0.34em] py-[0.08em] font-mono text-[0.78em] leading-[1.6] text-text";

function ThreadMetaLine ({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <p className="m-0 flex flex-wrap items-baseline gap-2 text-[0.78em] leading-[1.6] text-fg/muted">
      <span>{label}</span>
      <span className="text-text">{value}</span>
    </p>
  );
}

export function getMcpCallOutcome(item: McpToolCallItem): ThreadCommandExecutionOutcome {
  return item.status === "inProgress" ? "inProgress" : item.status === "failed" || Boolean(item.error) ? "failed" : "completed";
}

/** A call's resource, error, then its invocation and output; `details` (structured steps, a skill component) replace the raw pair unless it failed. */
export function ThreadMcpCallDetails({ details, item }: { details?: ReactNode; item: McpToolCallItem }) {
  const outcome = getMcpCallOutcome(item);
  return (
    <>
      {item.mcpAppResourceUri ? (
        <ThreadMetaLine
          label="Resource:"
          value={<code className="break-all font-mono text-[0.92em]">{item.mcpAppResourceUri}</code>}
        />
      ) : null}
      {item.error?.message ? (
        <div className="rounded-[0.9rem] bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] px-4 py-3">
          <p className="m-0 text-[0.67em] uppercase tracking-[0.18em] text-[color:color-mix(in_srgb,var(--danger)_74%,var(--text)_26%)]">
            Error
          </p>
          <p className="mt-2 m-0 text-[0.92em] leading-[1.6] text-text">{item.error.message}</p>
        </div>
      ) : null}
      {details}
      {details && outcome !== "failed" ? null : (
        <ThreadHydratedToolCallDetails
          invocation={formatMcpToolInvocation({ argumentsValue: item.arguments, server: item.server, tool: item.tool })}
          item={item}
          output={body => body.resultExpiredAt
            ? "Result expired."
            : body.error?.message || formatToolCallOutput({ content: body.result?.content, fallback: body.result?.structuredContent ?? body.result?._meta })}
        />
      )}
    </>
  );
}

/** A settled call's skill component, falling back to its own details; null when no skill names one or it did not complete. */
export function getSkillCallComponent(item: McpToolCallItem, display: ThreadCommandSummaryDisplay | null): ReactNode {
  const skill = display?.skillMcp;
  if (!skill?.component || getMcpCallOutcome(item) !== "completed") return null;
  return <ThreadSkillCallComponent fallback={<ThreadMcpCallDetails item={item} />} item={item} skill={{ ...skill, component: skill.component }} />;
}

export default function ThreadMcpToolCallItem ({
  approval = null,
  details: givenDetails,
  item,
  durationMs = item.durationMs,
  route,
}: {
  approval?: ThreadItemApprovalState | null;
  details?: ReactNode;
  durationMs?: number | null;
  item: McpToolCallItem;
  route: WorkbenchCommandRoute | null;
}) {
  const commandDisplay = getWorkbenchCommandRouteSummaryDisplay(route);
  const outcome = getMcpCallOutcome(item);
  const outcomeDisplay = commandDisplay ? getThreadCommandOutcomeDisplay(commandDisplay, outcome) : null;
  const Icon = getCommandIcon(outcomeDisplay?.summaryStats, commandDisplay?.skillMcp?.chip);
  const details = givenDetails ?? getSkillCallComponent(item, commandDisplay);
  // A running Workbench `mcp_call` to an MCP server can run for minutes, so the user may stop it like a shell; deferred wb tools cannot.
  const callArguments = item.arguments !== null && typeof item.arguments === "object" && !Array.isArray(item.arguments) ? item.arguments : null;
  const stoppable = route !== null && outcome === "inProgress" && item.tool === "mcp_call"
    && callArguments?.server !== WORKBENCH_MCP_SERVER_NAME;

  const row = (
    <ThreadStepRow
      icon={<Icon size={16} />}
      meta={[
        // A live call already reads as ongoing in its summary; only settled non-success outcomes need naming.
        item.status !== "completed" && item.status !== "inProgress" ? <ThreadSummaryText key="status" text={humanizeThreadLabel(item.status)} /> : null,
      ]}
      progress={{ durationMs, state: outcome }}
      summary={outcomeDisplay ? (
        <ThreadCommandSummary approval={approval} display={outcomeDisplay} line />
      ) : (
        <span className="inline-flex min-w-0 max-w-full items-baseline gap-[0.45rem] overflow-hidden">
          {approval ? <ThreadApprovalGlyph state={approval} /> : null}
          <ThreadSummaryText text="MCP" />
          <code className={INLINE_CODE_CLASS}>{item.server}</code>
          <ThreadSummaryText text="/" />
          <code className={INLINE_CODE_CLASS}>{item.tool}</code>
        </span>
      )}
      renderContent={() => <ThreadMcpCallDetails details={details} item={item} />}
    />
  );
  if (!stoppable) return row;
  return (
    <div className="group/thread-bubble relative">
      {row}
      <ThreadBubbleCopyButton actions={<ThreadCallStopAction itemId={item.id} label="Stop call" />} markdown="" side="right" touchVisible />
    </div>
  );
}
