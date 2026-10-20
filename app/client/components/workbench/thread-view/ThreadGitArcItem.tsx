/*
 * Exports:
 * - default ThreadGitArcItem: one Git arc call (lifecycle, edit session, status or recovery) as a one-line card that opens
 *   into its flat body, previewing its result while closed where that matters; inside a run's command group, arc reads
 *   are steps instead.
 */
"use client";

import { useContext, type ReactNode } from "react";

import type { GitArcFailure } from "workbench-shared/workbench/git/git-arc-failures";
import type { GitArcEditResult } from "workbench-shared/workbench/git/git-arc-edit-contracts";
import type { GitArcReceipt } from "workbench-shared/workbench/git/git-arc-receipts";
import type { GitArcStatusPresentation } from "workbench-shared/workbench/git/git-arc-status";
import { parseUnifiedDiff } from "workbench-shared/workbench/thread/unified-diff";
import type { GitArcCommandIntent, ThreadCommandExecutionOutcome } from "../../../workbench/thread/thread-command-matchers";
import { TranscriptScopeContext } from "../use-transcript";
import { LoaderIcon, SquareArrowRightEnterIcon, SquareArrowRightExitIcon } from "../workbench-icons";
import GitArcIcon from "./GitArcIcon";
import ThreadAgentName from "./ThreadAgentName";
import ThreadCard from "./ThreadCard";
import ThreadDurationText from "./ThreadDurationText";
import { ThreadFileChangeTotals, type ThreadFileChangeListChange } from "./ThreadFileChangeItem";
import ThreadGitArcCardBody from "./ThreadGitArcCardBody";
import ThreadGitArcChangeTotals from "./ThreadGitArcChangeTotals";
import ThreadGitArcCollapsedSummary from "./ThreadGitArcCollapsedSummary";
import ThreadGitArcFailure from "./ThreadGitArcFailure";
import ThreadGitArcPresentationContext from "./ThreadGitArcPresentationContext";
import ThreadStepRow from "./ThreadStepRow";
import { buildGitArcCard, type GitArcCard } from "./thread-git-arc-card";
import { ThreadRowChromeContext } from "./thread-row-chrome";

/** Claim transfers with subagents show their direction; everything else shows its action. */
function LeadingIcon({ intent }: { intent: GitArcCommandIntent }) {
  if (intent.action === "release" && intent.toSubagent) return <SquareArrowRightEnterIcon size={16} />;
  if (intent.action === "adopt" && (intent.source?.name || intent.source?.threadId)) return <SquareArrowRightExitIcon className="-scale-x-100" size={16} />;
  return <GitArcIcon action={intent.action} size={16} />;
}

/** What happened and to what; a transfer names its subagent in that subagent's identity colour. */
function Line({ card }: { card: GitArcCard }) {
  const transcript = useContext(TranscriptScopeContext);
  const target = card.transferTarget;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className={`shrink-0 ${card.state === "failed" || card.state === "timedOut" ? "text-danger" : ""}`}>{card.label}</span>
      {target ? (
        <ThreadAgentName
          subagent={transcript?.subagents.find(({ name }) => name.localeCompare(target, undefined, { sensitivity: "accent" }) === 0)}
          thread={{ agentNickname: target }}
        />
      ) : card.subject ? <span className="min-w-0 truncate font-medium text-text">{card.subject}</span> : null}
    </span>
  );
}

export default function ThreadGitArcItem ({
  commandIntent,
  durationMs,
  durationPresentation = "default",
  editResult = null,
  failureReason = null,
  interruptedBySteer = false,
  name = null,
  operationDetails,
  outcome,
  operationSummaryRows = [],
  receipt,
  statusFacts,
  statusIncomplete = false,
  statusOutput,
  typedFailure = null,
}: {
  commandIntent: GitArcCommandIntent;
  durationMs: number | null;
  durationPresentation?: "default" | "waited";
  /** Parsed edit session output for `edit` commands. */
  editResult?: GitArcEditResult | null;
  failureReason?: string | null;
  interruptedBySteer?: boolean;
  /** Names the card's subject (a proposal title) instead of the arc intent. */
  name?: string | null;
  operationDetails?: ReactNode;
  outcome: ThreadCommandExecutionOutcome;
  operationSummaryRows?: readonly ThreadFileChangeListChange[];
  receipt: GitArcReceipt | null;
  statusFacts?: Partial<GitArcStatusPresentation> | null;
  statusIncomplete?: boolean;
  statusOutput?: string;
  typedFailure?: GitArcFailure | null;
}) {
  const presentation = useContext(ThreadGitArcPresentationContext);
  const asRunStep = useContext(ThreadRowChromeContext) === "step";
  const card = buildGitArcCard({
    asRunStep, currentPlan: presentation?.gitArcPlan ?? null, editResult, failureReason, intent: commandIntent, interruptedBySteer,
    name, outcome, receipt, statusFacts, statusOutput, typedFailure,
  });
  // The trailing slot carries totals and progress, never internal ids.
  const meta = [
    card.stackedProposalCount !== null ? <span key="proposals">{card.stackedProposalCount} {card.stackedProposalCount === 1 ? "proposal" : "proposals"}</span> : null,
    editResult ? <ThreadFileChangeTotals additions={editResult.additions} deletions={editResult.deletions} key="totals" />
      : operationSummaryRows.length ? (
        <ThreadGitArcChangeTotals changes={operationSummaryRows.map(row => ({ path: row.change.path, ...(row.summaryTotals ?? row.diff ?? parseUnifiedDiff(row.change.diff)) }))} key="totals" />
      ) : null,
    card.state === "inProgress" ? <LoaderIcon key="running" size={14} />
      : durationMs === null ? null
        : durationPresentation === "waited"
          ? <span data-thread-git-arc-duration="waited" key="duration">waited <ThreadDurationText className="inline" durationMs={durationMs} /></span>
          : <ThreadDurationText durationMs={durationMs} key="duration" />,
  ];
  const body = <ThreadGitArcCardBody card={card} editResult={editResult} operationDetails={operationDetails} statusIncomplete={statusIncomplete} statusOutput={statusOutput} />;
  const icon = <LeadingIcon intent={commandIntent} />;
  if (card.style === "step") {
    return (
      <div data-thread-git-arc-card={card.action}>
        <ThreadStepRow defaultOpen={card.defaultOpen} icon={icon} iconLabel={card.iconLabel} meta={meta} summary={<Line card={card} />}>{body}</ThreadStepRow>
      </div>
    );
  }
  // A preview keeps the result in view while closed; a failure there stays visible, like on any closed card that previews.
  const preview = card.style === "cardPreview" && (card.preview || card.failure) ? (
    <>
      {card.preview ? <ThreadGitArcCollapsedSummary content={card.preview} /> : null}
      {card.failure ? <ThreadGitArcFailure failure={card.failure} /> : null}
    </>
  ) : undefined;
  return (
    <div data-thread-git-arc-card={card.action}>
      <ThreadCard defaultOpen={card.defaultOpen} icon={icon} iconLabel={card.iconLabel} meta={meta} preview={preview} summary={<Line card={card} />}>
        {body}
      </ThreadCard>
    </div>
  );
}
