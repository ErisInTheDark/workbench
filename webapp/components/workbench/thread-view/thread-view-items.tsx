/*
 * Exports:
 * - ThreadTurnDetails: render one thread turn with grouped commands and typed item sections. Keywords: workbench, thread, turn.
 * - ThreadThreadContent: render all turns for one thread payload without composer chrome. Keywords: workbench, thread, subagent, preview.
 * - ThreadTurnLoadingSkeleton: render a lightweight placeholder for unloaded lazy-history turns. Keywords: workbench, thread, lazy history, skeleton.
 * - Local helpers: summarize inputs, group command, reasoning, file, and web-search sequences, and render the supported thread item variants. Keywords: thread items, command sequence, reasoning, rendering.
 */
"use client";

import { memo, type ReactNode } from "react";

import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "../../../lib/codex/generated/app-server/v2/Turn";
import type { UserInput } from "../../../lib/codex/generated/app-server/v2/UserInput";
import { getCurrentTurn } from "../../../lib/codex/thread-state";
import type { ThreadPayload, WorkbenchSkillSummary, WorkbenchThreadTurnHistoryEntry } from "../../../lib/types";
import type { WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import type { InlineMentionHighlightSources } from "../../../lib/workbench/thread/inline-mention-highlights";
import {
  getPrimaryCollabAgentThreadId,
  type CollabAgentToolCallItem,
} from "../../../lib/workbench/thread/thread-collab-agents";
import {
  getThreadCommandBlockDisplay,
  getThreadCommandDisplay,
} from "../../../lib/workbench/thread/thread-command-matchers";
import {
  formatThreadTimestamp,
  humanizeThreadLabel,
  ThreadCommandSummary,
} from "./thread-view-primitives";
import ThreadAgentName from "./ThreadAgentName";
import ThreadCodeDisplay, { ThreadCommandHeader } from "./ThreadCodeDisplay";
import ThreadContextCompactionItem from "./ThreadContextCompactionItem";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadDurationText from "./ThreadDurationText";
import ThreadDynamicToolCallItem from "./ThreadDynamicToolCallItem";
import ThreadFileChangeItem from "./ThreadFileChangeItem";
import ThreadMarkdown from "./ThreadMarkdown";
import ThreadMcpToolCallItem from "./ThreadMcpToolCallItem";
import ThreadPreviewFrame from "./ThreadPreviewFrame";
import ThreadReasoningItem from "./ThreadReasoningItem";
import ThreadSummaryText from "./ThreadSummaryText";
import ThreadUserImage from "./ThreadUserImage";
import ThreadWebSearchItem, {
  isThreadWebSearchPlaceholder,
  ThreadWebSearchSequence,
} from "./ThreadWebSearchItem";

type CommandItem = Extract<ThreadItem, { type: "commandExecution" }>;
type FileChangeItem = Extract<ThreadItem, { type: "fileChange" }>;
type ReasoningItem = Extract<ThreadItem, { type: "reasoning" }>;
type WebSearchItem = Extract<ThreadItem, { type: "webSearch" }>;
type NonGroupedItem = Exclude<ThreadItem, { type: "commandExecution" } | { type: "fileChange" } | { type: "reasoning" }>;

type ThreadRenderableBlock =
  | { kind: "commandSequence"; items: CommandItem[] }
  | { kind: "fileChangeSequence"; items: FileChangeItem[] }
  | { kind: "reasoningSequence"; items: ReasoningItem[] }
  | { kind: "webSearchSequence"; items: WebSearchItem[] }
  | { kind: "item"; item: NonGroupedItem };

type RelatedThreadsById = Record<string, ThreadPayload | undefined>;

interface HiddenThreadItemIds {
  collabAgentToolCallIds?: ReadonlySet<string> | null;
  controlAgentMessages?: boolean;
  controlUserMessages?: boolean;
  reasoningItemId?: string | null;
  webSearchItemIds?: ReadonlySet<string> | null;
}

function ThreadContentLoadingSkeleton () {
  return (
    <div aria-label="Loading subagent thread" aria-live="polite" role="status" className="space-y-3 py-1">
      <div className="h-3.5 w-44 max-w-full rounded-full workbench-skeleton" aria-hidden="true" />
      <div className="space-y-2">
        <div className="h-3 w-[92%] rounded-full workbench-skeleton" aria-hidden="true" />
        <div className="h-3 w-[76%] rounded-full workbench-skeleton" aria-hidden="true" />
        <div className="h-3 w-[84%] rounded-full workbench-skeleton" aria-hidden="true" />
      </div>
    </div>
  );
}

export function ThreadTurnLoadingSkeleton ({
  entry,
  isLoading = false,
}: {
  entry: WorkbenchThreadTurnHistoryEntry;
  isLoading?: boolean;
}) {
  return (
    <section className="border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] py-3" data-thread-turn-load-state={entry.loadState}>
      <div className="space-y-2" aria-busy={isLoading ? "true" : undefined}>
        <div className="h-3 w-28 animate-pulse rounded bg-[color-mix(in_srgb,var(--text)_10%,transparent)]" />
        <div className="space-y-1.5">
          <div className="h-3 w-[82%] animate-pulse rounded bg-[color-mix(in_srgb,var(--text)_8%,transparent)]" />
          <div className="h-3 w-[64%] animate-pulse rounded bg-[color-mix(in_srgb,var(--text)_7%,transparent)]" />
        </div>
      </div>
    </section>
  );
}

function getFinalAgentMessageId (turn: Turn) {
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (item.type !== "agentMessage" || !item.text.trim()) {
      continue;
    }

    if (item.phase === "final_answer") {
      return item.id;
    }
  }

  return null;
}

