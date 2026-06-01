/*
 * Exports:
 * - ThreadTurnDetails: render one thread turn with grouped commands and typed item sections. Keywords: workbench, thread, turn.
 * - ThreadThreadContent: render all turns for one thread payload without composer chrome. Keywords: workbench, thread, subagent, preview.
 * - Local helpers: summarize inputs, group command, reasoning, file, and web-search sequences, and render the supported thread item variants. Keywords: thread items, command sequence, reasoning, rendering.
 */
"use client";

import { memo, type ReactNode } from "react";

import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "../../../lib/codex/generated/app-server/v2/Turn";
import type { UserInput } from "../../../lib/codex/generated/app-server/v2/UserInput";
import { getCurrentTurn } from "../../../lib/codex/thread-state";
import type { ThreadPayload, WorkbenchSkillSummary } from "../../../lib/types";
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
  ThreadTextBlock,
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
  reasoningItemId?: string | null;
  webSearchItemIds?: ReadonlySet<string> | null;
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
  onOpenFile,
  projectRootPath,
}: {
  inlineMentionSources?: InlineMentionHighlightSources | null;
  input: UserInput;
  onOpenFile?: (path: string) => Promise<void>;
  projectRootPath?: string;
}) {
  switch (input.type) {
    case "text": {
      const text = input.text.trim();
      return (
        <ThreadMarkdown
          inlineMentionSources={inlineMentionSources}
          markdown={text || "No text captured."}
          onOpenFile={onOpenFile}
          projectRootPath={projectRootPath}
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
  onOpenFile,
  projectRootPath,
  showStartedAt,
  startedAt,
}: {
  inlineMentionSources?: InlineMentionHighlightSources | null;
  item: Extract<ThreadItem, { type: "userMessage" }>;
  onOpenFile?: (path: string) => Promise<void>;
  projectRootPath?: string;
  showStartedAt: boolean;
  startedAt: number | null;
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
              onOpenFile={onOpenFile}
              projectRootPath={projectRootPath}
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
  onOpenFile,
  projectRootPath,
}: {
  completedAt: number | null;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  isFinal: boolean;
  item: Extract<ThreadItem, { type: "agentMessage" }>;
  onOpenFile?: (path: string) => Promise<void>;
  projectRootPath?: string;
}) {
  return (
    <section className="py-2">
      <ThreadMarkdown
        inlineMentionSources={inlineMentionSources}
        markdown={item.text || "No assistant text captured."}
        onOpenFile={onOpenFile}
        projectRootPath={projectRootPath}
      />
      {isFinal ? <ThreadMessageTimestamp className="mt-1" timestampSeconds={completedAt} /> : null}
    </section>
  );
}

function ThreadPlanItem ({ item }: { item: Extract<ThreadItem, { type: "plan" }> }) {
  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 pl-6"
      summary={<ThreadSummaryText text="Plan" />}
      summaryClassName="text-[0.92em] leading-[1.6] text-muted"
    >
      <>
        <ThreadTextBlock>{item.text || "No plan text captured."}</ThreadTextBlock>
      </>
    </ThreadDisclosure>
  );
}

function ThreadAgentBubble ({
  inlineMentionSources,
  label,
  markdown,
  onOpenFile,
  projectRootPath,
}: {
  inlineMentionSources?: InlineMentionHighlightSources | null;
  label: ReactNode;
  markdown: string;
  onOpenFile?: (path: string) => Promise<void>;
  projectRootPath?: string;
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
          onOpenFile={onOpenFile}
          projectRootPath={projectRootPath}
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
  onOpenFile,
  projectRootPath,
  relatedThreadsById,
  thread,
}: {
  inlineMentionSources?: InlineMentionHighlightSources | null;
  knownSkills?: WorkbenchSkillSummary[];
  onOpenFile?: (path: string) => Promise<void>;
  projectRootPath?: string;
  relatedThreadsById: RelatedThreadsById;
  thread: ThreadPayload | undefined;
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
        onOpenFile={onOpenFile}
        primaryUserBlock={null}
        projectRootPath={projectRootPath}
        relatedThreadsById={relatedThreadsById}
        turnCompletedAt={currentTurn.completedAt}
        turnStartedAt={currentTurn.startedAt}
      />
    </ThreadPreviewFrame>
  );
}

function ThreadCollabAgentToolCallItem ({
  inlineMentionSources,
  isMostRecent,
  item,
  knownSkills,
  onOpenFile,
  projectRootPath,
  relatedThreadsById,
}: {
  inlineMentionSources?: InlineMentionHighlightSources | null;
  isMostRecent: boolean;
  item: CollabAgentToolCallItem;
  knownSkills?: WorkbenchSkillSummary[];
  onOpenFile?: (path: string) => Promise<void>;
  projectRootPath?: string;
  relatedThreadsById: RelatedThreadsById;
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
          onOpenFile={onOpenFile}
          projectRootPath={projectRootPath}
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
            onOpenFile={onOpenFile}
            inlineMentionSources={inlineMentionSources}
            knownSkills={knownSkills}
            projectRootPath={projectRootPath}
            relatedThreadsById={relatedThreadsById}
            thread={receiverThread}
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
          onOpenFile={onOpenFile}
          projectRootPath={projectRootPath}
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
          onOpenFile={onOpenFile}
          projectRootPath={projectRootPath}
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
  onOpenFile,
  projectRootPath,
}: {
  block: Extract<ThreadRenderableBlock, { kind: "reasoningSequence" }>;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  isMostRecent: boolean;
  onOpenFile?: (path: string) => Promise<void>;
  projectRootPath?: string;
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
          onOpenFile={onOpenFile}
          projectRootPath={projectRootPath}
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
  projectRootPath,
}: {
  isMostRecent?: boolean;
  item: CommandItem;
  knownSkills?: WorkbenchSkillSummary[];
  projectRootPath?: string;
}) {
  const commandDisplay = getThreadCommandDisplay({
    command: item.command,
    commandActions: item.commandActions,
    cwd: item.cwd,
    knownSkills,
    projectRootPath,
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
          <ThreadCommandSummary display={commandDisplay} />
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
  projectRootPath,
}: {
  isMostRecent: boolean;
  items: CommandItem[];
  knownSkills?: WorkbenchSkillSummary[];
  projectRootPath?: string;
}) {
  if (items.length === 1) {
    return <ThreadCommandExecutionDetails isMostRecent={isMostRecent} item={items[0]} knownSkills={knownSkills} projectRootPath={projectRootPath} />;
  }

  const commandBlockDisplay = getThreadCommandBlockDisplay({
    items: items.map((item) => ({
      command: item.command,
      commandActions: item.commandActions,
      cwd: item.cwd,
    })),
    knownSkills,
    projectRootPath,
  });

  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 space-y-1 pl-6"
      defaultOpen={isMostRecent}
      summary={<ThreadCommandSummary display={commandBlockDisplay} />}
      summaryClassName="text-[0.92em] leading-[1.6] text-muted"
    >
      <>
        {items.map((item, index) => (
          <ThreadCommandExecutionDetails
            isMostRecent={isMostRecent && index === items.length - 1}
            item={item}
            key={item.id}
            knownSkills={knownSkills}
            projectRootPath={projectRootPath}
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
  onOpenFile,
  primaryUserBlock,
  projectRootPath,
  relatedThreadsById,
  turnCompletedAt,
  turnStartedAt,
}: {
  block: ThreadRenderableBlock;
  finalAgentMessageId: string | null;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  isMostRecentBlock: boolean;
  knownSkills?: WorkbenchSkillSummary[];
  onOpenFile?: (path: string) => Promise<void>;
  primaryUserBlock: ThreadRenderableBlock | null;
  projectRootPath?: string;
  relatedThreadsById: RelatedThreadsById;
  turnCompletedAt: number | null;
  turnStartedAt: number | null;
}) {
  if (block.kind === "commandSequence") {
    return <ThreadCommandSequence isMostRecent={isMostRecentBlock} items={block.items} knownSkills={knownSkills} projectRootPath={projectRootPath} />;
  }

  if (block.kind === "fileChangeSequence") {
    return <ThreadFileChangeItem items={block.items} projectRootPath={projectRootPath} />;
  }

  if (block.kind === "reasoningSequence") {
    return (
      <ThreadReasoningSequence
        block={block}
        inlineMentionSources={inlineMentionSources}
        isMostRecent={isMostRecentBlock}
        onOpenFile={onOpenFile}
        projectRootPath={projectRootPath}
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
          onOpenFile={onOpenFile}
          projectRootPath={projectRootPath}
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
          onOpenFile={onOpenFile}
          projectRootPath={projectRootPath}
        />
      );
    case "plan":
      return <ThreadPlanItem item={block.item} />;
    case "contextCompaction":
      return <ThreadContextCompactionItem item={block.item} />;
    case "mcpToolCall":
      return <ThreadMcpToolCallItem item={block.item} />;
    case "dynamicToolCall":
      return <ThreadDynamicToolCallItem item={block.item} />;
    case "webSearch":
      return <ThreadWebSearchItem item={block.item} />;
    case "collabAgentToolCall":
      return (
        <ThreadCollabAgentToolCallItem
          isMostRecent={isMostRecentBlock}
          inlineMentionSources={inlineMentionSources}
          item={block.item}
          knownSkills={knownSkills}
          onOpenFile={onOpenFile}
          projectRootPath={projectRootPath}
          relatedThreadsById={relatedThreadsById}
        />
      );
    default:
      return <ThreadFallbackItem item={block.item} />;
  }
}

function ThreadTurnDetailsComponent ({
  hiddenCollabAgentToolCallItemIds = [],
  hiddenReasoningItemId = null,
  hiddenWebSearchItemIds = [],
  inlineMentionSources = null,
  knownSkills = [],
  onOpenFile,
  projectRootPath,
  relatedThreadsById = {},
  turn,
}: {
  hiddenCollabAgentToolCallItemIds?: readonly string[];
  hiddenReasoningItemId?: string | null;
  hiddenWebSearchItemIds?: readonly string[];
  inlineMentionSources?: InlineMentionHighlightSources | null;
  knownSkills?: WorkbenchSkillSummary[];
  onOpenFile?: (path: string) => Promise<void>;
  projectRootPath?: string;
  relatedThreadsById?: RelatedThreadsById;
  turn: Turn;
}) {
  const hiddenCollabAgentToolCallIds = hiddenCollabAgentToolCallItemIds.length
    ? new Set(hiddenCollabAgentToolCallItemIds)
    : null;
  const hiddenWebSearchIds = hiddenWebSearchItemIds.length
    ? new Set(hiddenWebSearchItemIds)
    : null;
  const blocks = buildRenderableBlocks(turn.items, {
    collabAgentToolCallIds: hiddenCollabAgentToolCallIds,
    reasoningItemId: hiddenReasoningItemId,
    webSearchItemIds: hiddenWebSearchIds,
  });
  const finalAgentMessageId = getFinalAgentMessageId(turn);
  const isCompleted = turn.status === "completed";
  const primaryUserBlock = isCompleted
    ? blocks.find((block) => isUserMessageBlock(block)) ?? null
    : null;
  const finalAgentBlocks = isCompleted
    ? blocks.filter((block) => isFinalAgentMessageBlock(block, finalAgentMessageId))
    : [];
  const workedBlocks = isCompleted
    ? blocks.filter((block) => block !== primaryUserBlock && !isFinalAgentMessageBlock(block, finalAgentMessageId))
    : blocks;

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
      onOpenFile={onOpenFile}
      primaryUserBlock={primaryUserBlock}
      projectRootPath={projectRootPath}
      relatedThreadsById={relatedThreadsById}
      turnCompletedAt={turn.completedAt}
      turnStartedAt={turn.startedAt}
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
    && left.hiddenReasoningItemId === right.hiddenReasoningItemId
    && left.hiddenWebSearchItemIds === right.hiddenWebSearchItemIds
    && left.inlineMentionSources === right.inlineMentionSources
    && left.knownSkills === right.knownSkills
    && left.onOpenFile === right.onOpenFile
    && left.projectRootPath === right.projectRootPath
    && left.relatedThreadsById === right.relatedThreadsById;
}

export const ThreadTurnDetails = memo(ThreadTurnDetailsComponent, areThreadTurnDetailsPropsEqual);

export function ThreadThreadContent ({
  emptyMessage = "No subagent activity was captured yet.",
  hiddenCollabAgentToolCallItemIds = [],
  hiddenReasoningItemId = null,
  hiddenWebSearchItemIds = [],
  inlineMentionSources = null,
  knownSkills = [],
  onOpenFile,
  projectRootPath,
  relatedThreadsById = {},
  thread,
}: {
  emptyMessage?: string;
  hiddenCollabAgentToolCallItemIds?: readonly string[];
  hiddenReasoningItemId?: string | null;
  hiddenWebSearchItemIds?: readonly string[];
  inlineMentionSources?: InlineMentionHighlightSources | null;
  knownSkills?: WorkbenchSkillSummary[];
  onOpenFile?: (path: string) => Promise<void>;
  projectRootPath?: string;
  relatedThreadsById?: RelatedThreadsById;
  thread: ThreadPayload | null | undefined;
}) {
  if (!thread) {
    return (
      <p className="m-0 text-[0.92em] leading-[1.6] text-muted">
        Loading subagent thread...
      </p>
    );
  }

  if (!thread.turns.length) {
    return (
      <p className="m-0 text-[0.92em] leading-[1.6] text-muted">
        {emptyMessage}
      </p>
    );
  }

  return (
    <>
      {thread.turns.map((turn) => (
        <ThreadTurnDetails
          key={turn.id}
          hiddenCollabAgentToolCallItemIds={hiddenCollabAgentToolCallItemIds}
          hiddenReasoningItemId={hiddenReasoningItemId}
          hiddenWebSearchItemIds={hiddenWebSearchItemIds}
          inlineMentionSources={inlineMentionSources}
          knownSkills={knownSkills}
          onOpenFile={onOpenFile}
          projectRootPath={projectRootPath}
          relatedThreadsById={relatedThreadsById}
          turn={turn}
        />
      ))}
    </>
  );
}
