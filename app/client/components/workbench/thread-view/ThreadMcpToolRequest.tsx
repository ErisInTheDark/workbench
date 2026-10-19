/*
 * Exports:
 * - McpToolCard: recessed card naming one MCP server tool, with its markdown description clamped to three lines until expanded.
 * - ThreadMcpToolRequestPanel: the composer's pending "Enable MCP tool" request; Approve and Deny (Shift: Stop) render into the composer's action slot.
 * - ThreadMcpToolDecisionCard: the transcript's record of an answered request.
 */
"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { WorkbenchUserInputMcpToolContext } from "workbench-shared/types";
import { mcpToolLabel } from "../../../workbench/mcp-tool-label";
import MarkdownRender from "../../ui/MarkdownRender";
import PrimaryButton from "../../ui/PrimaryButton";
import { CheckIcon, ChevronDownIcon, SquareIcon, XIcon } from "../workbench-icons";
import { useNonTextInputShiftKey } from "../use-non-text-input-shift-key";

export function McpToolCard({ tool, rounded = true }: { tool: WorkbenchUserInputMcpToolContext; rounded?: boolean }) {
  const description = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const element = description.current;
    if (!element || open) return;
    const measure = () => setClamped(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open, tool.description]);
  return <div className={`bg-recess px-3.5 py-3 ${rounded ? "rounded-[0.9rem]" : ""}`}>
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
      <span className="text-base font-semibold text-text">{mcpToolLabel({ name: tool.tool, title: tool.title })}</span>
      <code className="break-all text-[0.8rem] text-fg/muted">{tool.server}/{tool.tool}</code>
    </div>
    {tool.description ? <>
      <div ref={description} className={`mt-1 text-sm text-fg/muted [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 ${open ? "" : "line-clamp-3"}`}>
        <MarkdownRender markdown={tool.description} />
      </div>
      {clamped || open ? <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}
        className="mt-1 inline-flex items-center gap-1 text-[0.8rem] text-fg/muted hover:text-text">
        {open ? "Show less" : "Show more"}<ChevronDownIcon className={`size-3.5 transition ${open ? "rotate-180" : ""}`} />
      </button> : null}
    </> : null}
  </div>;
}

export function ThreadMcpToolRequestPanel({ tool, reason, actionTarget, onDecide, stop }: {
  tool: WorkbenchUserInputMcpToolContext;
  reason: string;
  /** The composer's action slot, where Send normally sits. */
  actionTarget: HTMLElement | null;
  onDecide: (approved: boolean) => Promise<void>;
  /** The composer's stop action, offered in place of Deny while Shift is held; null when the turn cannot be stopped. */
  stop: { run: () => void; pending: boolean; disabled: boolean; label: string } | null;
}) {
  const [deciding, setDeciding] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState("");
  const shift = useNonTextInputShiftKey({ allowWhileTextInputFocused: true });
  const decide = async (approved: boolean) => {
    if (deciding) return;
    setDeciding(approved ? "approve" : "deny");
    setError("");
    try { await onDecide(approved); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The answer could not be sent."); }
    finally { setDeciding(null); }
  };
  const actions: ReactNode = <>
    <PrimaryButton type="button" shape="circle" aria-label="Approve" title="Approve" disabled={Boolean(deciding)}
      pendingHalo={deciding === "approve"} onClick={() => { void decide(true); }}>
      <CheckIcon size={20} />
    </PrimaryButton>
    {shift && stop
      ? <PrimaryButton type="button" shape="circle" aria-label={stop.label} title={stop.label} disabled={stop.disabled}
        pendingHalo={stop.pending} onClick={stop.run}><SquareIcon size={18} /></PrimaryButton>
      : <PrimaryButton type="button" shape="circle" aria-label="Deny" title={stop ? "Deny (hold Shift to stop)" : "Deny"}
        disabled={Boolean(deciding)} pendingHalo={deciding === "deny"} onClick={() => { void decide(false); }}>
        <XIcon size={20} />
      </PrimaryButton>}
  </>;
  return <div className="flex flex-col gap-3 px-1 py-1">
    <h3 className="m-0 text-[1.02em] font-semibold leading-[1.35] text-text">Enable MCP tool</h3>
    <McpToolCard tool={tool} />
    {reason ? <p className="m-0 whitespace-pre-wrap break-words text-[0.95rem] leading-[1.6] text-text">{reason}</p> : null}
    {error ? <p role="alert" className="m-0 text-[0.84em] text-danger">{error}</p> : null}
    {actionTarget ? createPortal(actions, actionTarget) : <div className="flex items-center justify-end gap-2">{actions}</div>}
  </div>;
}

export function ThreadMcpToolDecisionCard({ tool, reason, approved }: {
  tool: WorkbenchUserInputMcpToolContext;
  reason: string;
  approved: boolean;
}) {
  return <div className="overflow-hidden rounded-[0.95rem] border border-fg-alpha/10">
    <div className="flex items-center gap-3 px-3.5 py-2 text-sm">
      <span className={`inline-flex shrink-0 items-center gap-1 font-medium ${approved ? "text-success" : "text-danger"}`}>
        {approved ? <CheckIcon size={14} /> : <XIcon size={14} />}{approved ? "Enabled MCP tool" : "Denied MCP tool"}
      </span>
      {reason ? <span className="min-w-0 flex-1 truncate text-fg/muted" title={reason}>{reason}</span> : null}
    </div>
    <McpToolCard tool={tool} rounded={false} />
  </div>;
}
