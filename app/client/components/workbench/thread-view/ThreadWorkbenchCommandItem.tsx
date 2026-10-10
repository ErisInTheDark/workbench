/*
 * Exports:
 * - default ThreadWorkbenchCommandItem: route typed wb MCP operations through dedicated Workbench renderers.
 */
"use client";

import { useMemo, type ReactNode } from "react";

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { readGitArcMcpResult } from "workbench-shared/workbench/git/git-arc-mcp-result";
import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";
import type { WorkbenchSubagentSummary } from "workbench-shared/types";
import type { RelatedThread } from "../../../workbench/thread/ThreadStore";
import { parseGitArcReceipt } from "workbench-shared/workbench/git/git-arc-receipts";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import type { WorkbenchThreadRecallOutputRecord } from "../../../workbench/thread/thread-recall-output";
import {
  parseGitCheckpointCompareOutput,
  parseGitCheckpointDiffArtifactId,
  parseGitCheckpointDiffOutput,
  parseGitCheckpointProposalId,
  parseWorkbenchFeedbackId,
  getThreadMcpToolCallOutcome,
  getThreadSubagentWaitMcpOutcome,
  type WorkbenchCommandRoute,
} from "../../../workbench/thread/thread-command-matchers";
import { resolveWorkbenchSubagentCommandTargets } from "../../../workbench/thread/thread-subagents";
import ThreadGitArcProposalItem from "./ThreadGitArcProposalItem";
import ThreadCheckpointCompareItem from "./ThreadCheckpointCompareItem";
import ThreadCheckpointDiffItem from "./ThreadCheckpointDiffItem";
import ThreadContextCommandItem from "./ThreadContextCommandItem";
import ThreadFeedbackCommandItem from "./ThreadFeedbackCommandItem";
import {
  createThreadGitArcCompareSummaryRows,
  createThreadGitArcDiffSummaryRows,
} from "./ThreadGitArcCollapsedSummary";
import ThreadGitArcItem from "./ThreadGitArcItem";
import ThreadGitArcWaitItem from "./ThreadGitArcWaitItem";
import ThreadAgentMessageBody from "./ThreadAgentMessageBody";
import ThreadAgentMessageItem from "./ThreadAgentMessageItem";
import MarkdownRender from "../../ui/MarkdownRender";
import ThreadStatusCommandItem from "./ThreadStatusCommandItem";
import ThreadSubagentCreateItem from "./ThreadSubagentCreateItem";
import ThreadSubagentTargetActionItem from "./ThreadSubagentTargetActionItem";
import ThreadSubagentWaitItem from "./ThreadSubagentWaitItem";
import ThreadTitleCommandItem from "./ThreadTitleCommandItem";
import ThreadTodoCommandItem from "./ThreadTodoCommandItem";
import ThreadVisCommandItem from "./ThreadVisCommandItem";
import { formatToolCallOutput } from "./format-thread-tool-call";
import { useThreadItemLiveDuration } from "./use-thread-live-duration";

type McpToolCallItem = Extract<ThreadItem, { type: "mcpToolCall" }>;
type SpecializedRoute = Extract<WorkbenchCommandRoute, { kind: "specialized" }>;

function getMcpOutput(item: McpToolCallItem) {
  return item.error?.message
    || formatToolCallOutput({
      content: item.result?.content,
      fallback: item.result?.structuredContent ?? item.result?._meta,
    })
    || "";
}

