/*
 * Exports:
 * - default ThreadMessageBoardTopic: one subagent topic as a status-bordered thread-row disclosure whose bottom-anchored body lists its message history with sender/destination headers.
 * - ThreadMessageBoardMarkdownProps: markdown context shared by board message bubbles.
 */
"use client";

import { useMemo, useState, type ComponentProps } from "react";

import type { WorkbenchSubagentSummary } from "workbench-shared/types";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import { deriveThreadMessageBoardHistory, type ThreadMessageBoardMessage } from "../../../workbench/thread/thread-message-board";
import { getSubagentSummary, resolveWorkbenchSubagentCommandTargets } from "../../../workbench/thread/thread-subagents";
import { describeThreadEntry } from "../thread-entry-presentation";
import { useWorkbenchThreadSidebarEntry } from "../use-workbench-client";
import { useWorkbenchThread } from "../use-workbench-thread";
import WorkbenchThreadButton from "../WorkbenchThreadButton";
import WorkbenchThreadListItem from "../WorkbenchThreadListItem";
import { ArrowRightIcon } from "../workbench-icons";
import ThreadAgentMessageBody from "./ThreadAgentMessageBody";
import ThreadAgentName from "./ThreadAgentName";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadMarkdown from "./ThreadMarkdown";
import ThreadMessageTimestamp from "./ThreadMessageTimestamp";
import ThreadSteerDecoration from "./ThreadSteerDecoration";

export type ThreadMessageBoardMarkdownProps = Omit<ComponentProps<typeof ThreadMarkdown>, "markdown">;

const neutralBorderClassName = "border-[color-mix(in_srgb,var(--text)_12%,transparent)]";

/** Destination of a post to anyone but the parent: a coloured subagent name, a thread link, or the raw target. */
function ThreadMessageBoardDestination({
  subagents,
  target,
}: {
  subagents: readonly WorkbenchSubagentSummary[];
  target: { kind: "name" | "thread"; value: string | null };
}) {
  if (!target.value) return <span>another thread</span>;
  const resolved = resolveWorkbenchSubagentCommandTargets(subagents, [{ kind: target.kind === "name" ? "name" : "id", value: target.value }])[0];
  const name = <ThreadAgentName subagent={resolved?.subagent} thread={{ agentNickname: resolved?.fallbackName ?? target.value, agentRole: null }} />;
  if (target.kind === "name") return name;
  return <WorkbenchThreadButton fallback={name} label={resolved?.subagent ? name : undefined} threadId={resolved?.threadId ?? target.value} />;
}

function ThreadMessageBoardBubbleHeader({
  message,
  subagent,
  subagents,
}: {
  message: ThreadMessageBoardMessage;
  subagent: WorkbenchSubagentSummary;
  subagents: readonly WorkbenchSubagentSummary[];
}) {
  if (message.direction === "incoming") {
    if (!message.sender) return null;
    return (
      <ThreadAgentName
        subagent={getSubagentSummary(subagents, message.sender.threadId)}
        thread={{ agentNickname: message.sender.name, agentRole: null }}
      />
    );
  }
  const { target } = message;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5">
      <ThreadAgentName subagent={subagent} thread={null} />
      {target.kind === "final" ? <span className="font-normal">final answer</span> : null}
      {target.kind === "name" || target.kind === "thread" ? (
        <>
          <ArrowRightIcon aria-label="to" size={14} />
          <ThreadMessageBoardDestination subagents={subagents} target={{ kind: target.kind, value: target.value }} />
        </>
      ) : null}
    </span>
  );
}

function ThreadMessageBoardBubble({
  markdownProps,
  message,
  subagent,
  subagents,
}: {
  markdownProps: ThreadMessageBoardMarkdownProps;
  message: ThreadMessageBoardMessage;
  subagent: WorkbenchSubagentSummary;
  subagents: readonly WorkbenchSubagentSummary[];
}) {
  const incoming = message.direction === "incoming";
  const label = <ThreadMessageBoardBubbleHeader message={message} subagent={subagent} subagents={subagents} />;
  return (
    <section className={`flex min-w-0 flex-col py-2 ${incoming ? "items-end" : "items-start"}`}>
      <div className="w-fit min-w-0 max-w-[min(100%,36rem)] text-left [overflow-wrap:anywhere]">
        <ThreadSteerDecoration className="space-y-1.5" state={null}>
          {incoming && !message.sender ? null : <p className="m-0 text-[0.78em] font-medium leading-[1.5] text-fg/muted">{label}</p>}
          <ThreadAgentMessageBody {...markdownProps} parts={[message]} />
        </ThreadSteerDecoration>
      </div>
      <ThreadMessageTimestamp align={incoming ? "right" : "left"} className="mt-1" timestampSeconds={message.timestampSeconds} />
    </section>
  );
}

