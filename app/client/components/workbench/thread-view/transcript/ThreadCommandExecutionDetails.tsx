/*
 * Exports:
 * - default ThreadCommandExecutionDetails: one shell command through its dedicated renderer (feedback, todo, vis, git arc,
 *   subagent, message) or as a step row opening onto its output, Browse steps and checkpoint changes.
 */
"use client";

import { useContext, useMemo } from "react";

import { parseGitArcEditText } from "workbench-shared/workbench/git/git-arc-edit-contracts";
import {
  getGitArcMatcherAction,
  getThreadCommandDisplay,
  getThreadCommandExecutionOutcome,
  getThreadCommandOutcomeDisplay,
  isBrowseCommandMatcherClaim,
  isGitArcWaitMatcherClaim,
  isGitCheckpointCompareMatcherClaim,
  isGitCheckpointDiffMatcherClaim,
  parseGitArcCommand,
  parseGitArcReceipt,
  parseGitArcWaitRef,
  parseGitCheckpointCompareOutput,
  parseGitCheckpointDiffArtifactId,
  parseGitCheckpointDiffOutput,
  parseWorkbenchFeedbackCommand,
  parseWorkbenchFeedbackId,
  parseWorkbenchMessageCommand,
  parseWorkbenchSubagentCommand,
  parseWorkbenchTodoCommand,
  parseWorkbenchVisCommand,
} from "../../../../workbench/thread/thread-command-matchers";
import { useThreadItemApproval } from "../../../../workbench/thread/thread-item-approvals";
import {
  getShellQueueTiming, useThreadItemShellOutput, useThreadItemShellQueue,
} from "../../../../workbench/thread/thread-item-shell-queue";
import { resolveWorkbenchSubagentCommandTargets } from "../../../../workbench/thread/thread-subagents";
import MarkdownRender from "../../../ui/MarkdownRender";
import { TerminalIcon } from "../../workbench-icons";
import { useProject } from "../../use-projects";
import { useTranscript } from "../../use-transcript";
import ThreadAgentMessageBody from "../ThreadAgentMessageBody";
import ThreadSentAgentMessageItem from "../ThreadAgentMessageItem";
import ThreadBubbleCopyButton from "../ThreadBubbleCopyButton";
import ThreadCheckpointCompareItem from "../ThreadCheckpointCompareItem";
import ThreadCheckpointDiffItem from "../ThreadCheckpointDiffItem";
import ThreadCodeDisplay, { ThreadCommandHeader } from "../ThreadCodeDisplay";
import ThreadCommandDisplay from "../ThreadCommandDisplay";
import ThreadDurationText from "../ThreadDurationText";
import ThreadFeedbackCommandItem from "../ThreadFeedbackCommandItem";
import { createThreadGitArcCompareSummaryRows, createThreadGitArcDiffSummaryRows } from "../ThreadGitArcCollapsedSummary";
import ThreadGitArcItem from "../ThreadGitArcItem";
import ThreadGitArcProposalItem from "../ThreadGitArcProposalItem";
import ThreadGitArcWaitItem from "../ThreadGitArcWaitItem";
import ThreadStepRow from "../ThreadStepRow";
import ThreadSubagentCreateItem from "../ThreadSubagentCreateItem";
import ThreadSubagentTargetActionItem from "../ThreadSubagentTargetActionItem";
import ThreadSubagentWaitItem from "../ThreadSubagentWaitItem";
import ThreadSummaryText from "../ThreadSummaryText";
import ThreadTodoCommandItem from "../ThreadTodoCommandItem";
import ThreadVisCommandItem from "../ThreadVisCommandItem";
import { getBrowseItemSteps } from "../thread-browse-steps";
import { readThreadGitArcProposalTranscriptItem } from "../thread-git-arc-presentation";
import type { CommandItem } from "../thread-render-blocks";
import type { ThreadSubagentWaitTiming } from "../thread-subagent-wait-groups";
import { ThreadCommandSummary } from "../thread-view-primitives";
import { useThreadItemLiveDuration } from "../use-thread-live-duration";
import { ThreadShellStartNowAction, ThreadShellStopAction } from "./ThreadItemActionControls";
import { SubagentActivitySlot } from "./subagent-activity-slot";