function isUserMessageBlock (block: ThreadRenderableBlock) {
  return block.kind === "item" && block.item.type === "userMessage";
}

function isWorkbenchControlUserMessage(item: Extract<ThreadItem, { type: "userMessage" }>) {
  return item.content.some((content) => content.type === "text" && content.text.includes("<!-- workbench-collaboration-control -->"));
}

function isFinalAgentMessageBlock (block: ThreadRenderableBlock, finalAgentMessageId: string | null) {
  return block.kind === "item"
    && block.item.type === "agentMessage"
    && block.item.id === finalAgentMessageId;
}

function getWorkedSummary (turn: Turn) {
  return turn.durationMs === null
    ? "Worked"
    : (
      <span>
        Worked for <ThreadDurationText durationMs={turn.durationMs} />
      </span>
    );
}

function buildRenderableBlocks (items: ThreadItem[], hiddenItemIds: HiddenThreadItemIds = {}): ThreadRenderableBlock[] {
  const blocks: ThreadRenderableBlock[] = [];
  let pendingCommands: CommandItem[] = [];
  let pendingFileChanges: FileChangeItem[] = [];
  let pendingReasoning: ReasoningItem[] = [];
  let pendingWebSearches: WebSearchItem[] = [];

  const flushPendingCommands = () => {
    if (!pendingCommands.length) {
      return;
    }

    blocks.push({
      kind: "commandSequence",
      items: pendingCommands,
    });
    pendingCommands = [];
  };

  const flushPendingReasoning = () => {
    if (!pendingReasoning.length) {
      return;
    }

    blocks.push({
      kind: "reasoningSequence",
      items: pendingReasoning,
    });
    pendingReasoning = [];
  };

  const flushPendingFileChanges = () => {
    if (!pendingFileChanges.length) {
      return;
    }

    blocks.push({
      kind: "fileChangeSequence",
      items: pendingFileChanges,
    });
    pendingFileChanges = [];
  };

  const flushPendingWebSearches = () => {
    if (!pendingWebSearches.length) {
      return;
    }

    blocks.push({
      kind: "webSearchSequence",
      items: pendingWebSearches,
    });
    pendingWebSearches = [];
  };

  for (const item of items) {
    if (item.type === "agentMessage" && !item.text.trim()) {
      continue;
    }

    if (item.type === "agentMessage" && hiddenItemIds.controlAgentMessages) {
      continue;
    }

    if (item.type === "userMessage" && hiddenItemIds.controlUserMessages && isWorkbenchControlUserMessage(item)) {
      continue;
    }

    if (item.type === "commandExecution" && isHiddenCommandExecution(item.command)) {
      continue;
    }

    if (item.type === "commandExecution") {
      flushPendingReasoning();
      flushPendingFileChanges();
      flushPendingWebSearches();
      pendingCommands.push(item);
      continue;
    }

    if (item.type === "reasoning") {
      if (item.id === hiddenItemIds.reasoningItemId || !hasReasoningSteps(item)) {
        continue;
      }

      flushPendingCommands();
      flushPendingFileChanges();
      flushPendingWebSearches();
      pendingReasoning.push(item);
      continue;
    }

    if (item.type === "fileChange") {
      flushPendingCommands();
      flushPendingReasoning();
      flushPendingWebSearches();
      pendingFileChanges.push(item);
      continue;
    }

    if (item.type === "webSearch") {
      flushPendingCommands();
      flushPendingReasoning();
      flushPendingFileChanges();
      if (hiddenItemIds.webSearchItemIds?.has(item.id) || isThreadWebSearchPlaceholder(item)) {
        continue;
      }
      pendingWebSearches.push(item);
      continue;
    }

    if (item.type === "collabAgentToolCall" && hiddenItemIds.collabAgentToolCallIds?.has(item.id)) {
      flushPendingCommands();
      flushPendingReasoning();
      flushPendingFileChanges();
      flushPendingWebSearches();
      continue;
    }

    flushPendingCommands();
    flushPendingReasoning();
    flushPendingFileChanges();
    flushPendingWebSearches();
    blocks.push({
      kind: "item",
      item,
    });
  }

  flushPendingCommands();
  flushPendingReasoning();
  flushPendingFileChanges();
  flushPendingWebSearches();
  return blocks;
}

function isHiddenCommandExecution (command: string) {
  if (/^report_intent(?:\s|$)/i.test(command.trim())) {
    return true;
  }

  return getThreadCommandDisplay({
    command,
    commandActions: [],
    cwd: "",
  }).omitFromDisplay;
}

function hasReasoningSteps (item: ReasoningItem) {
  return item.summary.some((section) => section.trim())
    || item.content.some((section) => section.trim());
}

function formatReasoningStepTitle (value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^#{1,6}\s+/, "")
    .replace(/^\*\*(.+)\*\*$/, "$1")
    .replace(/^\[(.+)\]$/, "$1")
    .replace(/:$/, "")
    .trim() || null;
}

