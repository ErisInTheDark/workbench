/*
 * Exports:
 * - default ThreadSubagentCoordination: a turn's subagent coordination as one conversation card: creates, messages each way,
 *   queue checks and waits, headed by every participant.
 * - ThreadSubagentWaitExchange: settled waits that ping-ponged with incoming messages: one wait row for every target, then one message group.
 * Keep runtime exports component-only for React Refresh.
 */
"use client";

import type { ReactNode } from "react";

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { WorkbenchThreadItemTimelineEntry } from "workbench-shared/workbench/thread/thread-item-timeline";
import { readWorkbenchAgentMessageItem } from "workbench-shared/workbench/thread/thread-agent-message";
import {
  getThreadCommandExecutionOutcome,
  getWorkbenchMcpCommandRoute,
  isThreadMcpWaitInterruptedBySteer,
} from "../../../../workbench/thread/thread-command-matchers";
import { resolveWorkbenchSubagentCommandTargets } from "../../../../workbench/thread/thread-subagents";
import MarkdownRender from "../../../ui/MarkdownRender";
import { useTranscript, type TranscriptScope } from "../../use-transcript";
import { ThreadAgentMessageBubble, ThreadAgentMessageClaimAction, ThreadAgentMessageTarget } from "../ThreadAgentMessageItem";
import ThreadAgentMessageBody from "../ThreadAgentMessageBody";
import ThreadAgentName from "../ThreadAgentName";
import ThreadIncomingAgentMessageGroup from "../ThreadIncomingAgentMessageGroup";
import ThreadSubagentCoordinationItem from "../ThreadSubagentCoordinationItem";
import ThreadSubagentWaitItem from "../ThreadSubagentWaitItem";
import ThreadWorkbenchCommandItem from "../ThreadWorkbenchCommandItem";
import { formatToolCallOutput } from "../format-thread-tool-call";
import type { SubagentWaitItem, ThreadRenderableBlock } from "../thread-render-blocks";
import {
  groupThreadSubagentCoordinationConversation,
  readThreadSubagentCoordinationClaimAction,
  readThreadSubagentCoordinationCreate,
  readThreadSubagentCoordinationTargetAction,
  readThreadSubagentCoordinationOutgoingMessage,
  readThreadSubagentCoordinationWait,
  type ThreadSubagentCoordinationTarget,
} from "../thread-subagent-coordination";
import { getThreadSubagentWaitTiming, type ThreadSubagentWaitRenderEntry } from "../thread-subagent-wait-groups";
import { ThreadIncomingAgentMessageRuns } from "./ThreadAgentMessageItems";
import ThreadCommandExecutionDetails from "./ThreadCommandExecutionDetails";
import { ThreadRegularCommandItem } from "./ThreadCommandSequence";
import { getActiveItemStartedAtMs } from "./transcript-blocks";

type Timeline = readonly WorkbenchThreadItemTimelineEntry[] | undefined;
type Subagents = TranscriptScope["subagents"];

/** Text a settled wait returned for the user; a wait an incoming message cut short returned agent guidance only. */
function getSubagentWaitResultText(item: SubagentWaitItem) {
  if (item.type === "commandExecution") {
    return getThreadCommandExecutionOutcome(item.status, item.exitCode) === "completed" ? item.aggregatedOutput?.trim() || null : null;
  }
  if (item.status !== "completed" || item.error || isThreadMcpWaitInterruptedBySteer(item)) return null;
  return formatToolCallOutput({ content: item.result?.content, fallback: item.result?.structuredContent ?? item.result?._meta })?.trim() || null;
}