type ThreadCommandDisplayValue = ReturnType<typeof getThreadCommandDisplay>;

const gitCheckpointPresentationByItem = new WeakMap<CommandItem, {
  artifactId: ReturnType<typeof parseGitCheckpointDiffArtifactId>;
  claimedBy: ThreadCommandDisplayValue["claimedBy"];
  compareChanges: ReturnType<typeof parseGitCheckpointCompareOutput> | null;
  diffChanges: ReturnType<typeof parseGitCheckpointDiffOutput> | null;
  output: string;
  summaryRows: ReturnType<typeof createThreadGitArcCompareSummaryRows>;
}>();

function readGitCheckpointPresentation(item: CommandItem, claimedBy: ThreadCommandDisplayValue["claimedBy"]) {
  const cached = gitCheckpointPresentationByItem.get(item);
  const output = item.aggregatedOutput ?? "";
  if (cached?.claimedBy === claimedBy && cached.output === output) return cached;
  const compareChanges = isGitCheckpointCompareMatcherClaim(claimedBy) ? parseGitCheckpointCompareOutput(output) : null;
  const diffChanges = isGitCheckpointDiffMatcherClaim(claimedBy) ? parseGitCheckpointDiffOutput(output) : null;
  const presentation = {
    artifactId: isGitCheckpointDiffMatcherClaim(claimedBy) ? parseGitCheckpointDiffArtifactId(output) : null,
    compareChanges,
    diffChanges,
    summaryRows: compareChanges?.length
      ? createThreadGitArcCompareSummaryRows(compareChanges)
      : diffChanges?.length ? createThreadGitArcDiffSummaryRows(diffChanges) : [],
    claimedBy,
    output,
  };
  gitCheckpointPresentationByItem.set(item, presentation);
  return presentation;
}

