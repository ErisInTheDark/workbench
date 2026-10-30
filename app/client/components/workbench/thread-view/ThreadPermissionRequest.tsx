/*
 * Exports:
 * - McpToolCard: recessed card naming one MCP server tool, with its markdown description clamped to three lines until expanded.
 * - ThreadPermissionRequestSubject: what a pending permission request asks about: an MCP enable (tool), sign-in (server link) or
 *   connect (server URL), or a network target on another daemon or folder.
 * - ThreadPermissionRequestPanel: the composer's pending permission request; Approve and Deny (Shift: Stop) render into the composer's
 *   action slot. Network requests show the target as the app draws it and what each side gets instead of the agent's reason;
 *   approval stays disabled when this app cannot reach the target's daemon.
 * - ThreadPermissionDecisionCard: the transcript's record of an answered permission request.
 * - ThreadMcpDownloadCard: the transcript's record of an `mcp_download`: status and server, then the file name and source URL.
 */
"use client";

import { useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type {
  WorkbenchUserInputMcpAuthorizationContext, WorkbenchUserInputMcpConnectionContext, WorkbenchUserInputMcpToolContext,
} from "workbench-shared/types";
import type { NetworkTarget } from "workbench-shared/workbench/network/network-access";
import { mcpToolLabel } from "../../../workbench/mcp-tool-label";
import { openCenteredMcpSignInPopup } from "../../../workbench/mcp-sign-in-popup";
import MarkdownRender from "../../ui/MarkdownRender";
import PrimaryButton from "../../ui/PrimaryButton";
import {
  BookBookmarkIcon, BotIcon, CheckIcon, ChevronDownIcon, DownloadIcon, KeyRoundIcon, LockIcon, MegaphoneIcon, NetworkIcon,
  SendHorizontalIcon, ShieldAlertIcon, SquareIcon, XIcon, type IconProps,
} from "../workbench-icons";
import { useNonTextInputShiftKey } from "../use-non-text-input-shift-key";
import NetworkTargetDisplay from "./NetworkTargetDisplay";

export type ThreadPermissionRequestSubject =
  | { kind: "tool"; tool: WorkbenchUserInputMcpToolContext }
  | { kind: "authorization"; authorization: WorkbenchUserInputMcpAuthorizationContext }
  | { kind: "connection"; connection: WorkbenchUserInputMcpConnectionContext }
  /** `reachable` is false when this app cannot reach the target's daemon, so it cannot write the grant there. */
  | { kind: "network"; target: NetworkTarget; reachable: boolean };

const PANEL_TITLES = {
  tool: "Enable MCP tool", authorization: "Sign in to MCP server", connection: "Connect MCP server", network: "Allow agent network access",
} as const;
const DECISION_LABELS = {
  tool: { approved: "Enabled MCP tool", denied: "Denied MCP tool" },
  authorization: { approved: "Signed in to MCP server", denied: "Skipped MCP server sign-in" },
  connection: { approved: "Connected MCP server", denied: "Denied MCP server" },
  network: { approved: "Allowed network access", denied: "Denied network access" },
} as const;
const UNREACHABLE_NETWORK_TARGET = "You don't have access to the daemon this agent wants to network with. Either gain access or approve this prompt from another device.";

type Capability = { Icon: ComponentType<IconProps>; label: string };
/** What approving lets the asking agent do, and what the target may do back. */
const NETWORK_GRANTS: Record<NetworkTarget["kind"], { agent: Capability[]; target: Capability[] }> = {
  thread: {
    agent: [{ Icon: SendHorizontalIcon, label: "message" }, { Icon: BookBookmarkIcon, label: "recall" }],
    target: [{ Icon: SendHorizontalIcon, label: "message reply" }],
  },
  folder: { agent: [{ Icon: BotIcon, label: "subagent profiles" }, { Icon: BotIcon, label: "create subagents" }], target: [] },
  feedback: { agent: [{ Icon: MegaphoneIcon, label: "feedback" }], target: [] },
};
const NETWORK_HEADINGS: Record<NetworkTarget["kind"], (hostname: string) => string> = {
  thread: hostname => `Allow networking with a thread on ${hostname}?`,
  folder: hostname => `Allow creating subagents in a folder on ${hostname}?`,
  feedback: hostname => `Allow reading feedback on ${hostname}?`,
};

function NetworkGrants({ kind }: { kind: NetworkTarget["kind"] }) {
  const line = (who: string, capabilities: Capability[]) => <div className="flex min-w-0 flex-wrap items-center gap-1.5">
    <span className="text-[0.8rem] text-fg/muted">{who}</span>
    {capabilities.map(({ Icon, label }) => <span className="inline-flex items-center gap-1 rounded-full bg-fg/6 px-2 py-0.5 text-[0.78rem] text-text" key={label}>
      <Icon className="text-fg/72" size={12} />{label}
    </span>)}
  </div>;
  return <div className="flex flex-col gap-1.5 px-1">
    {line("This agent gets:", NETWORK_GRANTS[kind].agent)}
    {NETWORK_GRANTS[kind].target.length ? line("Target agent gets:", NETWORK_GRANTS[kind].target) : null}
  </div>;
}

/** The remote thread, folder or feedback an agent asks to reach, drawn as the app draws it elsewhere. */
function NetworkTargetCard({ target, rounded = true, compact = false }: { target: NetworkTarget; rounded?: boolean; compact?: boolean }) {
  return <div className={`bg-recess p-1 ${rounded ? "rounded-[0.9rem]" : ""}`}><NetworkTargetDisplay compact={compact} target={target} /></div>;
}

/** The server an agent asks to connect for its turn, by name and the URL it serves at. */
function McpConnectionCard({ connection, rounded = true }: { connection: WorkbenchUserInputMcpConnectionContext; rounded?: boolean }) {
  return <div className={`flex min-w-0 flex-wrap items-baseline gap-x-2 bg-recess px-3.5 py-3 ${rounded ? "rounded-[0.9rem]" : ""}`}>
    <span className="text-base font-semibold text-text">{connection.server}</span>
    <code className="break-all text-[0.8rem] text-fg/muted">{connection.url}</code>
  </div>;
}

function SubjectCard({ subject, rounded, onOpen }: { subject: ThreadPermissionRequestSubject; rounded?: boolean; onOpen?: (() => void) | undefined }) {
  if (subject.kind === "tool") return <McpToolCard tool={subject.tool} rounded={rounded} />;
  if (subject.kind === "connection") return <McpConnectionCard connection={subject.connection} rounded={rounded} />;
  if (subject.kind === "network") return <NetworkTargetCard compact={rounded === false} target={subject.target} rounded={rounded} />;
  return <McpAuthorizationCard authorization={subject.authorization} rounded={rounded} onOpen={onOpen} />;
}

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

/** The server and where its link points; pending requests also offer to open the link. */
function McpAuthorizationCard({ authorization, rounded = true, onOpen }: {
  authorization: WorkbenchUserInputMcpAuthorizationContext;
  rounded?: boolean;
  onOpen?: () => void;
}) {
  return <div className={`flex flex-wrap items-center gap-x-3 gap-y-2 bg-recess px-3.5 py-3 ${rounded ? "rounded-[0.9rem]" : ""}`}>
    <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
      <span className="text-base font-semibold text-text">{authorization.server}</span>
      <code className="break-all text-[0.8rem] text-fg/muted">{authorization.host}</code>
    </div>
    {onOpen ? <PrimaryButton type="button" shape="compact" onClick={onOpen}>
      <span className="inline-flex items-center gap-1.5"><KeyRoundIcon size={14} />Open sign-in</span>
    </PrimaryButton> : null}
  </div>;
}

export function ThreadPermissionRequestPanel({ subject, reason, actionTarget, onDecide, stop }: {
  subject: ThreadPermissionRequestSubject;
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
  const openLink = (url: string) => {
    const popup = openCenteredMcpSignInPopup();
    if (!popup) {
      setError("The browser blocked the sign-in window. Allow popups for Workbench and try again.");
      return;
    }
    setError("");
    popup.navigate(url);
  };
  const unreachable = subject.kind === "network" && !subject.reachable;
  const actions: ReactNode = <>
    <PrimaryButton type="button" shape="circle" aria-label="Approve" title={unreachable ? UNREACHABLE_NETWORK_TARGET : "Approve"}
      disabled={Boolean(deciding) || unreachable} pendingHalo={deciding === "approve"} onClick={() => { void decide(true); }}>
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
  const url = subject.kind === "authorization" ? subject.authorization.url : undefined;
  const network = subject.kind === "network" ? subject.target : null;
  return <div className="flex flex-col gap-3 px-1 py-1">
    <h3 className="m-0 flex items-center gap-2 text-[1.02em] font-semibold leading-[1.35] text-text">
      {network ? <NetworkIcon className="shrink-0 text-fg/72" size={18} /> : null}
      {network ? NETWORK_HEADINGS[network.kind](network.hostname) : PANEL_TITLES[subject.kind]}
    </h3>
    <SubjectCard subject={subject} onOpen={url ? () => openLink(url) : undefined} />
    {network ? <NetworkGrants kind={network.kind} /> : reason
      ? <p className="m-0 whitespace-pre-wrap break-words text-[0.95rem] leading-[1.6] text-text">{reason}</p> : null}
    {network?.kind === "thread" && network.daemonProject ? <p className="m-0 flex items-start gap-1.5 px-1 text-sm text-danger">
      <ShieldAlertIcon className="mt-0.5 shrink-0" size={14} />This thread can run commands outside the sandbox on {network.hostname}.
    </p> : null}
    {unreachable ? <p className="m-0 flex items-start gap-1.5 px-1 text-sm text-amber-700 dark:text-amber-300">
      <LockIcon className="mt-0.5 shrink-0" size={14} />{UNREACHABLE_NETWORK_TARGET}
    </p> : null}
    {error ? <p role="alert" className="m-0 text-[0.84em] text-danger">{error}</p> : null}
    {actionTarget ? createPortal(actions, actionTarget) : <div className="flex items-center justify-end gap-2">{actions}</div>}
  </div>;
}

/** The saved file name from `mcp_download`'s "Saved <name> (<type>, <n> bytes) to <path>" output. */
function savedFileName(output: string) {
  return /^Saved (.+) \([^()]*, \d+ bytes\) to /mu.exec(output)?.[1] ?? null;
}

export function ThreadMcpDownloadCard({ server, url, name, outcome, output }: {
  server: string;
  url: string;
  name: string | null;
  outcome: "inProgress" | "completed" | "failed";
  output: string;
}) {
  const file = (outcome === "completed" ? savedFileName(output) : null) ?? name;
  const status = outcome === "inProgress" ? "Downloading a file" : outcome === "completed" ? "Downloaded a file" : "Download failed";
  return <div className="overflow-hidden rounded-[0.95rem] border border-fg-alpha/10">
    <div className="flex items-center gap-1.5 px-3.5 py-2 text-sm">
      <span className={`inline-flex shrink-0 items-center gap-1.5 font-medium ${outcome === "failed" ? "text-danger" : "text-text"}`}>
        <DownloadIcon size={14} />{status}
      </span>
      <span className="text-fg/muted">from</span>
      <code className="min-w-0 truncate text-[0.85em] text-fg/muted">{server}</code>
    </div>
    <div className="flex flex-col gap-1 bg-recess px-3.5 py-3">
      {file ? <span className="break-all text-base font-semibold text-text">{file}</span> : null}
      <code className="break-all text-[0.8rem] text-fg/muted">{url}</code>
      {outcome === "failed" && output.trim() ? <p role="alert" className="m-0 mt-1 text-sm text-danger">{output.trim()}</p> : null}
    </div>
  </div>;
}

export function ThreadPermissionDecisionCard({ subject, reason, approved }: {
  subject: ThreadPermissionRequestSubject;
  reason: string;
  approved: boolean;
}) {
  const labels = DECISION_LABELS[subject.kind];
  return <div className="overflow-hidden rounded-[0.95rem] border border-fg-alpha/10">
    <div className="flex items-center gap-3 px-3.5 py-2 text-sm">
      <span className={`inline-flex shrink-0 items-center gap-1 font-medium ${approved ? "text-success" : "text-danger"}`}>
        {approved ? <CheckIcon size={14} /> : <XIcon size={14} />}{approved ? labels.approved : labels.denied}
      </span>
      {reason && subject.kind !== "network" ? <span className="min-w-0 flex-1 truncate text-fg/muted" title={reason}>{reason}</span> : null}
    </div>
    <SubjectCard subject={subject} rounded={false} />
  </div>;
}