export function ThreadSubagentWaitExchange ({
  block,
  itemTimeline,
}: {
  block: Extract<ThreadRenderableBlock, { kind: "subagentWaitExchange" }>;
  itemTimeline: Timeline;
}) {
  const transcript = useTranscript();
  const entries = block.waits.map((item) => ({ item, outcome: block.outcome, targetKeys: [] }));
  const timing = getThreadSubagentWaitTiming({ anchor: entries.at(-1)!, entries }, itemTimeline ?? []);
  const results = block.waits.flatMap((item) => {
    const text = getSubagentWaitResultText(item);
    return text ? [{ id: item.id, text }] : [];
  });
  return (
    <>
      <ThreadSubagentWaitItem
        disclosureContent={results.length ? (
          <div className="space-y-3">
            {results.map((result) => <MarkdownRender key={result.id} markdown={result.text} />)}
          </div>
        ) : undefined}
        durationMs={timing.durationMs}
        entries={resolveWorkbenchSubagentCommandTargets(transcript.subagents, block.targets).map((target) => ({
          fallbackName: target.fallbackName,
          subagent: target.subagent,
          targetKey: target.targetKey,
          thread: target.threadId ? transcript.relatedThreadsById[target.threadId] : undefined,
        }))}
        outcome={block.outcome}
      />
      {block.messages.length ? (
        <ThreadIncomingAgentMessageGroup items={block.messages} state="delivered" subagents={transcript.subagents}>
          <ThreadIncomingAgentMessageRuns itemTimeline={itemTimeline} items={block.messages} />
        </ThreadIncomingAgentMessageGroup>
      ) : null}
    </>
  );
}

function getCoordinationParticipants(items: readonly ThreadItem[], transcript: TranscriptScope) {
  const participants = new Map<string, { key: string; label: ReactNode }>();
  const add = ({ fallbackName, kind, value }: { fallbackName: string; kind: "id" | "name" | "parent"; value: string | null }) => {
    const resolved = kind === "parent" || !value
      ? null
      : resolveWorkbenchSubagentCommandTargets(transcript.subagents, [{ kind, value }])[0] ?? null;
    const key = resolved?.threadId ?? `${kind}:${value ?? ""}`;
    if (participants.has(key)) return;
    participants.set(key, {
      key,
      label: (
        <ThreadAgentName
          subagent={resolved?.subagent}
          thread={resolved?.threadId
            ? transcript.relatedThreadsById[resolved.threadId] ?? { agentNickname: resolved.fallbackName, agentRole: null }
            : { agentNickname: fallbackName, agentRole: null }}
        />
      ),
    });
  };

  for (const item of items) {
    const outgoing = readThreadSubagentCoordinationOutgoingMessage(item);
    if (outgoing) {
      add({
        fallbackName: outgoing.target.kind === "parent" ? "parent" : outgoing.target.value ?? "thread",
        kind: outgoing.target.kind === "thread" ? "id" : outgoing.target.kind,
        value: outgoing.target.value,
      });
      continue;
    }
    const claimAction = readThreadSubagentCoordinationClaimAction(item);
    if (claimAction) {
      add({ fallbackName: claimAction.target.value, kind: claimAction.target.kind, value: claimAction.target.value });
      continue;
    }
    const create = readThreadSubagentCoordinationCreate(item);
    if (create) {
      add({ fallbackName: create.name, kind: "name", value: create.name });
      continue;
    }
    const targeted = readThreadSubagentCoordinationWait(item) ?? readThreadSubagentCoordinationTargetAction(item);
    if (targeted) {
      for (const target of targeted.targets) add({ fallbackName: target.value, kind: target.kind, value: target.value });
      continue;
    }
    const incoming = readWorkbenchAgentMessageItem(item);
    if (incoming) add({ fallbackName: incoming.senderName, kind: "id", value: incoming.senderThreadId });
  }
  return [...participants.values()];
}

function resolveCoordinationTarget(target: ThreadSubagentCoordinationTarget, subagents: Subagents) {
  if (target.kind === "parent" || !target.value) return null;
  return resolveWorkbenchSubagentCommandTargets(subagents, [{ kind: target.kind, value: target.value }])[0] ?? null;
}