function getReasoningStepTitle (item: ReasoningItem) {
  const visibleSections = item.summary.length ? item.summary : item.content;
  for (const section of visibleSections) {
    const title = formatReasoningStepTitle(section);
    if (title) {
      return title;
    }
  }

  return "Step";
}

function ThreadUserInputLine ({
  inlineMentionSources,
  input,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  inlineMentionSources?: InlineMentionHighlightSources | null;
  input: UserInput;
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  switch (input.type) {
    case "text": {
      const text = input.text.trim();
      return (
        <ThreadMarkdown
          inlineMentionSources={inlineMentionSources}
          markdown={text || "No text captured."}
          threadCwdPath={threadCwdPath}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          workspaceRoots={workspaceRoots}
        />
      );
    }
    case "image":
      return (
        <ThreadUserImage
          alt="User-provided image"
          className="max-w-[22rem]"
          src={input.url}
        />
      );
    case "localImage":
      return (
        <p className="m-0 break-all font-mono text-[0.78em] leading-[1.6] text-muted">
          Local image: {input.path}
        </p>
      );
    case "skill":
      return (
        <p className="m-0 text-[0.92em] leading-[1.6] text-muted">
          Skill: <span className="text-text">{input.name}</span>{" "}
          <span className="break-all font-mono text-[0.78em]">({input.path})</span>
        </p>
      );
    case "mention":
      return (
        <p className="m-0 text-[0.92em] leading-[1.6] text-muted">
          Mention: <span className="text-text">{input.name}</span>{" "}
          <span className="break-all font-mono text-[0.78em]">({input.path})</span>
        </p>
      );
    default:
      return null;
  }
}

function ThreadMessageTimestamp ({
  align = "left",
  className = "",
  timestampSeconds,
}: {
  align?: "left" | "right";
  className?: string;
  timestampSeconds: number | null;
}) {
  if (timestampSeconds === null) {
    return null;
  }

  return (
    <p className={`m-0 text-[0.67em] leading-[1.5] text-muted${align === "right" ? " text-right" : ""}${className ? ` ${className}` : ""}`}>
      {formatThreadTimestamp(timestampSeconds)}
    </p>
  );
}

function ThreadUserMessageItem ({
  inlineMentionSources,
  item,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  showStartedAt,
  startedAt,
  workspaceRoots,
}: {
  inlineMentionSources?: InlineMentionHighlightSources | null;
  item: Extract<ThreadItem, { type: "userMessage" }>;
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  showStartedAt: boolean;
  startedAt: number | null;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  return (
    <section className="flex flex-col items-end py-2">
      <div className="w-full max-w-[42rem] rounded-[1.15rem] bg-[color-mix(in_srgb,var(--text)_6%,transparent)] px-4 py-3">
        <div className="space-y-2 text-left">
          {item.content.length ? item.content.map((content, index) => (
            <ThreadUserInputLine
              key={`${item.id}:content:${index}:${content.type}`}
              input={content}
              inlineMentionSources={inlineMentionSources}
              threadCwdPath={threadCwdPath}
              projectFilePaths={projectFilePaths}
              projectId={projectId}
              projectRootPath={projectRootPath}
              workspaceRoots={workspaceRoots}
            />
          )) : (
            <p className="m-0 text-[0.92em] leading-[1.6] text-muted">No user content captured.</p>
          )}
        </div>
      </div>
      {showStartedAt ? <ThreadMessageTimestamp align="right" className="mt-1" timestampSeconds={startedAt} /> : null}
    </section>
  );
}

function ThreadAgentMessageItem ({
  completedAt,
  inlineMentionSources,
  isFinal,
  item,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  completedAt: number | null;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  isFinal: boolean;
  item: Extract<ThreadItem, { type: "agentMessage" }>;
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  return (
    <section className="py-2">
      <ThreadMarkdown
        inlineMentionSources={inlineMentionSources}
        markdown={item.text || "No assistant text captured."}
        threadCwdPath={threadCwdPath}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        workspaceRoots={workspaceRoots}
      />
      {isFinal ? <ThreadMessageTimestamp className="mt-1" timestampSeconds={completedAt} /> : null}
    </section>
  );
}

function ThreadPlanItem ({
  inlineMentionSources,
  item,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  inlineMentionSources?: InlineMentionHighlightSources | null;
  item: Extract<ThreadItem, { type: "plan" }>;
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 pl-6"
      summary={<ThreadSummaryText text="Plan" />}
      summaryClassName="text-[0.92em] leading-[1.6] text-muted"
    >
      <ThreadMarkdown
        inlineMentionSources={inlineMentionSources}
        markdown={item.text || "No plan text captured."}
        threadCwdPath={threadCwdPath}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        workspaceRoots={workspaceRoots}
      />
    </ThreadDisclosure>
  );
}

function ThreadAgentBubble ({
  inlineMentionSources,
  label,
  markdown,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  inlineMentionSources?: InlineMentionHighlightSources | null;
  label: ReactNode;
  markdown: string;
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  return (
    <section className="py-2">
      <div className="w-full max-w-[42rem] rounded-[1.15rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] px-4 py-3">
        <div className="m-0 pb-2 text-[0.74em] font-medium leading-[1.4] text-muted">
          {label}
        </div>
        <ThreadMarkdown
          inlineMentionSources={inlineMentionSources}
          markdown={markdown || "No message captured."}
          threadCwdPath={threadCwdPath}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          workspaceRoots={workspaceRoots}
        />
      </div>
    </section>
  );
}

function getCollabAgentStateMessage (item: CollabAgentToolCallItem, receiverThreadId: string) {
  const preferredMessage = item.agentsStates[receiverThreadId]?.message?.trim();
  if (preferredMessage) {
    return preferredMessage;
  }

  for (const threadId of item.receiverThreadIds) {
    const message = item.agentsStates[threadId]?.message?.trim();
    if (message) {
      return message;
    }
  }

  return null;
}

function ThreadCurrentSubagentItemPreview ({
  inlineMentionSources,
  knownSkills,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  relatedThreadsById,
  thread,
  workspaceRoots,
}: {
  inlineMentionSources?: InlineMentionHighlightSources | null;
  knownSkills?: WorkbenchSkillSummary[];
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  relatedThreadsById: RelatedThreadsById;
  thread: ThreadPayload | undefined;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const currentTurn = getCurrentTurn(thread);
  if (!currentTurn) {
    return (
      <p className="m-0 text-[0.92em] leading-[1.6] text-muted">
        No subagent activity was captured yet.
      </p>
    );
  }

  const blocks = buildRenderableBlocks(currentTurn.items);
  const block = blocks.at(-1) ?? null;
  if (!block) {
    return (
      <p className="m-0 text-[0.92em] leading-[1.6] text-muted">
        No subagent activity was captured yet.
      </p>
    );
  }

  return (
    <ThreadPreviewFrame height="22rem" scale={0.9}>
      <ThreadRenderableBlockView
        block={block}
        finalAgentMessageId={getFinalAgentMessageId(currentTurn)}
        isMostRecentBlock={true}
        inlineMentionSources={inlineMentionSources}
        knownSkills={knownSkills}
        primaryUserBlock={null}
        threadCwdPath={threadCwdPath ?? thread?.cwd}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        relatedThreadsById={relatedThreadsById}
        turnCompletedAt={currentTurn.completedAt}
        turnStartedAt={currentTurn.startedAt}
        workspaceRoots={workspaceRoots}
      />
    </ThreadPreviewFrame>
  );
}

function ThreadCollabAgentToolCallItem ({
  inlineMentionSources,
  isMostRecent,
  item,
  knownSkills,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  relatedThreadsById,
  workspaceRoots,
}: {
  inlineMentionSources?: InlineMentionHighlightSources | null;
  isMostRecent: boolean;
  item: CollabAgentToolCallItem;
  knownSkills?: WorkbenchSkillSummary[];
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  relatedThreadsById: RelatedThreadsById;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const receiverThreadId = getPrimaryCollabAgentThreadId(item);
  const receiverThread = relatedThreadsById[receiverThreadId];
  const prompt = item.prompt?.trim() ?? "";
  const responseMessage = getCollabAgentStateMessage(item, receiverThreadId);
  const isActiveWait = item.status === "inProgress" && isMostRecent;
  const agentName = (
    <ThreadAgentName
      fallbackKey={receiverThreadId}
      thread={receiverThread}
    />
  );

  if (item.tool === "spawnAgent") {
    return (
      <ThreadDisclosure
        className="py-2"
        contentClassName="mt-2 pl-6"
        summary={<><span>Spawned </span>{agentName}</>}
        summaryClassName="text-[0.92em] leading-[1.6] text-muted"
      >
        <ThreadAgentBubble
          label="Main agent"
          inlineMentionSources={inlineMentionSources}
          markdown={prompt}
          threadCwdPath={threadCwdPath}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          workspaceRoots={workspaceRoots}
        />
      </ThreadDisclosure>
    );
  }

  if (item.tool === "wait") {
    return (
      <ThreadDisclosure
        className="py-2"
        contentClassName="mt-2 pl-6"
        defaultOpen={isActiveWait}
        summary={<><span>{isActiveWait ? "Waiting for " : "Waited for "}</span>{agentName}</>}
        summaryClassName="text-[0.92em] leading-[1.6] text-muted"
      >
        {isActiveWait ? (
          <ThreadCurrentSubagentItemPreview
            inlineMentionSources={inlineMentionSources}
            knownSkills={knownSkills}
            threadCwdPath={receiverThread?.cwd ?? threadCwdPath}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            relatedThreadsById={relatedThreadsById}
            thread={receiverThread}
            workspaceRoots={workspaceRoots}
          />
        ) : null}
      </ThreadDisclosure>
    );
  }

  if ((item.tool === "sendInput" || item.tool === "resumeAgent") && prompt) {
    return (
      <ThreadDisclosure
        className="py-2"
        contentClassName="mt-2 pl-6"
        summary={<><span>Messaged </span>{agentName}</>}
        summaryClassName="text-[0.92em] leading-[1.6] text-muted"
      >
        <ThreadAgentBubble
          label="Main agent"
          inlineMentionSources={inlineMentionSources}
          markdown={prompt}
          threadCwdPath={threadCwdPath}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          workspaceRoots={workspaceRoots}
        />
      </ThreadDisclosure>
    );
  }

  if (responseMessage) {
    return (
      <ThreadDisclosure
        className="py-2"
        contentClassName="mt-2 pl-6"
        summary={<><span>Received response from </span>{agentName}</>}
        summaryClassName="text-[0.92em] leading-[1.6] text-muted"
      >
        <ThreadAgentBubble
          label={agentName}
          inlineMentionSources={inlineMentionSources}
          markdown={responseMessage}
          threadCwdPath={receiverThread?.cwd ?? threadCwdPath}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          workspaceRoots={workspaceRoots}
        />
      </ThreadDisclosure>
    );
  }

  if (item.tool === "closeAgent") {
    return (
      <ThreadDisclosure
        className="py-2"
        contentClassName="mt-2 pl-6"
        summary={<><span>Closed </span>{agentName}</>}
        summaryClassName="text-[0.92em] leading-[1.6] text-muted"
      >
        <></>
      </ThreadDisclosure>
    );
  }

  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 pl-6"
      summary={`Collaboration: ${humanizeThreadLabel(item.tool)}`}
      summaryClassName="text-[0.92em] leading-[1.6] text-muted"
    >
      <pre className="m-0 max-w-full overflow-x-auto whitespace-pre rounded-[0.9rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] px-4 py-3 font-mono text-[0.78em] leading-[1.6] text-text">
        {JSON.stringify(item, null, 2)}
      </pre>
    </ThreadDisclosure>
  );
}

function ThreadReasoningSequence ({
  block,
  inlineMentionSources,
  isMostRecent,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  block: Extract<ThreadRenderableBlock, { kind: "reasoningSequence" }>;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  isMostRecent: boolean;
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const visibleItems = block.items.filter(hasReasoningSteps);
  const totalItems = visibleItems.reduce((sum, item) => (
    sum + (item.summary.filter((section) => section.trim()).length || item.content.filter((section) => section.trim()).length)
  ), 0);
  if (!totalItems) {
    return null;
  }

  const content = (
    <div className="space-y-4">
      {visibleItems.map((item, index) => (
        <ThreadReasoningItem
          key={item.id}
          className={index ? "border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] pt-4" : undefined}
          item={item}
          inlineMentionSources={inlineMentionSources}
          threadCwdPath={threadCwdPath}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          workspaceRoots={workspaceRoots}
        />
      ))}
    </div>
  );

  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 space-y-4 pl-6"
      defaultOpen={isMostRecent}
      summary={totalItems === 1 ? (<>
        <span>Reasoned: </span>
        <span className="thread-item-disclosure-prominent-text-portion font-medium text-text">{getReasoningStepTitle(visibleItems[0])}</span>
      </>) : (<>
        <span>Reasoned over </span>
        <span className="thread-item-disclosure-prominent-text-portion text-text">{totalItems}</span>
        <span> steps</span>
      </>)}
      summaryClassName="text-[0.92em] leading-[1.6] text-muted"
    >
      {content}
    </ThreadDisclosure>
  );
}

function ThreadCommandExecutionDetails ({
  isMostRecent = false,
  item,
  knownSkills,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  isMostRecent?: boolean;
  item: CommandItem;
  knownSkills?: WorkbenchSkillSummary[];
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const commandDisplay = getThreadCommandDisplay({
    command: item.command,
    commandActions: item.commandActions,
    cwd: item.cwd,
    knownSkills,
    projectRootPath,
    workspaceRoots,
  });
  const metaParts = [];

  if (item.status !== "completed") {
    metaParts.push(
      <ThreadSummaryText
        key={`${item.id}:status`}
        text={humanizeThreadLabel(item.status)}
      />,
    );
  }

  if (item.exitCode !== null && item.exitCode !== 0) {
    metaParts.push(
      <ThreadSummaryText
        key={`${item.id}:exit`}
        text={`exit ${item.exitCode}`}
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
      contentClassName="mt-2 space-y-2 pl-6"
      defaultOpen={isMostRecent}
      summary={(
        <>
          <ThreadCommandSummary display={commandDisplay} projectFilePaths={projectFilePaths} projectId={projectId} />
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
      summaryClassName="text-[0.92em] leading-[1.6] text-muted"
    >
      <>
        {/*commandDisplay.showShell && commandDisplay.shell ? (
          <p className="m-0 text-[0.78em] leading-[1.6] text-muted">
            Shell: <span className="font-mono text-text">{commandDisplay.shell}</span>
          </p>
        ) : null*/}
        {commandDisplay.cwdDisplay ? (
          <p className="m-0 text-[0.78em] leading-[1.6] text-muted">
            Working dir: <span className="break-all font-mono text-text">{commandDisplay.cwdDisplay}</span>
          </p>
        ) : null}
        {item.aggregatedOutput?.trim() ? (
          <ThreadCodeDisplay
            header={<ThreadCommandHeader command={item.command} surface="framed" />}
            output={item.aggregatedOutput.trim()}
            preview
            variant="plain"
          />
        ) : (
          <ThreadCodeDisplay
            header={<ThreadCommandHeader command={item.command} surface="framed" />}
            preview
            variant="plain"
          />
        )}
      </>
    </ThreadDisclosure>
  );
}

function ThreadCommandSequence ({
  isMostRecent,
  items,
  knownSkills,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  isMostRecent: boolean;
  items: CommandItem[];
  knownSkills?: WorkbenchSkillSummary[];
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  if (items.length === 1) {
    return <ThreadCommandExecutionDetails isMostRecent={isMostRecent} item={items[0]} knownSkills={knownSkills} projectFilePaths={projectFilePaths} projectId={projectId} projectRootPath={projectRootPath} workspaceRoots={workspaceRoots} />;
  }

  const commandBlockDisplay = getThreadCommandBlockDisplay({
    items: items.map((item) => ({
      command: item.command,
      commandActions: item.commandActions,
      cwd: item.cwd,
    })),
    knownSkills,
    projectRootPath,
    workspaceRoots,
  });

  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 space-y-1 pl-6"
      defaultOpen={isMostRecent}
      summary={<ThreadCommandSummary display={commandBlockDisplay} projectFilePaths={projectFilePaths} projectId={projectId} />}
      summaryClassName="text-[0.92em] leading-[1.6] text-muted"
    >
      <>
        {items.map((item, index) => (
          <ThreadCommandExecutionDetails
            isMostRecent={isMostRecent && index === items.length - 1}
            item={item}
            key={item.id}
            knownSkills={knownSkills}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            workspaceRoots={workspaceRoots}
          />
        ))}
      </>
    </ThreadDisclosure>
  );
}

function ThreadFallbackItem ({ item }: { item: NonGroupedItem }) {
  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 pl-6"
      summary={<ThreadSummaryText text={item.type} />}
      summaryClassName="text-[0.92em] leading-[1.6] text-muted"
    >
      <pre className="m-0 max-w-full overflow-x-auto whitespace-pre rounded-[0.9rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] px-4 py-3 font-mono text-[0.78em] leading-[1.6] text-text">
        {JSON.stringify(item, null, 2)}
      </pre>
    </ThreadDisclosure>
  );
}

function ThreadRenderableBlockView ({
  block,
  finalAgentMessageId,
  inlineMentionSources,
  isMostRecentBlock,
  knownSkills,
  primaryUserBlock,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  relatedThreadsById,
  turnCompletedAt,
  turnStartedAt,
  workspaceRoots,
}: {
  block: ThreadRenderableBlock;
  finalAgentMessageId: string | null;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  isMostRecentBlock: boolean;
  knownSkills?: WorkbenchSkillSummary[];
  primaryUserBlock: ThreadRenderableBlock | null;
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  relatedThreadsById: RelatedThreadsById;
  turnCompletedAt: number | null;
  turnStartedAt: number | null;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  if (block.kind === "commandSequence") {
    return <ThreadCommandSequence isMostRecent={isMostRecentBlock} items={block.items} knownSkills={knownSkills} projectFilePaths={projectFilePaths} projectId={projectId} projectRootPath={projectRootPath} workspaceRoots={workspaceRoots} />;
  }

  if (block.kind === "fileChangeSequence") {
    return <ThreadFileChangeItem items={block.items} projectFilePaths={projectFilePaths} projectId={projectId} projectRootPath={projectRootPath} workspaceRoots={workspaceRoots} />;
  }

  if (block.kind === "reasoningSequence") {
    return (
      <ThreadReasoningSequence
        block={block}
        inlineMentionSources={inlineMentionSources}
        isMostRecent={isMostRecentBlock}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        threadCwdPath={threadCwdPath}
        projectRootPath={projectRootPath}
        workspaceRoots={workspaceRoots}
      />
    );
  }

  if (block.kind === "webSearchSequence") {
    return <ThreadWebSearchSequence items={block.items} />;
  }

  switch (block.item.type) {
    case "userMessage":
      return (
        <ThreadUserMessageItem
          item={block.item}
          inlineMentionSources={inlineMentionSources}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          threadCwdPath={threadCwdPath}
          projectRootPath={projectRootPath}
          workspaceRoots={workspaceRoots}
          showStartedAt={block === primaryUserBlock}
          startedAt={turnStartedAt}
        />
      );
    case "agentMessage":
      return (
        <ThreadAgentMessageItem
          completedAt={turnCompletedAt}
          isFinal={block.item.id === finalAgentMessageId}
          item={block.item}
          inlineMentionSources={inlineMentionSources}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          threadCwdPath={threadCwdPath}
          projectRootPath={projectRootPath}
          workspaceRoots={workspaceRoots}
        />
      );
    case "plan":
      return (
        <ThreadPlanItem
          inlineMentionSources={inlineMentionSources}
          item={block.item}
          threadCwdPath={threadCwdPath}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          workspaceRoots={workspaceRoots}
        />
      );
    case "contextCompaction":
      return <ThreadContextCompactionItem item={block.item} />;
    case "mcpToolCall":
      return <ThreadMcpToolCallItem item={block.item} />;
    case "dynamicToolCall":
      return <ThreadDynamicToolCallItem inlineMentionSources={inlineMentionSources} item={block.item} threadCwdPath={threadCwdPath} projectFilePaths={projectFilePaths} projectId={projectId} projectRootPath={projectRootPath} workspaceRoots={workspaceRoots} />;
    case "webSearch":
      return <ThreadWebSearchItem item={block.item} />;
    case "collabAgentToolCall":
      return (
        <ThreadCollabAgentToolCallItem
          isMostRecent={isMostRecentBlock}
          inlineMentionSources={inlineMentionSources}
          item={block.item}
          knownSkills={knownSkills}
          threadCwdPath={threadCwdPath}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          relatedThreadsById={relatedThreadsById}
          workspaceRoots={workspaceRoots}
        />
      );
    default:
      return <ThreadFallbackItem item={block.item} />;
  }
}

function ThreadTurnDetailsComponent ({
  hiddenCollabAgentToolCallItemIds = [],
  hideFinalAgentMessage = false,
  hideWorkbenchControlAgentMessages = false,
  hideWorkbenchControlUserMessages = false,
  hiddenReasoningItemId = null,
  hiddenWebSearchItemIds = [],
  inlineMentionSources = null,
  knownSkills = [],
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  relatedThreadsById = {},
  turn,
  workspaceRoots,
}: {
  hiddenCollabAgentToolCallItemIds?: readonly string[];
  hideFinalAgentMessage?: boolean;
  hideWorkbenchControlAgentMessages?: boolean;
  hideWorkbenchControlUserMessages?: boolean;
  hiddenReasoningItemId?: string | null;
  hiddenWebSearchItemIds?: readonly string[];
  inlineMentionSources?: InlineMentionHighlightSources | null;
  knownSkills?: WorkbenchSkillSummary[];
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  relatedThreadsById?: RelatedThreadsById;
  turn: Turn;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const hiddenCollabAgentToolCallIds = hiddenCollabAgentToolCallItemIds.length
    ? new Set(hiddenCollabAgentToolCallItemIds)
    : null;
  const hiddenWebSearchIds = hiddenWebSearchItemIds.length
    ? new Set(hiddenWebSearchItemIds)
    : null;
  const isWorkbenchControlTurn = turn.items.some((item) => item.type === "userMessage" && isWorkbenchControlUserMessage(item));
  const blocks = buildRenderableBlocks(turn.items, {
    collabAgentToolCallIds: hiddenCollabAgentToolCallIds,
    controlAgentMessages: hideWorkbenchControlAgentMessages && isWorkbenchControlTurn,
    controlUserMessages: hideWorkbenchControlUserMessages,
    reasoningItemId: hiddenReasoningItemId,
    webSearchItemIds: hiddenWebSearchIds,
  });
  const finalAgentMessageId = getFinalAgentMessageId(turn);
  const isCompleted = turn.status === "completed";
  const primaryUserBlock = isCompleted
    ? blocks.find((block) => isUserMessageBlock(block)) ?? null
    : null;
  const finalAgentBlocks = isCompleted
    ? hideFinalAgentMessage ? [] : blocks.filter((block) => isFinalAgentMessageBlock(block, finalAgentMessageId))
    : [];
  const workedBlocks = isCompleted
    ? blocks.filter((block) => block !== primaryUserBlock && !isFinalAgentMessageBlock(block, finalAgentMessageId))
    : blocks;
  if (isCompleted && hideFinalAgentMessage && hideWorkbenchControlUserMessages && !primaryUserBlock && !workedBlocks.length && !finalAgentBlocks.length) {
    return null;
  }

  const renderBlock = (block: ThreadRenderableBlock, index: number) => (
    <ThreadRenderableBlockView
      key={block.kind === "commandSequence"
        ? `commands:${block.items[0]?.id ?? index}`
        : block.kind === "fileChangeSequence"
          ? `fileChanges:${block.items[0]?.id ?? index}`
          : block.kind === "reasoningSequence"
            ? `reasoning:${block.items[0]?.id ?? index}`
            : block.kind === "webSearchSequence"
              ? `webSearches:${block.items[0]?.id ?? index}`
              : `item:${block.item.id}`}
      block={block}
      finalAgentMessageId={finalAgentMessageId}
      inlineMentionSources={inlineMentionSources}
      isMostRecentBlock={block === blocks[blocks.length - 1]}
      knownSkills={knownSkills}
      primaryUserBlock={primaryUserBlock}
      threadCwdPath={threadCwdPath}
      projectFilePaths={projectFilePaths}
      projectId={projectId}
      projectRootPath={projectRootPath}
      relatedThreadsById={relatedThreadsById}
      turnCompletedAt={turn.completedAt}
      turnStartedAt={turn.startedAt}
      workspaceRoots={workspaceRoots}
    />
  );

  return (
    <section className="border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] py-3">
      {isCompleted ? (
        <div className="space-y-2">
          {primaryUserBlock ? renderBlock(primaryUserBlock, 0) : null}
          <ThreadDisclosure
            className="py-2"
            contentClassName="mt-2 space-y-2 pl-6"
            summary={getWorkedSummary(turn)}
            summaryClassName="text-[0.92em] leading-[1.6] text-muted"
          >
            <div className="space-y-2">
              {workedBlocks.length ? workedBlocks.map(renderBlock) : (
                <p className="m-0 text-[0.92em] leading-[1.6] text-muted">No intermediate work captured.</p>
              )}
            </div>
          </ThreadDisclosure>
          {finalAgentBlocks.map(renderBlock)}
          {/* {!primaryUserBlock && !finalAgentBlocks.length && !blocks.length ? (
            <p className="m-0 text-[0.92em] leading-[1.6] text-muted">No captured items.</p>
          ) : null} */}
        </div>
      ) : (
        <div className="space-y-2">
          {/* <p className="m-0 text-[0.67em] uppercase tracking-[0.18em] text-muted">
            {humanizeThreadLabel(turn.status)}
          </p> */}
          {workedBlocks.length ? workedBlocks.map(renderBlock) : (
            <></> // <p className="m-0 text-[0.92em] leading-[1.6] text-muted">No captured items.</p>
          )}
        </div>
      )}
    </section>
  );
}

function areThreadTurnDetailsPropsEqual (
  left: Readonly<Parameters<typeof ThreadTurnDetailsComponent>[0]>,
  right: Readonly<Parameters<typeof ThreadTurnDetailsComponent>[0]>,
) {
  return left.turn === right.turn
    && left.hiddenCollabAgentToolCallItemIds === right.hiddenCollabAgentToolCallItemIds
    && left.hideFinalAgentMessage === right.hideFinalAgentMessage
    && left.hideWorkbenchControlAgentMessages === right.hideWorkbenchControlAgentMessages
    && left.hideWorkbenchControlUserMessages === right.hideWorkbenchControlUserMessages
    && left.hiddenReasoningItemId === right.hiddenReasoningItemId
    && left.hiddenWebSearchItemIds === right.hiddenWebSearchItemIds
    && left.inlineMentionSources === right.inlineMentionSources
    && left.knownSkills === right.knownSkills
    && left.threadCwdPath === right.threadCwdPath
    && left.projectFilePaths === right.projectFilePaths
    && left.projectId === right.projectId
    && left.projectRootPath === right.projectRootPath
    && left.relatedThreadsById === right.relatedThreadsById;
}

export const ThreadTurnDetails = memo(ThreadTurnDetailsComponent, areThreadTurnDetailsPropsEqual);

export function ThreadThreadContent ({
  emptyMessage = "No subagent activity was captured yet.",
  hiddenCollabAgentToolCallItemIds = [],
  hideFinalAgentMessage = false,
  hideWorkbenchControlAgentMessages = false,
  hideWorkbenchControlUserMessages = false,
  hiddenReasoningItemId = null,
  hiddenWebSearchItemIds = [],
  inlineMentionSources = null,
  knownSkills = [],
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRoots,
  projectRootPath,
  relatedThreadsById = {},
  thread,
}: {
  emptyMessage?: string;
  hiddenCollabAgentToolCallItemIds?: readonly string[];
  hideFinalAgentMessage?: boolean;
  hideWorkbenchControlAgentMessages?: boolean;
  hideWorkbenchControlUserMessages?: boolean;
  hiddenReasoningItemId?: string | null;
  hiddenWebSearchItemIds?: readonly string[];
  inlineMentionSources?: InlineMentionHighlightSources | null;
  knownSkills?: WorkbenchSkillSummary[];
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRoots?: readonly { id: string; rootPath: string }[];
  projectRootPath?: string;
  relatedThreadsById?: RelatedThreadsById;
  thread: ThreadPayload | null | undefined;
}) {
  if (!thread) {
    return <ThreadContentLoadingSkeleton />;
  }

  if (!thread.turns.length) {
    const unloadedEntry = thread.turnHistory.find((entry) => entry.loadState !== "loaded");
    if (unloadedEntry) {
      return <ThreadTurnLoadingSkeleton entry={unloadedEntry} />;
    }

    return (
      <p className="m-0 text-[0.92em] leading-[1.6] text-muted">
        {emptyMessage}
      </p>
    );
  }

  const loadedTurnsById = new Map(thread.turns.map((turn) => [turn.id, turn]));
  const visibleEntries = (thread.turnHistory.length ? thread.turnHistory : thread.turns.map((turn) => ({
    completedAt: turn.completedAt,
    durationMs: turn.durationMs,
    itemCount: turn.items.length,
    itemIds: turn.items.map((item) => item.id),
    loadState: "loaded" as const,
    startedAt: turn.startedAt,
    status: turn.status,
    turnId: turn.id,
  }))).filter((entry) => loadedTurnsById.has(entry.turnId) || entry.loadState !== "loaded").slice(-4);

  return (
    <>
      {visibleEntries.map((entry) => {
        const turn = loadedTurnsById.get(entry.turnId);
        return turn ? (
          <ThreadTurnDetails
            key={entry.turnId}
            hiddenCollabAgentToolCallItemIds={hiddenCollabAgentToolCallItemIds}
            hideFinalAgentMessage={hideFinalAgentMessage}
            hideWorkbenchControlAgentMessages={hideWorkbenchControlAgentMessages}
            hideWorkbenchControlUserMessages={hideWorkbenchControlUserMessages}
            hiddenReasoningItemId={hiddenReasoningItemId}
            hiddenWebSearchItemIds={hiddenWebSearchItemIds}
            inlineMentionSources={inlineMentionSources}
            knownSkills={knownSkills}
            threadCwdPath={threadCwdPath ?? thread.cwd}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            relatedThreadsById={relatedThreadsById}
            turn={turn}
            workspaceRoots={projectRoots}
          />
        ) : (
          <ThreadTurnLoadingSkeleton key={entry.turnId} entry={entry} />
        );
      })}
    </>
  );
}