export default function ThreadCommandExecutionDetails ({
  activeStartedAtMs,
  item,
  subagentWaitTiming,
  unwrapSubagentCreate = false,
}: {
  activeStartedAtMs?: number | null;
  item: CommandItem;
  subagentWaitTiming?: ThreadSubagentWaitTiming;
  unwrapSubagentCreate?: boolean;
}) {
  const transcript = useTranscript();
  const turn = useTranscript.turn();
  const project = useProject.contextual();
  const SubagentActivity = useContext(SubagentActivitySlot);
  const commandInput = { command: item.command, commandActions: item.commandActions, cwd: item.cwd, shell: item.shell };
  const commandDisplay = project ? project.commandDisplay(commandInput) : getThreadCommandDisplay(commandInput);
  const commandOutcome = getThreadCommandExecutionOutcome(item.status, item.exitCode);
  const shellQueue = useThreadItemShellQueue(item.id);
  const liveShellQueue = item.status === "inProgress" ? shellQueue : null;
  // A running wb shell shows its newest output until its finished item brings all of it.
  const shellOutput = useThreadItemShellOutput(item.id);
  const shownOutput = item.aggregatedOutput || (item.status === "inProgress" ? shellOutput : null);
  const queueTiming = getShellQueueTiming({
    activeStartedAtMs, durationMs: item.durationMs, live: liveShellQueue, queuedMs: item.queuedMs,
  });
  const queuedDurationMs = useThreadItemLiveDuration(queueTiming.queued?.durationMs, queueTiming.queued?.activeStartedAtMs);
  const visibleDurationMs = useThreadItemLiveDuration(queueTiming.run?.durationMs, queueTiming.run?.activeStartedAtMs);
  const outcomeCommandDisplay = useMemo(() => {
    const display = commandDisplay.summaryParts.length || !item.resultExpiredAt ? commandDisplay : {
      ...commandDisplay,
      ongoingSummaryParts: [
        { text: "Running ", type: "text" as const },
        { clamp: true, text: commandDisplay.unwrappedCommand, type: "text" as const, variant: "code" as const },
      ],
      ongoingSummaryText: `Running ${commandDisplay.unwrappedCommand}`,
      summaryKind: "raw" as const,
      summaryParts: [{ clamp: true, text: commandDisplay.unwrappedCommand, type: "text" as const, variant: "code" as const }],
      summaryText: commandDisplay.unwrappedCommand,
    };
    return getThreadCommandOutcomeDisplay(display, commandOutcome);
  }, [commandDisplay, commandOutcome, item.resultExpiredAt]);
  const approval = useThreadItemApproval(item.id);
  const browseResultEntries = turn.browseResultEntries;
  const commandDetailRows = useMemo(
    () => getBrowseItemSteps(item, commandDisplay, browseResultEntries) ?? commandDisplay.detailRows ?? [],
    [browseResultEntries, commandDisplay, item],
  );
  if (item.resultExpiredAt) {
    return (
      <ThreadStepRow
        icon={<TerminalIcon size={16} />}
        meta={["Result expired after 1 day."]}
        summary={<ThreadCommandSummary approval={approval} display={outcomeCommandDisplay} expensive={Boolean(item.expensive)} line />}
      />
    );
  }
  const messageCommand = parseWorkbenchMessageCommand(commandDisplay.unwrappedCommand, item.commandActions);
  const subagentCommand = parseWorkbenchSubagentCommand(commandDisplay.unwrappedCommand, item.commandActions);
  const resolvedSubagentTargets = subagentCommand
    ? resolveWorkbenchSubagentCommandTargets(transcript.subagents, subagentCommand.targets, { live: item.status === "inProgress" })
    : [];
  const {
    artifactId: checkpointDiffArtifactId,
    compareChanges: checkpointCompareChanges,
    diffChanges: checkpointDiffChanges,
    summaryRows: checkpointSummaryRows,
  } = readGitCheckpointPresentation(item, commandDisplay.claimedBy);
  const gitArcProposal = readThreadGitArcProposalTranscriptItem(item, commandDisplay);
  const gitArcReceipt = gitArcProposal?.receipt ?? parseGitArcReceipt(item.aggregatedOutput ?? "");
  const gitArcAction = getGitArcMatcherAction(commandDisplay.claimedBy);
  const gitArcCommandIntent = gitArcAction
    ? parseGitArcCommand(commandDisplay.unwrappedCommand) ?? {
      action: gitArcAction,
      intentName: gitArcReceipt?.intentName ?? null,
      paths: gitArcReceipt?.selectedPaths ?? [],
      proposalId: gitArcReceipt?.proposalId ?? null,
      ref: gitArcReceipt?.ref ?? null,
    }
    : null;
  const isBrowseCommand = isBrowseCommandMatcherClaim(commandDisplay.claimedBy);
  const shouldRenderCheckpointDiff = checkpointDiffChanges !== null
    && (!item.aggregatedOutput?.trim() || Boolean(checkpointDiffArtifactId) || checkpointDiffChanges.length > 0);
  const shouldHideCommandOutput = commandDisplay.hideCommandOutput
    && (commandDetailRows.length > 0 || !item.aggregatedOutput?.trim());
  const failureOutput = commandOutcome === "failed" || commandOutcome === "declined" || commandOutcome === "timedOut"
    ? item.aggregatedOutput
    : null;
  const feedbackCommand = parseWorkbenchFeedbackCommand(commandDisplay.unwrappedCommand);
  if (feedbackCommand && (commandOutcome === "completed" || commandOutcome === "inProgress")) {
    return (
      <ThreadFeedbackCommandItem
        durationMs={visibleDurationMs ?? null}
        feedbackId={parseWorkbenchFeedbackId(item.aggregatedOutput ?? "")}
        operation={feedbackCommand}
        outcome={commandOutcome}
        projectId={project?.id ?? null}
        threadId={transcript.threadId}
      />
    );
  }
  const todoCommand = parseWorkbenchTodoCommand(commandDisplay.unwrappedCommand);
  if (todoCommand) {
    return (
      <ThreadTodoCommandItem
        durationMs={visibleDurationMs ?? null}
        operation={todoCommand}
        outcome={commandOutcome === "inProgress" ? "inProgress" : commandOutcome === "completed" ? "completed" : "failed"}
        output={item.aggregatedOutput ?? ""}
      />
    );
  }
  if (isGitArcWaitMatcherClaim(commandDisplay.claimedBy)) {
    return (
      <ThreadGitArcWaitItem
        durationMs={visibleDurationMs ?? null}
        failureReason={commandOutcome === "completed" || commandOutcome === "inProgress" ? null : item.aggregatedOutput}
        outcome={commandOutcome}
        planRef={parseGitArcWaitRef(commandDisplay.unwrappedCommand)}
        receipt={gitArcReceipt}
        threadId={transcript.threadId}
      />
    );
  }
  const visCommand = parseWorkbenchVisCommand(commandDisplay.unwrappedCommand);
  if (visCommand) {
    return (
      <ThreadVisCommandItem
        durationMs={visibleDurationMs ?? null}
        operation={visCommand}
        outcome={commandOutcome === "inProgress" ? "inProgress" : commandOutcome === "completed" ? "completed" : "failed"}
        output={item.aggregatedOutput ?? ""}
        threadId={transcript.threadId}
      />
    );
  }
  if (gitArcAction === "propose") {
    return (
      <ThreadGitArcProposalItem
        durationMs={visibleDurationMs ?? null}
        failureReason={failureOutput}
        intent={gitArcProposal?.intent ?? null}
        outcome={commandOutcome}
        proposalId={gitArcProposal?.proposalId ?? null}
        sourceItemId={item.id}
      />
    );
  }
  const checkpointDiff = shouldRenderCheckpointDiff ? (
    <ThreadCheckpointDiffItem
      cwd={item.cwd}
      output={item.aggregatedOutput ?? ""}
      sourceItemId={item.id}
      threadId={transcript.threadId}
    />
  ) : null;
  if (gitArcCommandIntent && gitArcCommandIntent.action !== "propose") {
    return (
      <ThreadGitArcItem
        commandIntent={gitArcCommandIntent}
        statusOutput={gitArcCommandIntent.action === "status" ? item.aggregatedOutput ?? "" : undefined}
        durationMs={visibleDurationMs ?? null}
        editResult={gitArcCommandIntent.action === "edit" ? parseGitArcEditText(item.aggregatedOutput ?? "") : null}
        failureReason={failureOutput}
        operationDetails={checkpointCompareChanges?.length
          ? <ThreadCheckpointCompareItem changes={checkpointCompareChanges} />
          : checkpointDiff}
        operationSummaryRows={checkpointSummaryRows}
        outcome={commandOutcome}
        receipt={gitArcReceipt}
      />
    );
  }
  if (subagentCommand?.action === "wait" && resolvedSubagentTargets.length) {
    return (
      <ThreadSubagentWaitItem
        activeStartedAtMs={subagentWaitTiming?.activeStartedAtMs}
        disclosureContent={commandOutcome === "completed"
          ? item.aggregatedOutput?.trim()
            ? <MarkdownRender cwd={item.cwd} markdown={item.aggregatedOutput.trim()} />
            : undefined
          : commandOutcome === "inProgress" ? undefined : (
            <ThreadCodeDisplay
              header={<ThreadCommandHeader command={item.command} surface="framed" />}
              output={item.aggregatedOutput?.trim() || undefined}
              preview
              variant="plain"
            />
          )}
        durationMs={subagentWaitTiming ? subagentWaitTiming.durationMs : visibleDurationMs}
        entries={resolvedSubagentTargets.map((target) => {
          const childThread = target.threadId ? transcript.relatedThreadsById[target.threadId] : undefined;
          return {
            content: target.threadId ? <SubagentActivity fallbackThread={childThread} subagent={target.subagent} /> : undefined,
            fallbackName: target.fallbackName,
            subagent: target.subagent,
            targetKey: target.targetKey,
            thread: childThread,
          };
        })}
        exitCode={item.exitCode}
        outcome={commandOutcome}
      />
    );
  }
  if (
    subagentCommand?.action === "create"
    && subagentCommand.message
    && subagentCommand.name
    && subagentCommand.profileId
    && subagentCommand.title
    && (item.status === "inProgress" || item.status === "completed")
    && (item.exitCode === null || item.exitCode === 0)
  ) {
    const createdThreadId = item.status === "completed" ? item.aggregatedOutput?.trim() || null : null;
    const createdTarget = resolveWorkbenchSubagentCommandTargets(transcript.subagents, [{
      kind: createdThreadId ? "id" : "name",
      value: createdThreadId ?? subagentCommand.name,
    }])[0] ?? null;
    return (
      <ThreadSubagentCreateItem
        active={item.status === "inProgress"}
        fallbackName={subagentCommand.name}
        profileId={subagentCommand.profileId}
        fallbackTitle={subagentCommand.title}
        subagent={createdTarget?.subagent}
        unwrapped={unwrapSubagentCreate}
      >
        <ThreadAgentMessageBody
          cwd={item.cwd}
          parts={[{ markdown: subagentCommand.message, userVisibleSimpleVersion: subagentCommand.userVisibleSimpleVersion }]}
        />
      </ThreadSubagentCreateItem>
    );
  }
  if (messageCommand && (item.status === "inProgress" || item.status === "completed") && (item.exitCode === null || item.exitCode === 0)) {
    const descriptor = messageCommand.target.kind === "parent" || !messageCommand.target.value
      ? null
      : { kind: messageCommand.target.kind === "name" ? "name" as const : "id" as const, value: messageCommand.target.value };
    const target = descriptor ? resolveWorkbenchSubagentCommandTargets(transcript.subagents, [descriptor])[0] ?? null : null;
    return (
      <ThreadSentAgentMessageItem
        fallbackName={messageCommand.target.kind === "parent" ? "parent" : target?.fallbackName ?? messageCommand.target.value}
        subagent={target?.subagent}
        target={messageCommand.target.kind === "parent"
          ? { relation: "parent", threadId: transcript.threadId }
          : target?.threadId ? { relation: "self", threadId: target.threadId } : null}
        thread={target?.threadId ? transcript.relatedThreadsById[target.threadId] : undefined}
      >
        <MarkdownRender cwd={item.cwd} markdown={messageCommand.message} />
      </ThreadSentAgentMessageItem>
    );
  }
  if (
    (subagentCommand?.action === "settle" || subagentCommand?.action === "stop")
    && resolvedSubagentTargets.length
    && (item.status === "inProgress" || item.status === "completed")
    && (item.exitCode === null || item.exitCode === 0)
  ) {
    return (
      <ThreadSubagentTargetActionItem
        action={subagentCommand.action}
        active={item.status === "inProgress"}
        entries={resolvedSubagentTargets.map((target) => ({
          fallbackName: target.fallbackName,
          subagent: target.subagent,
          targetKey: target.targetKey,
          thread: target.threadId ? transcript.relatedThreadsById[target.threadId] : undefined,
        }))}
      />
    );
  }

  const commandDisplayView = (
    <ThreadCommandDisplay
      approval={approval}
      browse={isBrowseCommand && (commandOutcome === "failed" || !commandDetailRows.length)}
      command={item.command}
      detailRows={commandDetailRows}
      display={commandDisplay}
      expensive={Boolean(item.expensive)}
      live={commandOutcome === "inProgress" && liveShellQueue?.admittedAt !== null}
      meta={[
        commandOutcome === "failed" && item.exitCode !== null && item.exitCode !== 0 ? <ThreadSummaryText text={`exit ${item.exitCode}`} /> : null,
        queuedDurationMs !== null && queuedDurationMs !== undefined
          ? <span>queued <ThreadDurationText className="inline" durationMs={queuedDurationMs} /></span>
          : null,
        visibleDurationMs !== null && visibleDurationMs !== undefined ? <ThreadDurationText durationMs={visibleDurationMs} /> : null,
      ]}
      output={shownOutput}
      summaryDisplay={outcomeCommandDisplay}
    >
      {isBrowseCommand || shouldHideCommandOutput ? undefined
        : checkpointCompareChanges && commandOutcome === "completed" ? <ThreadCheckpointCompareItem changes={checkpointCompareChanges} />
          : checkpointDiff ?? undefined}
    </ThreadCommandDisplay>
  );
  if (!item.workbenchShell || item.status !== "inProgress") return commandDisplayView;
  const actions = liveShellQueue?.admittedAt === null ? (
    <>
      <ThreadShellStartNowAction itemId={item.id} />
      <ThreadShellStopAction itemId={item.id} />
    </>
  ) : <ThreadShellStopAction itemId={item.id} />;
  return (
    <div className="group/thread-bubble relative">
      {commandDisplayView}
      <ThreadBubbleCopyButton actions={actions} markdown="" side="right" touchVisible />
    </div>
  );
}
