/*
 * Exports:
 * - default ThreadWorkbenchCommandItem: route typed wb MCP operations through dedicated Workbench renderers.
 */
"use client";

import { useContext, type ReactNode } from "react";

import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { ThreadPayload, WorkbenchSubagentSummary } from "workbench-shared/types";
import { parseGitArcReceipt } from "workbench-shared/workbench/git/git-arc-receipts";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import type { WorkbenchThreadRecallOutputRecord } from "../../../workbench/thread/thread-recall-output";
import {
  parseGitCheckpointCompareOutput,
  parseGitCheckpointDiffArtifactId,
  parseGitCheckpointDiffOutput,
  parseGitCheckpointProposalId,
  type ThreadCommandExecutionOutcome,
  type WorkbenchCommandRoute,
} from "../../../workbench/thread/thread-command-matchers";
import { resolveWorkbenchSubagentCommandTargets } from "../../../workbench/thread/thread-subagents";
import ThreadCheckpointCommitItem from "./ThreadCheckpointCommitItem";
import ThreadCheckpointCompareItem from "./ThreadCheckpointCompareItem";
import ThreadCheckpointDiffItem from "./ThreadCheckpointDiffItem";
import ThreadContextCommandItem from "./ThreadContextCommandItem";
import ThreadGitArcIntersectionCard from "./ThreadGitArcIntersectionCard";
import ThreadGitArcItem from "./ThreadGitArcItem";
import ThreadGitArcPresentationContext from "./ThreadGitArcPresentationContext";
import ThreadMarkdown from "./ThreadMarkdown";
import ThreadStatusCommandItem from "./ThreadStatusCommandItem";
import ThreadSubagentCreateItem from "./ThreadSubagentCreateItem";
import ThreadSubagentMessageItem from "./ThreadSubagentMessageItem";
import ThreadSubagentTargetActionItem from "./ThreadSubagentTargetActionItem";
import ThreadSubagentWaitItem from "./ThreadSubagentWaitItem";
import ThreadTitleCommandItem from "./ThreadTitleCommandItem";
import { formatToolCallOutput } from "./format-thread-tool-call";

type McpToolCallItem = Extract<ThreadItem, { type: "mcpToolCall" }>;
type SpecializedRoute = Extract<WorkbenchCommandRoute, { kind: "specialized" }>;

function getMcpOutcome(item: McpToolCallItem): ThreadCommandExecutionOutcome {
  if (item.status === "inProgress") return "inProgress";
  return item.status === "failed" || Boolean(item.error) ? "failed" : "completed";
}

function getMcpOutput(item: McpToolCallItem) {
  return item.error?.message
    || formatToolCallOutput({
      content: item.result?.content,
      fallback: item.result?.structuredContent ?? item.result?._meta,
    })
    || "";
}

