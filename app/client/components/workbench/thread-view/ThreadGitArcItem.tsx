/*
 * Exports:
 * - default ThreadGitArcItem: render shared Git arc lifecycle, edit session, status and recovery cards.
 */
"use client";

import { useContext, useState, type MouseEvent, type ReactNode } from "react";

import {
  createGitArcOperationRejected,
  parseGitArcFailureReceipt,
  type GitArcFailure,
  type GitArcFailureAction,
} from "workbench-shared/workbench/git/git-arc-failures";
import type { GitArcEditResult } from "workbench-shared/workbench/git/git-arc-edit-contracts";
import type { GitArcReceipt } from "workbench-shared/workbench/git/git-arc-receipts";
import type { GitArcStatusPresentation } from "workbench-shared/workbench/git/git-arc-status";
import { parseUnifiedDiff } from "workbench-shared/workbench/thread/unified-diff";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import type { GitArcCommandAction, GitArcCommandIntent, ThreadCommandExecutionOutcome } from "../../../workbench/thread/thread-command-matchers";
import type { GitArcEditStep } from "../../../workbench/thread/command-matchers/workbench-command-rendering";
import { SquareArrowRightEnterIcon, SquareArrowRightExitIcon } from "../workbench-icons";
import GitArcIcon from "./GitArcIcon";
import ThreadClaimedFileList, { type ThreadClaimMarker } from "./ThreadClaimedFileList";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadDurationText from "./ThreadDurationText";
import ThreadGitArcCollapsedSummary, {
  createThreadGitArcEditSummaryRows,
  type ThreadGitArcCollapsedSummaryContent,
} from "./ThreadGitArcCollapsedSummary";
import { ThreadFileChangeTotals, type ThreadFileChangeListChange } from "./ThreadFileChangeItem";
import ThreadGitArcFailure from "./ThreadGitArcFailure";
import ThreadGitArcChangeTotals from "./ThreadGitArcChangeTotals";
import ThreadGitArcEditDetails from "./ThreadGitArcEditDetails";
import ThreadGitArcPresentationContext from "./ThreadGitArcPresentationContext";
import ThreadGitArcStatusDetails from "./ThreadGitArcStatusDetails";
import { ThreadReadonlyCommitCard } from "./ThreadCheckpointCommitCard";

const ACTION_LABELS = {
  adopt: { completed: "Adopted claims", failed: "Failed to adopt claims", inProgress: "Adopting claims", timedOut: "Timed out adopting claims" },
  claims: { completed: "Updated claims", failed: "Failed to update claims", inProgress: "Updating claims", timedOut: "Timed out updating claims" },
  scope: { completed: "Read scope", failed: "Failed to read scope", inProgress: "Reading scope", timedOut: "Timed out reading scope" },
  status: { completed: "Read status", failed: "Failed to read status", inProgress: "Reading status", timedOut: "Timed out reading status" },
  compare: { completed: "Compared", failed: "Failed to compare", inProgress: "Comparing", timedOut: "Timed out comparing" },
  continue: { completed: "Continued", failed: "Failed to continue", inProgress: "Continuing", timedOut: "Timed out continuing" },
  diff: { completed: "Diffed", failed: "Failed to diff", inProgress: "Diffing", timedOut: "Timed out diffing" },
  edit: { completed: "Edited", failed: "Failed to edit", inProgress: "Editing", timedOut: "Timed out editing" },
  plan: { completed: "Planned", failed: "Failed to plan", inProgress: "Planning", timedOut: "Timed out planning" },
  planStart: { completed: "Started", failed: "Failed to create and start", inProgress: "Creating and starting", timedOut: "Timed out creating and starting" },
  propose: { completed: "Proposed", failed: "Failed to propose", inProgress: "Proposing", timedOut: "Timed out proposing" },
  release: { completed: "Released", failed: "Failed to release", inProgress: "Releasing", timedOut: "Timed out releasing" },
  rescind: { completed: "Rescinded", failed: "Failed to rescind", inProgress: "Rescinding", timedOut: "Timed out rescinding" },
  restore: { completed: "Restored", failed: "Failed to restore", inProgress: "Restoring", timedOut: "Timed out restoring" },
  stack: { completed: "Stacked", failed: "Failed to stack", inProgress: "Stacking", timedOut: "Timed out stacking" },
  start: { completed: "Started", failed: "Failed to start", inProgress: "Starting", timedOut: "Timed out starting" },
  stash: { completed: "Stashed", failed: "Failed to stash", inProgress: "Stashing", timedOut: "Timed out stashing" },
  unstack: { completed: "Unstacked", failed: "Failed to unstack", inProgress: "Unstacking", timedOut: "Timed out unstacking" },
  unstash: { completed: "Unstashed", failed: "Failed to unstash", inProgress: "Unstashing", timedOut: "Timed out unstashing" },
  unknown: { completed: "Ran unrecognised action on", failed: "Failed to run action on", inProgress: "Running action on", timedOut: "Timed out running action on" },
} as const;