export default function ThreadWorkbenchCommandItem({
  activeStartedAtMs,
  inlineMentionSources,
  item,
  projectFilePaths,
  projectId,
  projectRootPath,
  relatedThreadsById,
  renderRecallRecord,
  renderSubagentActivity,
  route,
  subagents,
  threadCwdPath,
  threadId,
  unwrapSubagentCreate = false,
  workspaceRoots,
}: {
  activeStartedAtMs?: number | null;
  inlineMentionSources?: Parameters<typeof MarkdownRender>[0]["inlineMentionSources"];
  item: McpToolCallItem;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  relatedThreadsById: Record<string, RelatedThread | undefined>;
  renderRecallRecord: (record: WorkbenchThreadRecallOutputRecord, index: number) => ReactNode;
  renderSubagentActivity?: (target: { subagent: WorkbenchSubagentSummary | null | undefined; thread: RelatedThread | undefined }) => ReactNode;
  route: SpecializedRoute;
  subagents: readonly WorkbenchSubagentSummary[];
  threadCwdPath?: string;
  threadId: string;
  unwrapSubagentCreate?: boolean;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const outcome = getThreadMcpToolCallOutcome(item);
  const output = getMcpOutput(item);
  const operation = route.operation;
  const delegatesLiveDuration = operation.kind === "threadRecall"
    || operation.kind === "subagent" && operation.operation.action === "wait";
  const visibleDurationMs = useThreadItemLiveDuration(
    item.durationMs,
    delegatesLiveDuration ? null : activeStartedAtMs,
  );
  const typed = useMemo(() => {
    const result = operation.kind === "gitArc" || operation.kind === "gitArcWait"
      || operation.kind === "subagent" && operation.operation.action === "wait"
      ? readGitArcMcpResult(item.result?.structuredContent ?? null)
      : null;
    if (result?.error) reportClientSchemaError("Rejected Workbench MCP result", result.error);
    return result;
  }, [item.result?.structuredContent, operation]);
  const structured = typed?.kind === "valid" ? typed.result : null;
  const hasStructuredResult = item.result?.structuredContent !== null && item.result?.structuredContent !== undefined;
  const interruptedBySteer = structured?.kind === "interruptedBySteer";
  const gitArcOutcome = structured?.kind === "failure" || interruptedBySteer || typed?.kind === "invalid" ? "failed" : outcome;

  if (operation.kind === "feedback" && (outcome === "completed" || outcome === "inProgress")) {
    return (
      <ThreadFeedbackCommandItem
        durationMs={visibleDurationMs ?? null}
        feedbackId={parseWorkbenchFeedbackId(output)}
        operation={operation.operation}
        outcome={outcome}
        projectId={projectId}
        threadId={threadId}
      />
    );
  }
  if (operation.kind === "vis") {
    return (
      <ThreadVisCommandItem
        durationMs={visibleDurationMs ?? null}
        operation={operation.operation}
        outcome={outcome === "inProgress" ? "inProgress" : outcome === "completed" ? "completed" : "failed"}
        output={output}
        threadId={threadId}
      />
    );
  }
  if (operation.kind === "threadTitle") {
    return <ThreadTitleCommandItem failureText={output} outcome={outcome} title={operation.title} />;
  }
  if (operation.kind === "threadStatus" && (outcome === "completed" || outcome === "inProgress")) {
    return <ThreadStatusCommandItem outcome={outcome} status={operation.status} />;
  }
  if (operation.kind === "threadRecall" && threadCwdPath) {
    return (
      <ThreadContextCommandItem
        activeStartedAtMs={activeStartedAtMs}
        operation={operation.operation}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        renderRecord={renderRecallRecord}
        source={{ cwd: threadCwdPath, durationMs: item.durationMs, exitCode: null, id: item.id, outcome, output }}
        threadCwdPath={threadCwdPath}
        workspaceRoots={workspaceRoots}
      />
    );
  }
  if (operation.kind === "todo") {
    return (
      <ThreadTodoCommandItem
        durationMs={visibleDurationMs ?? null}
        operation={operation.operation}
        outcome={outcome === "inProgress" ? "inProgress" : outcome === "completed" ? "completed" : "failed"}
        output={output}
      />
    );
  }
  if (operation.kind === "gitArcWait") {
    return (
      <ThreadGitArcWaitItem
        durationMs={visibleDurationMs ?? null}
        failureReason={hasStructuredResult ? typed?.kind === "invalid" ? "The tool result could not be read." : null : outcome === "failed" ? output : null}
        interruptedBySteer={interruptedBySteer}
        outcome={gitArcOutcome}
        planRef={operation.ref}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        receipt={structured?.kind === "success" ? structured.receipt : hasStructuredResult ? null : parseGitArcReceipt(output)}
        threadId={threadId}
        typedFailure={structured?.kind === "failure" ? structured.failure : null}
        workspaceRoots={workspaceRoots}
      />
    );
  }
  if (operation.kind === "gitArc") {
    const intent = operation.operation;
    const receipt = structured?.kind === "success" ? structured.receipt : hasStructuredResult ? null : parseGitArcReceipt(output);
    const proposalId = receipt?.proposalId ?? (!hasStructuredResult ? parseGitCheckpointProposalId(output) : null);
    if (intent.action === "propose") {
      return (
        <ThreadGitArcProposalItem
          durationMs={visibleDurationMs ?? null}
          failureReason={hasStructuredResult ? typed?.kind === "invalid" ? "The tool result could not be read." : null : outcome === "failed" ? output : null}
          interruptedBySteer={interruptedBySteer}
          intent={intent.proposalIntent ?? null}
          outcome={gitArcOutcome}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          proposalId={proposalId}
          sourceItemId={item.id}
          typedFailure={structured?.kind === "failure" ? structured.failure : null}
          workspaceRoots={workspaceRoots}
        />
      );
    }
    const compareChanges = intent.action === "compare" || intent.action === "start"
      ? structured?.kind === "success"
        ? structured.changes?.map((change) => ({
          additions: change.additions, deletions: change.deletions, path: change.path,
          status: change.kind.type === "add" ? "A" as const : change.kind.type === "delete" ? "D" as const : "U" as const,
        })) ?? []
        : hasStructuredResult ? [] : parseGitCheckpointCompareOutput(output)
      : null;
    const diffOutput = structured?.kind === "success" ? structured.diff ?? "" : output;
    const diffChanges = intent.action === "diff"
      ? hasStructuredResult && structured?.kind !== "success" ? [] : parseGitCheckpointDiffOutput(diffOutput)
      : null;
    const diffArtifactId = intent.action === "diff" && !hasStructuredResult ? parseGitCheckpointDiffArtifactId(output) : null;
    const operationDetails = compareChanges?.length ? (
      <ThreadCheckpointCompareItem
        changes={compareChanges}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        workspaceRoots={workspaceRoots}
      />
    ) : threadCwdPath && diffChanges && (diffChanges.length || diffArtifactId) ? (
      <ThreadCheckpointDiffItem
        cwd={threadCwdPath}
        output={diffOutput}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        sourceItemId={item.id}
        threadId={threadId}
        workspaceRoots={workspaceRoots}
      />
    ) : null;
    return (
      <ThreadGitArcItem
        commandIntent={intent}
        durationMs={visibleDurationMs ?? null}
        failureReason={hasStructuredResult ? typed?.kind === "invalid" ? "The tool result could not be read." : null : outcome === "failed" ? output : null}
        interruptedBySteer={interruptedBySteer}
        operationDetails={operationDetails}
        operationSummaryRows={compareChanges?.length
          ? createThreadGitArcCompareSummaryRows(compareChanges)
          : diffChanges?.length ? createThreadGitArcDiffSummaryRows(diffChanges) : []}
        outcome={gitArcOutcome}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        receipt={receipt}
        statusFacts={structured?.kind === "success" ? structured.status : undefined}
        statusIncomplete={Boolean(typed?.error)}
        statusOutput={intent.action === "status" ? output : undefined}
        typedFailure={structured?.kind === "failure" ? structured.failure : null}
        workspaceRoots={workspaceRoots}
      />
    );
  }
  if (operation.kind === "message") {
    const messageCommand = operation.operation;
    if (!messageCommand.message || outcome === "failed") return null;
    const target = messageCommand.target;
    const resolved = target.kind === "parent" || !target.value
      ? null
      : resolveWorkbenchSubagentCommandTargets(subagents, [{
        kind: target.kind === "name" ? "name" : "id",
        value: target.value,
      }])[0] ?? null;
    return (
      <ThreadAgentMessageItem
        fallbackName={target.kind === "parent" ? "parent" : resolved?.fallbackName ?? target.value}
        subagent={resolved?.subagent}
        target={target.kind === "parent"
          ? { relation: "parent", threadId }
          : resolved?.threadId ? { relation: "self", threadId: resolved.threadId } : null}
        thread={resolved?.threadId ? relatedThreadsById[resolved.threadId] : undefined}
      >
        <ThreadAgentMessageBody
          inlineMentionSources={inlineMentionSources}
          parts={[{ markdown: messageCommand.message, userVisibleSimpleVersion: messageCommand.userVisibleSimpleVersion }]}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          threadCwdPath={threadCwdPath}
          workspaceRoots={workspaceRoots}
        />
      </ThreadAgentMessageItem>
    );
  }
  if (operation.kind !== "subagent") return null;
  const subagentCommand = operation.operation;
  const targets = resolveWorkbenchSubagentCommandTargets(subagents, subagentCommand.targets);
  if (
    subagentCommand.action === "create"
    && subagentCommand.message
    && subagentCommand.name
    && subagentCommand.profileId
    && subagentCommand.title
    && outcome !== "failed"
  ) {
    const createdThreadId = outcome === "completed" ? output.trim() || null : null;
    const createdTarget = resolveWorkbenchSubagentCommandTargets(subagents, [{
      kind: createdThreadId ? "id" : "name",
      value: createdThreadId ?? subagentCommand.name,
    }])[0] ?? null;
    return (
      <ThreadSubagentCreateItem
        active={outcome === "inProgress"}
        fallbackName={subagentCommand.name}
        fallbackTitle={subagentCommand.title}
        profileId={subagentCommand.profileId}
        subagent={createdTarget?.subagent}
        unwrapped={unwrapSubagentCreate}
      >
        <ThreadAgentMessageBody
          inlineMentionSources={inlineMentionSources}
          parts={[{
            markdown: subagentCommand.message,
            userVisibleSimpleVersion: subagentCommand.userVisibleSimpleVersion,
          }]}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          threadCwdPath={threadCwdPath}
          workspaceRoots={workspaceRoots}
        />
      </ThreadSubagentCreateItem>
    );
  }
  if ((subagentCommand.action === "settle" || subagentCommand.action === "stop") && targets.length && outcome !== "failed") {
    return (
      <ThreadSubagentTargetActionItem
        action={subagentCommand.action}
        active={outcome === "inProgress"}
        entries={targets.map((target) => ({
          fallbackName: target.fallbackName,
          subagent: target.subagent,
          targetKey: target.targetKey,
          thread: target.threadId ? relatedThreadsById[target.threadId] : undefined,
        }))}
      />
    );
  }
  if (subagentCommand.action === "wait" && targets.length) {
    // An incoming message ends the wait normally; its result text is guidance for the agent, not the user.
    const waitOutcome = getThreadSubagentWaitMcpOutcome(item);
    return (
      <ThreadSubagentWaitItem
        disclosureContent={interruptedBySteer ? undefined : outcome === "completed" && output.trim() ? (
          <MarkdownRender
            inlineMentionSources={inlineMentionSources}
            markdown={output.trim()}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            threadCwdPath={threadCwdPath}
            workspaceRoots={workspaceRoots}
          />
        ) : outcome === "failed" ? output : undefined}
        activeStartedAtMs={activeStartedAtMs}
        durationMs={activeStartedAtMs === null || activeStartedAtMs === undefined ? visibleDurationMs : 0}
        entries={targets.map((target) => ({
          content: renderSubagentActivity?.({
            subagent: target.subagent,
            thread: target.threadId ? relatedThreadsById[target.threadId] : undefined,
          }),
          fallbackName: target.fallbackName,
          subagent: target.subagent,
          targetKey: target.targetKey,
          thread: target.threadId ? relatedThreadsById[target.threadId] : undefined,
        }))}
        outcome={waitOutcome}
      />
    );
  }
  return null;
}