function ThreadCoordinationOutgoingChannel({
  items,
  target,
}: {
  items: readonly ThreadItem[];
  target: ThreadSubagentCoordinationTarget;
}) {
  const transcript = useTranscript();
  const resolved = resolveCoordinationTarget(target, transcript.subagents);
  const recipient = (
    <ThreadAgentMessageTarget
      fallbackName={target.kind === "parent" ? "parent" : resolved?.fallbackName ?? target.value}
      subagent={resolved?.subagent}
      target={target.kind === "parent"
        ? { relation: "parent", threadId: transcript.threadId }
        : resolved?.threadId ? { relation: "self", threadId: resolved.threadId } : null}
      thread={resolved?.threadId ? transcript.relatedThreadsById[resolved.threadId] : undefined}
    />
  );
  return (
    <ThreadAgentMessageBubble recipient={recipient}>
      {items.map((item) => {
        const outgoing = readThreadSubagentCoordinationOutgoingMessage(item);
        if (outgoing) {
          return (
            <ThreadAgentMessageBody
              cwd={item.type === "commandExecution" ? item.cwd : undefined}
              key={item.id}
              parts={[{ markdown: outgoing.message, userVisibleSimpleVersion: outgoing.userVisibleSimpleVersion }]}
            />
          );
        }
        const claimAction = readThreadSubagentCoordinationClaimAction(item);
        return claimAction ? (
          <ThreadAgentMessageClaimAction
            action={claimAction.action}
            key={item.id}
            paths={claimAction.paths}
          />
        ) : null;
      })}
    </ThreadAgentMessageBubble>
  );
}

function ThreadCoordinationCreate({
  activeStartedAtMs,
  item,
}: {
  activeStartedAtMs: number | null;
  item: Extract<ThreadItem, { type: "commandExecution" | "mcpToolCall" }>;
}) {
  const transcript = useTranscript();
  if (item.type === "commandExecution") {
    return <ThreadCommandExecutionDetails activeStartedAtMs={activeStartedAtMs} item={item} unwrapSubagentCreate />;
  }
  const route = getWorkbenchMcpCommandRoute({ argumentsValue: item.arguments, server: item.server, tool: item.tool });
  if (route?.kind !== "specialized") return null;
  return (
    <ThreadWorkbenchCommandItem
      activeStartedAtMs={activeStartedAtMs}
      item={item}
      relatedThreadsById={transcript.relatedThreadsById}
      renderRecallRecord={() => null}
      route={route}
      subagents={transcript.subagents}
      threadId={transcript.threadId}
      unwrapSubagentCreate
    />
  );
}

export default function ThreadSubagentCoordination({
  block,
  itemTimeline,
}: {
  block: Extract<ThreadRenderableBlock, { kind: "subagentCoordination" }>;
  itemTimeline: Timeline;
}) {
  const transcript = useTranscript();
  const waits = block.items.flatMap(item => {
    const wait = readThreadSubagentCoordinationWait(item);
    return wait ? [{
      item: wait.item,
      outcome: wait.outcome,
      targetKeys: wait.targetKeys,
    } satisfies ThreadSubagentWaitRenderEntry<SubagentWaitItem>] : [];
  });
  const waitGroup = waits.length ? { anchor: waits.at(-1)!, entries: waits } : null;
  const timing = waitGroup ? getThreadSubagentWaitTiming(waitGroup, itemTimeline ?? []) : null;
  const conversation = groupThreadSubagentCoordinationConversation(
    block.items,
    (target) => resolveCoordinationTarget(target, transcript.subagents)?.threadId ?? `${target.kind}:${target.value ?? ""}`,
  );
  return (
    <ThreadSubagentCoordinationItem
      active={waitGroup?.anchor.outcome === "inProgress"}
      activeStartedAtMs={timing?.activeStartedAtMs}
      durationMs={timing?.durationMs}
      participants={getCoordinationParticipants(block.items, transcript)}
    >
      {conversation.map((run) => {
        if (run.kind === "incoming") {
          return <ThreadIncomingAgentMessageRuns itemTimeline={itemTimeline} items={run.items} key={run.items[0]!.id} />;
        }
        if (run.kind === "create") {
          return (
            <ThreadCoordinationCreate
              activeStartedAtMs={getActiveItemStartedAtMs(run.items[0], itemTimeline)}
              item={run.items[0]}
              key={run.items[0].id}
            />
          );
        }
        if (run.kind === "queueCheck" || run.kind === "targetAction") {
          return <ThreadRegularCommandItem item={run.items[0]} itemTimeline={itemTimeline} key={run.items[0].id} />;
        }
        return <ThreadCoordinationOutgoingChannel items={run.items} key={run.items[0]!.id} target={run.target} />;
      })}
    </ThreadSubagentCoordinationItem>
  );
}