function actionState (outcome: ThreadCommandExecutionOutcome) {
  return outcome === "completed" ? "completed" : outcome === "inProgress" ? "inProgress" : outcome === "timedOut" ? "timedOut" : "failed";
}

const EDIT_STEP_LABELS: Record<GitArcEditStep, Record<keyof typeof ACTION_LABELS["edit"], string>> = {
  apply: { completed: "Applied edit", failed: "Failed to apply edit", inProgress: "Applying edit", timedOut: "Timed out applying edit" },
  end: { completed: "Ended edit", failed: "Failed to end edit", inProgress: "Ending edit", timedOut: "Timed out ending edit" },
  revert: { completed: "Reverted edit", failed: "Failed to revert edit", inProgress: "Reverting edit", timedOut: "Timed out reverting edit" },
  start: { completed: "Previewed edit", failed: "Failed to preview edit", inProgress: "Previewing edit", timedOut: "Timed out previewing edit" },
  view: { completed: "Viewed edit", failed: "Failed to view edit", inProgress: "Viewing edit", timedOut: "Timed out viewing edit" },
};

const EDIT_STEP_FAILURE_ACTIONS: Record<GitArcEditStep, GitArcFailureAction> = {
  apply: "arcEditApply", end: "arcEditEnd", revert: "arcEditRevert", start: "arcEditStart", view: "arcEditView",
};

function failureAction (commandIntent: GitArcCommandIntent): GitArcFailureAction {
  if (commandIntent.action === "edit") return commandIntent.editStep ? EDIT_STEP_FAILURE_ACTIONS[commandIntent.editStep] : "unknown";
  const actions: Record<Exclude<GitArcCommandAction, "edit">, GitArcFailureAction> = {
    adopt: "arcAdoptSource",
    claims: "arcClaims",
    scope: "arcScope",
    status: "arcStatus",
    compare: "compare",
    continue: "arcContinue",
    diff: "diff",
    plan: "planClaims",
    planStart: "planStart",
    propose: "proposalCreate",
    release: "arcRelease",
    rescind: "proposalRescind",
    restore: "restore",
    stack: "arcStack",
    start: "arcStart",
    stash: "arcStash",
    unstack: "arcUnstack",
    unstash: "arcUnstash",
    unknown: "unknown",
  };
  return actions[commandIntent.action];
}

function failureClaimPaths (failure: ReturnType<typeof parseGitArcFailureReceipt>) {
  if (!failure) return [];
  if (failure.code === "ignoredPaths") return failure.paths;
  if (failure.code !== "siblingClaimCollision" && failure.code !== "planDrift") return [];
  const paths = failure.conflicts.flatMap(({ overlaps }) => overlaps.map(({ requestedPath }) => requestedPath));
  if (failure.code === "planDrift") paths.push(...failure.snapshotPaths);
  return [...new Set(paths)];
}

function isInteractiveCardTarget(target: EventTarget | null) {
  return target instanceof Element
    && Boolean(target.closest("a, button, input, label, select, summary, textarea"));
}