export default function ThreadWorkbenchCommandItem({
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
  workspaceRoots,
}: {
  inlineMentionSources?: Parameters<typeof ThreadMarkdown>[0]["inlineMentionSources"];
  item: McpToolCallItem;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  relatedThreadsById: Record<string, ThreadPayload | undefined>;
  renderRecallRecord: (record: WorkbenchThreadRecallOutputRecord, index: number) => ReactNode;
  renderSubagentActivity?: (thread: ThreadPayload | undefined) => ReactNode;
  route: SpecializedRoute;
  subagents: readonly WorkbenchSubagentSummary[];
  threadCwdPath?: string;
  threadId: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const outcome = getMcpOutcome(item);
  const output = getMcpOutput(item);
  const operation = route.operation;
  const gitArcPresentation = useContext(ThreadGitArcPresentationContext);

  if (operation.kind === "threadTitle") {
    return <ThreadTitleCommandItem failureText={output} outcome={outcome} title={operation.title} />;
  }
  if (operation.kind === "threadStatus" && (outcome === "completed" || outcome === "inProgress")) {
    return <ThreadStatusCommandItem outcome={outcome} status={operation.status} />;
  }
  if (operation.kind === "threadRecall" && threadCwdPath) {
    return (
      <ThreadContextCommandItem
        defaultOpen={item.status !== "completed"}
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
  if (operation.kind === "gitArcWait") {
    if (outcome !== "inProgress") {
      return (
        <ThreadGitArcItem
          commandIntent={{
            action: "start",
            intentName: null,
            paths: [],
            ref: operation.ref,
          }}
          durationMs={item.durationMs}
          durationPresentation="waited"
          failureReason={outcome === "failed" ? output : null}
          outcome={outcome}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          receipt={parseGitArcReceipt(output)}
          workspaceRoots={workspaceRoots}
        />
      );
    }
    if (
      outcome === "inProgress"
      && gitArcPresentation?.onOpenThread
      && gitArcPresentation.projectId
    ) {
      return (
        <ThreadGitArcIntersectionCard
          harness={gitArcPresentation.harness}
          mode="wait"
          onOpenThread={gitArcPresentation.onOpenThread}
          projectId={gitArcPresentation.projectId}
          threadId={threadId}
        />
      );
    }
    return null;
  }
  if (operation.kind === "gitArc") {
    const intent = operation.operation;
    const receipt = parseGitArcReceipt(output);
    const proposalId = parseGitCheckpointProposalId(output) ?? receipt?.proposalId ?? null;
    if (intent.action === "propose") {
      return (
        <ThreadCheckpointCommitItem
          commandOutcome={outcome}
          cwd={threadCwdPath ?? null}
          failureReason={outcome === "failed" ? output : null}
          intent={intent.proposalIntent ?? null}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          proposalId={proposalId}
          sourceItemId={item.id}
          threadId={threadId}
          workspaceRoots={workspaceRoots}
        />
      );
    }
    const compareChanges = intent.action === "compare" || intent.action === "start"
      ? parseGitCheckpointCompareOutput(output)
      : null;
    const diffChanges = intent.action === "diff" ? parseGitCheckpointDiffOutput(output) : null;
    const diffArtifactId = intent.action === "diff" ? parseGitCheckpointDiffArtifactId(output) : null;
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
        output={output}
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
        durationMs={item.durationMs}
        failureReason={outcome === "failed" ? output : null}
        operationDetails={operationDetails}
        outcome={outcome}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        receipt={receipt}
        statusOutput={intent.action === "status" ? output : undefined}
        workspaceRoots={workspaceRoots}
      />
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
      >
        <ThreadMarkdown
          inlineMentionSources={inlineMentionSources}
          markdown={subagentCommand.message}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          threadCwdPath={threadCwdPath}
          workspaceRoots={workspaceRoots}
        />
      </ThreadSubagentCreateItem>
    );
  }
  if (subagentCommand.action === "message" && subagentCommand.toParent && subagentCommand.message && outcome !== "failed") {
    return (
      <ThreadSubagentMessageItem fallbackName="parent">
        <ThreadMarkdown
          inlineMentionSources={inlineMentionSources}
          markdown={subagentCommand.message}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          threadCwdPath={threadCwdPath}
          workspaceRoots={workspaceRoots}
        />
      </ThreadSubagentMessageItem>
    );
  }
  if (subagentCommand.action === "message" && targets.length === 1 && subagentCommand.message && outcome !== "failed") {
    const target = targets[0]!;
    return (
      <ThreadSubagentMessageItem fallbackName={target.fallbackName} subagent={target.subagent} thread={target.threadId ? relatedThreadsById[target.threadId] : undefined}>
        <ThreadMarkdown
          inlineMentionSources={inlineMentionSources}
          markdown={subagentCommand.message}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          threadCwdPath={threadCwdPath}
          workspaceRoots={workspaceRoots}
        />
      </ThreadSubagentMessageItem>
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
    return (
      <ThreadSubagentWaitItem
        disclosureContent={outcome === "completed" && output.trim() ? (
          <ThreadMarkdown
            inlineMentionSources={inlineMentionSources}
            markdown={output.trim()}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            threadCwdPath={threadCwdPath}
            workspaceRoots={workspaceRoots}
          />
        ) : outcome === "failed" ? output : undefined}
        durationMs={item.durationMs}
        entries={targets.map((target) => ({
          content: renderSubagentActivity?.(target.threadId ? relatedThreadsById[target.threadId] : undefined),
          fallbackName: target.fallbackName,
          subagent: target.subagent,
          targetKey: target.targetKey,
          thread: target.threadId ? relatedThreadsById[target.threadId] : undefined,
        }))}
        outcome={outcome}
      />
    );
  }
  return null;
}
