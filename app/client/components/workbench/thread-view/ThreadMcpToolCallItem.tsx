/*
 * Exports:
 * - default ThreadMcpToolCallItem: render user-controlled MCP details with summary metadata, results, and errors.
 */
"use client";

import type { ReactNode } from "react";

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import {
  getThreadCommandOutcomeDisplay,
  getWorkbenchCommandRouteSummaryDisplay,
  type ThreadCommandExecutionOutcome,
  type WorkbenchCommandRoute,
} from "../../../workbench/thread/thread-command-matchers";
import ThreadDurationText from "./ThreadDurationText";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadSummaryText from "./ThreadSummaryText";
import ThreadToolCallDetails from "./ThreadToolCallDetails";
import { formatMcpToolInvocation, formatToolCallOutput } from "./format-thread-tool-call";
import { humanizeThreadLabel } from "./thread-view-formatters";
import { ThreadCommandSummary } from "./thread-view-primitives";

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

export default function ThreadMcpToolCallItem ({
  details,
  item,
  projectFilePaths,
  projectId,
  route,
}: {
  details?: ReactNode;
  item: McpToolCallItem;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  route: WorkbenchCommandRoute | null;
}) {
  const metaParts = [];
  const commandDisplay = getWorkbenchCommandRouteSummaryDisplay(route);
  const outcome: ThreadCommandExecutionOutcome = item.status === "inProgress"
    ? "inProgress"
    : item.status === "failed" || Boolean(item.error) ? "failed" : "completed";
  const outcomeDisplay = commandDisplay ? getThreadCommandOutcomeDisplay(commandDisplay, outcome) : null;
  const invocation = formatMcpToolInvocation({
    argumentsValue: item.arguments,
    server: item.server,
    tool: item.tool,
  });
  const output = item.error?.message
    || formatToolCallOutput({
      content: item.result?.content,
      fallback: item.result?.structuredContent ?? item.result?._meta,
    });

  if (item.status !== "completed") {
    metaParts.push(
      <ThreadSummaryText
        key={`${item.id}:status`}
        text={humanizeThreadLabel(item.status)}
      />,
    );
  }

  if (item.durationMs !== null) {
    metaParts.push(
      <ThreadDurationText
        key={`${item.id}:duration`}
        durationMs={item.durationMs}
      />,
    );
  }

  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 space-y-3 pl-6"
      defaultOpen={false}
      summary={(
        <>
          {outcomeDisplay ? (
            <ThreadCommandSummary display={outcomeDisplay} projectFilePaths={projectFilePaths} projectId={projectId} />
          ) : (
            <span className="inline-flex min-w-0 max-w-full flex-wrap items-baseline gap-[0.45rem]">
              <ThreadSummaryText text="MCP" />
              <code className={INLINE_CODE_CLASS}>{item.server}</code>
              <ThreadSummaryText text="/" />
              <code className={INLINE_CODE_CLASS}>{item.tool}</code>
            </span>
          )}
          {metaParts.length ? (
            <span className="ml-2 text-[0.78em] text-fg/muted">
              {metaParts.map((part, index) => (
                <span key={`${item.id}:meta:${index}`}>
                  {index ? <span className="text-fg/muted"> | </span> : null}
                  {part}
                </span>
              ))}
            </span>
          ) : null}
        </>
      )}
      summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
    >
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
        <ThreadToolCallDetails invocation={invocation} output={output} />
      </>
    </ThreadDisclosure>
  );
}