export default function ThreadGitArcItem ({
  commandIntent,
  durationMs,
  durationPresentation = "default",
  editResult = null,
  failureReason,
  interruptedBySteer = false,
  name = null,
  operationDetails,
  outcome,
  operationSummaryRows = [],
  projectFilePaths,
  projectId,
  projectRootPath,
  receipt,
  statusFacts,
  statusIncomplete = false,
  statusOutput,
  typedFailure,
  workspaceRoots,
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
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  receipt: GitArcReceipt | null;
  statusFacts?: Partial<GitArcStatusPresentation> | null;
  statusIncomplete?: boolean;
  statusOutput?: string;
  typedFailure?: GitArcFailure | null;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const state = interruptedBySteer ? "interrupted" : actionState(outcome);
  const defaultOpen = commandIntent.action === "status"
    || commandIntent.action === "unknown"
    || Boolean(receipt?.conflictedPaths?.length || editResult?.conflictedPaths.length);
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const presentationContext = useContext(ThreadGitArcPresentationContext);
  const adoptPaths = commandIntent.adoptPaths ?? [];
  const adoptPathSet = new Set(adoptPaths);
  const editRows = editResult ? createThreadGitArcEditSummaryRows(editResult.files) : [];
  const summaryRows = editResult ? editRows : operationSummaryRows;
  const ref = receipt?.ref ?? commandIntent.ref;
  const memberRefs = receipt?.memberRefs ?? [];
  const claimedPaths = receipt?.claimedPaths ?? [];
  const scopeUpdate = commandIntent.action === "plan" || commandIntent.action === "planStart" || commandIntent.action === "claims" || commandIntent.action === "start";
  const flushClaimLists = scopeUpdate;
  const fullInventory = Boolean(receipt && (receipt.fullScope === true || (receipt.fullScope === undefined && scopeUpdate)));
  const showUpdateChanges = state === "completed" && scopeUpdate && receipt !== null;
  const inventory = fullInventory && receipt ? [
    { label: "Planned", marker: "planned" as const, paths: receipt.plannedPaths ?? [] },
    { label: "Claimed", marker: "claimed" as const, paths: claimedPaths },
    { label: "Adopted", marker: commandIntent.action === "plan" ? "planned" as const : "claimed" as const, paths: receipt.adoptedPaths ?? [] },
  ] : [];
  const selectedPaths = receipt?.selectedPaths ?? commandIntent.paths;
  const ordinarySelectedPaths = selectedPaths.filter((candidate) => !adoptPathSet.has(candidate));
  const labels = commandIntent.action === "edit" && commandIntent.editStep
    ? EDIT_STEP_LABELS[commandIntent.editStep]
    : commandIntent.action === "release" && commandIntent.toSubagent
      ? {
        completed: `Transferred claims to ${commandIntent.toSubagent}`,
        failed: `Failed to transfer claims to ${commandIntent.toSubagent}`,
        inProgress: `Transferring claims to ${commandIntent.toSubagent}`,
        timedOut: `Timed out transferring claims to ${commandIntent.toSubagent}`,
      }
    : commandIntent.action === "release" && commandIntent.disown
      ? { completed: "Disowned", failed: "Failed to disown", inProgress: "Disowning", timedOut: "Timed out disowning" }
      : adoptPaths.length && ordinarySelectedPaths.length && commandIntent.action === "plan"
        ? { completed: "Planned and adopted changes", failed: "Failed to plan and adopt changes", inProgress: "Planning and adopting changes", timedOut: "Timed out planning and adopting changes" }
        : adoptPaths.length && commandIntent.action === "plan"
          ? { completed: "Adopted changes into plan", failed: "Failed to adopt changes", inProgress: "Adopting changes into plan", timedOut: "Timed out adopting changes" }
          : adoptPaths.length && ordinarySelectedPaths.length && commandIntent.action === "planStart"
            ? { completed: "Started with adopted changes", failed: "Failed to adopt changes and start", inProgress: "Adopting changes and starting", timedOut: "Timed out adopting changes and starting" }
            : adoptPaths.length && commandIntent.action === "planStart"
              ? { completed: "Adopted changes and started", failed: "Failed to adopt and start", inProgress: "Adopting changes and starting", timedOut: "Timed out adopting changes and starting" }
              : ACTION_LABELS[commandIntent.action];
  const receiptFailure = state === "failed" || state === "timedOut" ? parseGitArcFailureReceipt(failureReason ?? "") : null;
  const failure = interruptedBySteer ? null : typedFailure ?? receiptFailure ?? (state === "failed"
    ? createGitArcOperationRejected(failureAction(commandIntent), failureReason?.trim() || "This Git arc action did not complete.")
    : null);
  const currentPlan = presentationContext?.gitArcPlan ?? null;
  const requestedPlanRef = failure?.code === "planDrift" ? failure.planRef : commandIntent.ref;
  const currentPlanMatchesCommand = Boolean(currentPlan && requestedPlanRef && (
    currentPlan.checkpointCommit.startsWith(requestedPlanRef)
  ));
  const stackAction = commandIntent.action === "stack" || commandIntent.action === "unstack";
  const stackedProposals = stackAction ? receipt?.stackedProposals ?? null : null;
  const stackedProposalCount = stackAction ? stackedProposals?.length ?? receipt?.proposals?.length ?? null : null;
  const planName = name
    ?? (editResult ? `edit session ${editResult.session}` : commandIntent.action === "edit" ? "edit session" : null)
    ?? (stackAction ? receipt?.layer ?? commandIntent.layerTitle : null)
    ?? receipt?.intentName
    ?? commandIntent.intentName
    ?? (commandIntent.action === "start" && currentPlanMatchesCommand ? currentPlan?.intentName : null)
    ?? "git arc";
  const ignoredFailure = failure?.code === "ignoredPaths" ? failure : null;
  const failedStartDrift = commandIntent.action === "start" && failure?.code === "planDrift" ? failure : null;
  const failedStartDriftTotals = new Map(
    failedStartDrift?.comparison?.map(({ additions, deletions, path }) => [path, { additions, deletions }]) ?? [],
  );
  const primaryPaths = ignoredFailure
    ? ignoredFailure.paths
    : commandIntent.action === "plan" || commandIntent.action === "planStart"
      ? adoptPaths.length ? ordinarySelectedPaths : claimedPaths.length ? claimedPaths : selectedPaths
      : commandIntent.action === "release" || commandIntent.action === "restore"
        ? selectedPaths
        : commandIntent.action === "stash"
          ? receipt?.stashedPaths ?? []
          : commandIntent.action === "unstash"
            ? receipt?.claimedPaths ?? []
        : commandIntent.action === "start" || commandIntent.action === "continue"
          ? failureClaimPaths(failure)
          : [];
  const primaryPathLabel = state === "timedOut"
    ? commandIntent.action === "plan" ? "Timed out planning"
      : commandIntent.action === "planStart" || commandIntent.action === "start" || commandIntent.action === "continue" ? "Timed out claiming"
        : commandIntent.action === "restore" ? "Timed out restoring" : "Timed out changing"
    : state === "failed"
      ? ignoredFailure
        ? commandIntent.action === "plan" || commandIntent.action === "planStart"
          ? "Failed to plan ignored file"
          : "Failed to claim ignored file"
        : failure?.code === "dirtyPaths" && commandIntent.action === "plan"
          ? "Failed to plan changed file"
          : failure?.code === "planDrift"
            ? "Failed to claim drifted file"
            : commandIntent.action === "plan"
              ? "Failed to plan"
              : commandIntent.action === "planStart" || commandIntent.action === "start" || commandIntent.action === "continue"
                ? "Failed to claim"
                : commandIntent.action === "release" ? "Failed to release" : "Failed to restore"
      : commandIntent.action === "plan"
        ? "Planned"
        : commandIntent.action === "release"
          ? commandIntent.disown ? "Disowned" : "Released"
          : commandIntent.action === "restore" ? "Restored"
            : commandIntent.action === "stash" ? "Stashed"
              : commandIntent.action === "unstash" ? "Unstashed"
                : "Claimed";
  const failedPlanOrClaim = state === "failed" && (
    commandIntent.action === "plan"
    || commandIntent.action === "planStart"
    || commandIntent.action === "start"
    || commandIntent.action === "continue"
    || commandIntent.action === "claims"
  );
  const primaryPathMarker: ThreadClaimMarker = failedPlanOrClaim || (state === "completed" && commandIntent.action === "release")
    ? "unclaimed"
    : commandIntent.action === "plan" ? "planned" : "claimed";
  const adoptedPathMarker: ThreadClaimMarker = commandIntent.action === "plan" ? "planned" : "claimed";
  const showNestedClaims = receipt?.fullScope === undefined && commandIntent.action !== "plan" && commandIntent.action !== "planStart" && claimedPaths.length > 0;
  const inventoryLists = inventory.filter((entry) => entry.paths.length).map((entry) => (
    <ThreadClaimedFileList
      inset={!flushClaimLists}
      key={entry.label}
      label={entry.label}
      marker={entry.marker}
      paths={entry.paths}
      projectFilePaths={projectFilePaths}
      projectId={projectId}
      projectRootPath={projectRootPath}
      workspaceRoots={workspaceRoots}
    />
  ));
  const updateSummaryGroups = [
    {
      label: commandIntent.action === "plan" ? "Added to plan" : "Claimed",
      marker: primaryPathMarker,
      paths: receipt?.additionalClaims ?? [],
    },
    {
      label: commandIntent.action === "plan" ? "Removed from plan" : "Released",
      marker: "unclaimed" as const,
      paths: receipt?.removedClaims ?? [],
    },
  ];
  const primarySummaryGroups = [
    {
      label: primaryPathLabel,
      marker: primaryPathMarker,
      paths: primaryPaths,
    },
    {
      label: state === "failed" ? "Failed to adopt" : commandIntent.action === "planStart" ? "Adopted and claimed" : "Adopted",
      marker: state === "failed" ? "unclaimed" as const : adoptedPathMarker,
      paths: adoptPaths,
    },
  ];
  const claimedSummaryGroups = [{
    label: "Claimed",
    marker: "claimed" as const,
    paths: claimedPaths,
  }];
  const countSummaryRows: Extract<ThreadGitArcCollapsedSummaryContent, { kind: "counts" }>["rows"] = [];
  if (receipt?.claimedPathCount !== undefined) {
    countSummaryRows.push({
      label: `${receipt.claimedPathCount} claimed ${receipt.claimedPathCount === 1 ? "file" : "files"}`,
      marker: "claimed",
    });
  }
  if (receipt?.plannedPathCount !== undefined) {
    countSummaryRows.push({
      label: `${receipt.plannedPathCount} planned ${receipt.plannedPathCount === 1 ? "file" : "files"}`,
      marker: "planned",
    });
  }
  if (receipt?.adoptedPathCount !== undefined) {
    countSummaryRows.push({
      label: `${receipt.adoptedPathCount} adopted ${receipt.adoptedPathCount === 1 ? "file" : "files"}`,
      marker: commandIntent.action === "plan" ? "planned" : "claimed",
    });
  }
  const claimSummaryGroups = updateSummaryGroups.some((entry) => entry.paths.length)
    ? updateSummaryGroups
    : inventory.some((entry) => entry.paths.length)
      ? inventory
      : !showUpdateChanges && primarySummaryGroups.some((entry) => entry.paths.length)
        ? primarySummaryGroups
        : claimedSummaryGroups;
  const firstClaimSummaryGroup = claimSummaryGroups.find((entry) => entry.paths.length);
  const claimSummaryCount = claimSummaryGroups.reduce((total, entry) => total + entry.paths.length, 0);
  // Stack cards summarise their sealed proposals instead of the arc's claim counts.
  const collapsedContent: ThreadGitArcCollapsedSummaryContent | null = stackAction
    ? stackedProposals?.length
      ? { commits: stackedProposals.map((summary) => ({ key: summary.proposalId, summary })), kind: "commits" }
      : null
    : summaryRows.length
      ? {
        changes: failedStartDrift
          ? summaryRows.map(row => ({ ...row, danger: true, presentationLabel: primaryPathLabel }))
          : [...summaryRows],
        kind: "files",
      }
      : firstClaimSummaryGroup
        ? {
          kind: "claims",
          label: firstClaimSummaryGroup.label,
          marker: firstClaimSummaryGroup.marker,
          paths: firstClaimSummaryGroup.paths,
          totalCount: claimSummaryCount,
        }
        : countSummaryRows.length ? { kind: "counts", rows: countSummaryRows } : null;

  function openClosedCard(event: MouseEvent<HTMLElement>) {
    if (!isOpen && !isInteractiveCardTarget(event.target)) {
      setIsOpen(true);
    }
  }
  const leadingIcon = commandIntent.action === "release" && commandIntent.toSubagent
    ? <SquareArrowRightEnterIcon size={16} />
    : commandIntent.action === "adopt" && (commandIntent.source?.name || commandIntent.source?.threadId)
      ? <SquareArrowRightExitIcon className="-scale-x-100" size={16} />
      : <GitArcIcon action={commandIntent.action} size={16} />;
  const leadingLabel = commandIntent.action === "release" && commandIntent.toSubagent
    ? "release claims to subagent"
    : commandIntent.action === "adopt" && (commandIntent.source?.name || commandIntent.source?.threadId)
      ? "adopt claims from subagent"
      : `${commandIntent.action} git arc`;

  return (
    <article
      className="my-1.5 w-full rounded-[0.45rem] border border-[color-mix(in_srgb,var(--text)_12%,transparent)] bg-fg/2 px-2.5 py-1.5"
      data-thread-git-arc-card={commandIntent.action}
      onClick={openClosedCard}
    >
      <ThreadDisclosure
        contentClassName={state === "inProgress" ? "mt-1" : "mt-1 border-t border-[color-mix(in_srgb,var(--text)_8%,transparent)]"}
        leading={leadingIcon}
        leadingLabel={leadingLabel}
        onToggle={(event) => setIsOpen(event.currentTarget.open)}
        open={isOpen}
        summary={(
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className={state === "failed" || state === "timedOut" ? "text-[color:var(--danger)]" : "text-text"}>
              {state === "interrupted" ? "Interrupted by your steer" : labels[state]}
            </span>
            {commandIntent.action === "rescind" || commandIntent.action === "status" ? null : <span className="min-w-0 truncate font-medium text-text">{planName}</span>}
            {commandIntent.action === "rescind" && commandIntent.proposalId ? (
              <span className="font-mono text-[0.86em] text-fg/muted">{commandIntent.proposalId.slice(0, 8)}</span>
            ) : null}
            {stackedProposalCount !== null ? (
              <span className="text-[0.86em] text-fg/muted">
                {stackedProposalCount} {stackedProposalCount === 1 ? "proposal" : "proposals"}
              </span>
            ) : null}
            {ref ? <span className="font-mono text-[0.86em] text-fg/muted">{ref.slice(0, 8)}</span> : null}
            {memberRefs.length > 1 ? <span className="text-[0.86em] text-fg/muted">{memberRefs.length} roots</span> : null}
            {editResult ? (
              <span className="inline-flex items-center gap-2 text-[0.86em] text-fg/muted">
                {editResult.fileCount} {editResult.fileCount === 1 ? "file" : "files"}
                <ThreadFileChangeTotals additions={editResult.additions} deletions={editResult.deletions} />
              </span>
            ) : operationSummaryRows.length ? (
              <ThreadGitArcChangeTotals changes={operationSummaryRows.map(row => ({
                path: row.change.path,
                ...(row.summaryTotals ?? row.diff ?? parseUnifiedDiff(row.change.diff)),
              }))} />
            ) : null}
            {durationMs !== null ? durationPresentation === "waited" ? (
              <span className="text-fg/muted" data-thread-git-arc-duration="waited">
                (waited <ThreadDurationText className="inline" durationMs={durationMs} />)
              </span>
            ) : <ThreadDurationText durationMs={durationMs} /> : null}
          </span>
        )}
        summaryClassName="text-[0.82em] leading-[1.45] text-fg/muted"
      >
        {editResult ? (
          <ThreadGitArcEditDetails
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            result={editResult}
            rows={editRows}
            workspaceRoots={workspaceRoots}
          />
        ) : null}
        {operationDetails && !ignoredFailure && !failedStartDrift ? <div>{operationDetails}</div> : null}
        {stackedProposals?.length ? (
          <div className="divide-y divide-[color-mix(in_srgb,var(--text)_8%,transparent)]" data-thread-git-arc-stacked-proposals="true">
            {stackedProposals.map((summary) => (
              <ThreadReadonlyCommitCard
                key={summary.proposalId}
                projectFilePaths={projectFilePaths}
                projectId={projectId}
                projectRootPath={projectRootPath}
                sourceItemId={`stacked-proposal:${summary.proposalId}`}
                state={{ status: "summary", summary }}
                workspaceRoots={workspaceRoots}
              />
            ))}
          </div>
        ) : null}
        {commandIntent.action === "status" && state === "completed" && (statusOutput !== undefined || statusFacts !== undefined) ? (
          <ThreadGitArcStatusDetails output={statusOutput ?? ""} status={statusFacts} incomplete={statusIncomplete} projectFilePaths={projectFilePaths} projectId={projectId} projectRootPath={projectRootPath} workspaceRoots={workspaceRoots} />
        ) : null}
        {memberRefs.length > 1 ? (
          <div className="space-y-0.5 py-1 pl-6 text-[0.78em] text-fg/muted" data-thread-git-arc-members="true">
            {memberRefs.map((member) => (
              <div className="flex min-w-0 items-baseline gap-2" key={`${member.rootId}:${member.ref}`}>
                <span className="min-w-0 flex-1 truncate">{member.rootId}</span>
                <span className="font-mono">{member.ref.slice(0, 8)}</span>
              </div>
            ))}
          </div>
        ) : null}
        {showUpdateChanges ? ([
          { label: commandIntent.action === "plan" ? "Added to plan" : "Claimed", marker: primaryPathMarker, paths: receipt.additionalClaims ?? [] },
          { label: commandIntent.action === "plan" ? "Removed from plan" : "Released", marker: "unclaimed" as const, paths: receipt.removedClaims ?? [] },
        ] as const).filter((entry) => entry.paths.length).map((entry) => (
          <ThreadClaimedFileList
            inset={!flushClaimLists}
            key={entry.label}
            label={entry.label}
            marker={entry.marker}
            paths={entry.paths}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            workspaceRoots={workspaceRoots}
          />
        )) : null}
        {inventoryLists.length ? scopeUpdate ? (
          <ThreadDisclosure
            summary="Full inventory"
            renderContent={() => inventoryLists}
          />
        ) : inventoryLists : null}
        {receipt?.acceptedProposals?.map((accepted) => (
          <div key={`${accepted.proposalId}:${accepted.commitSha}`}>Accepted {accepted.proposalId} at {accepted.commitSha}</div>
        ))}
        {receipt?.planningDrift?.map((drift) => (
          <div key={drift.previousRef}>
            <ThreadClaimedFileList
              inset={!flushClaimLists}
              label="Changed since planning"
              marker="dirty"
              paths={drift.paths}
              projectFilePaths={projectFilePaths}
              projectId={projectId}
              projectRootPath={projectRootPath}
              workspaceRoots={workspaceRoots}
            />
          </div>
        ))}
        {!fullInventory && !showUpdateChanges && primaryPaths.length ? (
          <ThreadClaimedFileList
            inset={!flushClaimLists}
            label={primaryPathLabel}
            marker={primaryPathMarker}
            pathTotals={failedStartDriftTotals}
            paths={primaryPaths}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            tone={state === "failed" || state === "timedOut" ? "danger" : "default"}
            workspaceRoots={workspaceRoots}
          />
        ) : null}
        {!fullInventory && !showUpdateChanges && adoptPaths.length && !ignoredFailure ? (
          <ThreadClaimedFileList
            inset={!flushClaimLists}
            label={state === "failed" ? "Failed to adopt" : state === "timedOut" ? "Timed out adopting" : state === "inProgress" ? "Adopting" : commandIntent.action === "planStart" ? "Adopted and claimed" : "Adopted into plan"}
            marker={state === "failed" ? "unclaimed" : adoptedPathMarker}
            paths={adoptPaths}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            tone={state === "failed" || state === "timedOut" ? "danger" : "default"}
            workspaceRoots={workspaceRoots}
          />
        ) : null}
        {!fullInventory && showNestedClaims ? (
          <ThreadDisclosure
            className="border-t border-[color-mix(in_srgb,var(--text)_8%,transparent)] py-1.5"
            contentClassName={flushClaimLists ? undefined : "pl-1"}
            summary={`${claimedPaths.length} claimed ${claimedPaths.length === 1 ? "file" : "files"}`}
            summaryClassName="text-[0.78em] leading-[1.45] text-fg/muted"
          >
            <ThreadClaimedFileList
              inset={!flushClaimLists}
              paths={claimedPaths}
              projectFilePaths={projectFilePaths}
              projectId={projectId}
              projectRootPath={projectRootPath}
              workspaceRoots={workspaceRoots}
            />
          </ThreadDisclosure>
        ) : null}
        {commandIntent.action === "unstash" && receipt?.conflictedPaths?.length ? (
          <div className="border-t border-[color-mix(in_srgb,var(--text)_8%,transparent)] pt-1.5">
            <ThreadClaimedFileList
              label="Resolve conflict markers"
              marker="dirty"
              paths={receipt.conflictedPaths}
              projectFilePaths={projectFilePaths}
              projectId={projectId}
              projectRootPath={projectRootPath}
              workspaceRoots={workspaceRoots}
            />
            <p className="px-2 pb-1 text-[0.78em] text-fg/muted">Edit the markers directly. No Git continuation or abort command is required.</p>
          </div>
        ) : null}
      </ThreadDisclosure>
      {!isOpen && collapsedContent ? (
        <ThreadGitArcCollapsedSummary
          content={collapsedContent}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          workspaceRoots={workspaceRoots}
        />
      ) : null}
      {failure ? (
        <ThreadGitArcFailure
          failure={failure}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          workspaceRoots={workspaceRoots}
        />
      ) : null}
    </article>
  );
}
