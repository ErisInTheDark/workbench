/*
 * Exports:
 * - default ThreadMcpToolCallItem: render MCP tool calls with summary metadata plus arguments, results, and errors. Keywords: workbench, thread, MCP, tool call.
 * - Local helpers: format MCP labels and JSON sections for thread rendering. Keywords: MCP, JSON, error, result.
 */
"use client";

import type { ReactNode } from "react";

import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";
import ThreadDurationText from "./ThreadDurationText";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadSummaryText from "./ThreadSummaryText";
import { humanizeThreadLabel } from "./thread-view-primitives";

type McpToolCallItem = Extract<ThreadItem, { type: "mcpToolCall" }>;

const JSON_BLOCK_CLASS = "m-0 max-w-full overflow-x-auto whitespace-pre rounded-[0.9rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] px-4 py-3 font-mono text-[0.78em] leading-[1.6] text-text";
const INLINE_CODE_CLASS = "rounded-[0.35rem] bg-[color-mix(in_srgb,var(--text)_7%,transparent)] px-[0.34em] py-[0.08em] font-mono text-[0.78em] leading-[1.6] text-text";

function hasJsonValue (value: unknown) {
  return value !== null && value !== undefined;
}

function formatJsonValue (value: unknown) {
  return JSON.stringify(value, null, 2) ?? "null";
}

function ThreadJsonSection ({
  label,
  value,
}: {
  label: string;
  value: unknown;
}) {
  if (!hasJsonValue(value)) {
    return null;
  }

  return (
    <div className="space-y-2">
      <p className="m-0 text-[0.67em] uppercase tracking-[0.18em] text-muted">{label}</p>
      <pre className={JSON_BLOCK_CLASS}>{formatJsonValue(value)}</pre>
    </div>
  );
}

function ThreadMetaLine ({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <p className="m-0 flex flex-wrap items-baseline gap-2 text-[0.78em] leading-[1.6] text-muted">
      <span>{label}</span>
      <span className="text-text">{value}</span>
    </p>
  );
}

export default function ThreadMcpToolCallItem ({
  item,
}: {
  item: McpToolCallItem;
}) {
  const metaParts = [];

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
      open={item.status !== "completed" || Boolean(item.error)}
      summary={(
        <>
          <span className="inline-flex min-w-0 max-w-full flex-wrap items-baseline gap-[0.45rem]">
            <ThreadSummaryText text="MCP" />
            <code className={INLINE_CODE_CLASS}>{item.server}</code>
            <ThreadSummaryText text="/" />
            <code className={INLINE_CODE_CLASS}>{item.tool}</code>
          </span>
          {metaParts.length ? (
            <span className="ml-2 text-[0.78em] text-muted">
              {metaParts.map((part, index) => (
                <span key={`${item.id}:meta:${index}`}>
                  {index ? <span className="text-muted"> | </span> : null}
                  {part}
                </span>
              ))}
            </span>
          ) : null}
        </>
      )}
      summaryClassName="text-[0.92em] leading-[1.6] text-text"
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
        <ThreadJsonSection label="Arguments" value={item.arguments} />
        <ThreadJsonSection label="Result content" value={item.result?.content ?? null} />
        <ThreadJsonSection label="Structured result" value={item.result?.structuredContent ?? null} />
        <ThreadJsonSection label="Result meta" value={item.result?._meta ?? null} />
      </>
    </ThreadDisclosure>
  );
}
