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
import { SquareArrowRightEnterIcon, SquareArrowRightExitIcon } from "../workbench-icons";
import GitArcIcon from "./GitArcIcon";
import ThreadAgentName from "./ThreadAgentName";
import ThreadCard from "./ThreadCard";
import { ThreadFileChangeTotals, type ThreadFileChangeListChange } from "./ThreadFileChangeItem";
import ThreadGitArcCardBody from "./ThreadGitArcCardBody";
import ThreadGitArcChangeTotals from "./ThreadGitArcChangeTotals";
import ThreadGitArcCollapsedSummary, { ThreadGitArcStatusCounts } from "./ThreadGitArcCollapsedSummary";
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

/** What the label happened to; a transfer names its subagent in that subagent's identity colour. */
function Subject({ card }: { card: GitArcCard }) {
  const transcript = useContext(TranscriptScopeContext);
  const target = card.transferTarget;
  return (
    <>
      {target ? (
        <ThreadAgentName
          subagent={transcript?.subagents.find(({ name }) => name.localeCompare(target, undefined, { sensitivity: "accent" }) === 0)}
          thread={{ agentNickname: target }}
        />
      ) : card.releasedCount !== null ? (
        <span className="shrink-0"><b className="font-semibold text-text">{card.releasedCount}</b> {card.releasedCount === 1 ? "claim" : "claims"}</span>
      ) : card.subject ? <span className="min-w-0 truncate font-medium text-text">{card.subject}</span> : null}
      {card.statusCounts ? <span className="ml-1.5 min-w-0"><ThreadGitArcStatusCounts counts={card.statusCounts} /></span> : null}
    </>
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
  // The trailing slot carries totals, then progress; never internal ids.
  const line = {
    defaultOpen: card.defaultOpen,
    icon: <LeadingIcon intent={commandIntent} />,
    iconLabel: card.iconLabel,
    label: card.label,
    meta: [
      card.stackedProposalCount !== null ? <span key="proposals">{card.stackedProposalCount} {card.stackedProposalCount === 1 ? "proposal" : "proposals"}</span> : null,
      editResult ? <ThreadFileChangeTotals additions={editResult.additions} deletions={editResult.deletions} key="totals" />
        : operationSummaryRows.length ? (
          <ThreadGitArcChangeTotals changes={operationSummaryRows.map(row => ({ path: row.change.path, ...(row.summaryTotals ?? row.diff ?? parseUnifiedDiff(row.change.diff)) }))} key="totals" />
        ) : null,
    ],
    progress: { durationMs, state: card.state, waited: durationPresentation === "waited" },
    subject: <Subject card={card} />,
  };
  const body = <ThreadGitArcCardBody card={card} editResult={editResult} operationDetails={operationDetails} statusIncomplete={statusIncomplete} statusOutput={statusOutput} />;
  if (card.style === "step") {
    return <div data-thread-git-arc-card={card.action}><ThreadStepRow {...line}>{body}</ThreadStepRow></div>;
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
      <ThreadCard {...line} preview={preview}>{body}</ThreadCard>
    </div>
  );
}