function ThreadMessageBoardHistory({
  markdownProps,
  projectId,
  subagent,
  subagents,
}: {
  markdownProps: ThreadMessageBoardMarkdownProps;
  projectId: string;
  subagent: WorkbenchSubagentSummary;
  subagents: readonly WorkbenchSubagentSummary[];
}) {
  const live = useWorkbenchThread(projectId, {
    harness: subagent.harness, kind: "subagent", parentThreadId: subagent.parentThreadId, threadId: subagent.threadId,
  }, undefined, "view");
  const document = live.state.document;
  const history = useMemo(
    () => document ? deriveThreadMessageBoardHistory(document.turns, document.turnHistory) : [],
    [document],
  );
  const [loadState, setLoadState] = useState<"idle" | "loading" | "failed">("idle");
  const loadEarlier = async () => {
    if (!document?.nextPageCursor || loadState === "loading") return;
    setLoadState("loading");
    try {
      await live.actions.read(subagent.harness, { cursor: document.nextPageCursor, cwd: subagent.cwd });
      setLoadState("idle");
    } catch (error) {
      setLoadState("failed");
      console.error("Message board history page failed to load.", {
        threadId: subagent.threadId.slice(0, 160),
        reason: (error instanceof Error ? error.message : "Unexpected history read failure").replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 500),
      });
    }
  };
  return (
    // A reversed column scrolls from the bottom, so the newest message starts in view and older pages grow upward.
    <div className="scrollbar-hover-reveal flex max-h-[60vh] flex-col-reverse overflow-y-auto px-4 py-3">
      <div className="min-w-0">
        {document?.nextPageCursor ? (
          <div className="flex justify-center pb-2">
            <button
              type="button"
              className="rounded-lg px-2 py-1 text-[0.8rem] text-fg/muted hover:bg-accent-soft hover:text-text disabled:cursor-wait disabled:opacity-60"
              disabled={loadState === "loading"}
              onClick={() => void loadEarlier()}
            >
              {loadState === "loading" ? "Loading earlier messages…" : loadState === "failed" ? "Retry loading earlier messages" : "Load earlier messages"}
            </button>
          </div>
        ) : null}
        {!document ? (
          <p className="m-0 py-2 text-[0.88em] text-fg/muted">{live.state.error ?? "Loading messages…"}</p>
        ) : history.length ? history.map((message) => (
          <ThreadMessageBoardBubble
            key={message.id}
            markdownProps={{ ...markdownProps, threadCwdPath: document.cwd }}
            message={message}
            subagent={subagent}
            subagents={subagents}
          />
        )) : (
          <p className="m-0 py-2 text-[0.88em] text-fg/muted">No messages yet.</p>
        )}
      </div>
    </div>
  );
}

export default function ThreadMessageBoardTopic({
  markdownProps,
  projectId,
  subagent,
  subagents,
}: {
  markdownProps: ThreadMessageBoardMarkdownProps;
  projectId: string;
  subagent: WorkbenchSubagentSummary;
  subagents: readonly WorkbenchSubagentSummary[];
}) {
  const parsedProjectId = ProjectIdSchema.safeParse(projectId).data ?? null;
  const entry = useWorkbenchThreadSidebarEntry(parsedProjectId, subagent.harness, subagent.threadId);
  const agentName = <ThreadAgentName subagent={subagent} thread={null} />;
  // History holds the child's live "view" interest, so it mounts only while the topic is open.
  const [isOpen, setIsOpen] = useState(false);
  // The row's own status outline becomes the topic border; drawn as overlays so the colour never tints the text.
  const status = entry ? describeThreadEntry(entry, { nowMs: Date.now() }) : null;
  const borderClassName = status
    ? `${status.statusClassName} border-current ${!status.waiting && (status.lifecycle?.kind === "needsAttention" || status.lifecycle?.kind === "stopped") ? "border-dashed" : ""}`
    : neutralBorderClassName;
  return (
    <div className="group/topic relative">
      <ThreadDisclosure
        className="overflow-hidden rounded-[0.8rem]"
        contentClassName="bg-fg/4"
        hideChevron
        onToggle={(event) => setIsOpen(event.currentTarget.open)}
        open={isOpen}
        renderContent={() => isOpen ? (
          <ThreadMessageBoardHistory markdownProps={markdownProps} projectId={projectId} subagent={subagent} subagents={subagents} />
        ) : null}
        summary={(
          // The disclosure summary mutes its text; topic titles keep full contrast.
          <div className="relative text-text">
            {entry && parsedProjectId ? (
              <WorkbenchThreadListItem
                compact={false}
                entry={entry}
                href={undefined}
                presentation="disclosure-summary"
                projectId={parsedProjectId}
                showFrame={false}
                showTooltip={false}
                statusLeading={agentName}
              />
            ) : (
              <span className="flex min-w-0 flex-col px-2 py-1.5">
                <span className="truncate text-text">{subagent.title || subagent.name}</span>
                <span className="text-[0.72rem]">{agentName}</span>
              </span>
            )}
            {isOpen ? <span aria-hidden="true" className={`pointer-events-none absolute inset-x-0 bottom-0 border-b ${borderClassName}`} /> : null}
          </div>
        )}
      />
      {/* Like the row frame it replaces: shown on hover or keyboard focus, and kept while the topic is open. */}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 rounded-[0.8rem] border transition-opacity duration-75 ease-out ${borderClassName} ${isOpen ? "opacity-100" : "opacity-0 group-hover/topic:opacity-100 group-has-[:focus-visible]/topic:opacity-100"}`}
      />
    </div>
  );
}
