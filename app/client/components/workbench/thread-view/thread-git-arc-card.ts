/*
 * Exports:
 * - GitArcCardState/GitArcCardStyle/GitArcPathGroup/GitArcCard: one Git arc call as a card: its line, its flat body and its
 *   closed preview.
 * - buildGitArcCard: derive that card from the call's intent, outcome, receipt or typed failure, and status facts.
 */
import {
  createGitArcOperationRejected,
  parseGitArcFailureReceipt,
  type GitArcFailure,
  type GitArcFailureAction,
} from "workbench-shared/workbench/git/git-arc-failures";
import type { GitArcEditResult } from "workbench-shared/workbench/git/git-arc-edit-contracts";
import type { GitArcReceipt } from "workbench-shared/workbench/git/git-arc-receipts";
import { parseGitArcStatus, type GitArcStatusPresentation } from "workbench-shared/workbench/git/git-arc-status";
import type { GitArcCommandAction, GitArcCommandIntent, ThreadCommandExecutionOutcome } from "../../../workbench/thread/thread-command-matchers";
import type { GitArcEditStep } from "../../../workbench/thread/command-matchers/workbench-command-rendering";
import type { ThreadClaimMarker } from "./ThreadClaimedFileList";
import {
  createThreadGitArcEditSummaryRows,
  createThreadGitArcStatusCounts,
  type ThreadGitArcCollapsedSummaryContent,
} from "./ThreadGitArcCollapsedSummary";

export type GitArcCardState = "completed" | "failed" | "inProgress" | "interrupted" | "timedOut";
type Phase = Exclude<GitArcCardState, "interrupted">;
type Labels = Record<Phase, string>;

/**
 * How a card draws outside a run: one line opening into its flat body, or a line that also previews its result while
 * closed. Inside a run's command group, arc reads are `step`s instead.
 */
export type GitArcCardStyle = "card" | "cardPreview" | "step";

/** One list of paths in a card's body, in the order the body shows them. */
export interface GitArcPathGroup {
  key: string;
  label: string;
  marker: ThreadClaimMarker;
  paths: readonly string[];
  danger: boolean;
  /** Per-path change totals, where the failure measured them. */
  totals?: ReadonlyMap<string, { additions: number; deletions: number }>;
}

export interface GitArcCard {
  action: GitArcCommandAction;
  state: GitArcCardState;
  style: GitArcCardStyle;
  /** What happened, such as "Planned"; a transfer's target subagent follows it separately. */
  label: string;
  transferTarget: string | null;
  /** The plan, proposal or layer it happened to; reads of the whole arc and counted releases name none. */
  subject: string | null;
  /** How many claims a completed plain release let go; its body lists them. */
  releasedCount: number | null;
  /** A status read's counts, shown on its line whatever the agent asked to expand. */
  statusCounts: ReturnType<typeof createThreadGitArcStatusCounts> | null;
  /** Names the leading glyph for assistive technology. */
  iconLabel: string;
  failure: GitArcFailure | null;
  /** Conflicts need the user, so those cards open by themselves. */
  defaultOpen: boolean;
  preview: ThreadGitArcCollapsedSummaryContent | null;
  pathGroups: readonly GitArcPathGroup[];
  /** Counts a compact receipt reports instead of paths, such as "40 claimed files". */
  counts: Extract<ThreadGitArcCollapsedSummaryContent, { kind: "counts" }>["rows"];
  /** Repository roots of a multi-root arc, by root id. */
  memberRefs: NonNullable<GitArcReceipt["memberRefs"]>;
  stackedProposals: NonNullable<GitArcReceipt["stackedProposals"]>;
  stackedProposalCount: number | null;
  /** Status facts to lay out in the body, when this is a completed status read. */
  status: Partial<GitArcStatusPresentation> | null;
  /** Unstash conflicts the user resolves by editing markers in place. */
  conflictedPaths: readonly string[];
}

const labels = (completed: string, failed: string, inProgress: string, timedOut: string): Labels => ({ completed, failed, inProgress, timedOut });

const ACTION_LABELS: Record<GitArcCommandAction, Labels> = {
  adopt: labels("Adopted claims", "Failed to adopt claims", "Adopting claims", "Timed out adopting claims"),
  claims: labels("Updated claims", "Failed to update claims", "Updating claims", "Timed out updating claims"),
  compare: labels("Compared", "Failed to compare", "Comparing", "Timed out comparing"),
  continue: labels("Continued", "Failed to continue", "Continuing", "Timed out continuing"),
  diff: labels("Diffed", "Failed to diff", "Diffing", "Timed out diffing"),
  edit: labels("Edited", "Failed to edit", "Editing", "Timed out editing"),
  plan: labels("Planned", "Failed to plan", "Planning", "Timed out planning"),
  planStart: labels("Started", "Failed to create and start", "Creating and starting", "Timed out creating and starting"),
  propose: labels("Proposed", "Failed to propose", "Proposing", "Timed out proposing"),
  release: labels("Released", "Failed to release", "Releasing", "Timed out releasing"),
  rescind: labels("Rescinded", "Failed to rescind", "Rescinding", "Timed out rescinding"),
  restore: labels("Restored", "Failed to restore", "Restoring", "Timed out restoring"),
  scope: labels("Read scope", "Failed to read scope", "Reading scope", "Timed out reading scope"),
  stack: labels("Stacked", "Failed to stack", "Stacking", "Timed out stacking"),
  start: labels("Started", "Failed to start", "Starting", "Timed out starting"),
  stash: labels("Stashed", "Failed to stash", "Stashing", "Timed out stashing"),
  status: labels("Status", "Failed to read status", "Reading status", "Timed out reading status"),
  unknown: labels("Ran unrecognised action on", "Failed to run action on", "Running action on", "Timed out running action on"),
  unstack: labels("Unstacked", "Failed to unstack", "Unstacking", "Timed out unstacking"),
  unstash: labels("Unstashed", "Failed to unstash", "Unstashing", "Timed out unstashing"),
};

const EDIT_STEP_LABELS: Record<GitArcEditStep, Labels> = {
  apply: labels("Applied edit", "Failed to apply edit", "Applying edit", "Timed out applying edit"),
  end: labels("Ended edit", "Failed to end edit", "Ending edit", "Timed out ending edit"),
  revert: labels("Reverted edit", "Failed to revert edit", "Reverting edit", "Timed out reverting edit"),
  start: labels("Previewed edit", "Failed to preview edit", "Previewing edit", "Timed out previewing edit"),
  view: labels("Viewed edit", "Failed to view edit", "Viewing edit", "Timed out viewing edit"),
};

const TRANSFER_LABELS = labels("Transferred claims to", "Failed to transfer claims to", "Transferring claims to", "Timed out transferring claims to");
const DISOWN_LABELS = labels("Disowned", "Failed to disown", "Disowning", "Timed out disowning");
const PLAN_AND_ADOPT_LABELS = labels("Planned and adopted changes", "Failed to plan and adopt changes", "Planning and adopting changes", "Timed out planning and adopting changes");
const ADOPT_INTO_PLAN_LABELS = labels("Adopted changes into plan", "Failed to adopt changes", "Adopting changes into plan", "Timed out adopting changes");
const START_WITH_ADOPTED_LABELS = labels("Started with adopted changes", "Failed to adopt changes and start", "Adopting changes and starting", "Timed out adopting changes and starting");
const ADOPT_AND_START_LABELS = labels("Adopted changes and started", "Failed to adopt and start", "Adopting changes and starting", "Timed out adopting changes and starting");

const CARD_STYLES: Record<GitArcCommandAction, Exclude<GitArcCardStyle, "step">> = {
  adopt: "card", claims: "card", compare: "card", continue: "card", diff: "card", edit: "cardPreview", plan: "card",
  planStart: "card", propose: "card", release: "card", rescind: "card", restore: "cardPreview", scope: "cardPreview",
  stack: "card", start: "card", stash: "card", status: "card", unknown: "card", unstack: "card", unstash: "card",
};

/** Arc reads and plans that sit inside a run's command group as steps of the surrounding work. */
const RUN_STEPS: ReadonlySet<GitArcCommandAction> = new Set(["claims", "compare", "continue", "diff", "plan"]);

const FAILURE_ACTIONS: Record<Exclude<GitArcCommandAction, "edit">, GitArcFailureAction> = {
  adopt: "arcAdoptSource", claims: "arcClaims", compare: "compare", continue: "arcContinue", diff: "diff", plan: "planClaims",
  planStart: "planStart", propose: "proposalCreate", release: "arcRelease", rescind: "proposalRescind", restore: "restore",
  scope: "arcScope", stack: "arcStack", start: "arcStart", stash: "arcStash", status: "arcStatus", unknown: "unknown",
  unstack: "arcUnstack", unstash: "arcUnstash",
};

const EDIT_STEP_FAILURE_ACTIONS: Record<GitArcEditStep, GitArcFailureAction> = {
  apply: "arcEditApply", end: "arcEditEnd", revert: "arcEditRevert", start: "arcEditStart", view: "arcEditView",
};

/** Actions that set what the arc plans or claims; their cards list the resulting scope. */
const SCOPE_UPDATES: ReadonlySet<GitArcCommandAction> = new Set(["claims", "plan", "planStart", "start"]);
/** Actions that claim files, so a failure names the files it could not claim. */
const CLAIMING: ReadonlySet<GitArcCommandAction> = new Set(["claims", "continue", "plan", "planStart", "start"]);

function phase(outcome: ThreadCommandExecutionOutcome): Phase {
  return outcome === "completed" || outcome === "inProgress" || outcome === "timedOut" ? outcome : "failed";
}

function labelsFor(intent: GitArcCommandIntent, adoptOnly: boolean, adoptWithSelected: boolean): Labels {
  if (intent.action === "edit" && intent.editStep) return EDIT_STEP_LABELS[intent.editStep];
  if (intent.action === "release" && intent.toSubagent) return TRANSFER_LABELS;
  if (intent.action === "release" && intent.disown) return DISOWN_LABELS;
  if (intent.action === "plan" && (adoptOnly || adoptWithSelected)) return adoptWithSelected ? PLAN_AND_ADOPT_LABELS : ADOPT_INTO_PLAN_LABELS;
  if (intent.action === "planStart" && (adoptOnly || adoptWithSelected)) return adoptWithSelected ? START_WITH_ADOPTED_LABELS : ADOPT_AND_START_LABELS;
  return ACTION_LABELS[intent.action];
}

function failureAction(intent: GitArcCommandIntent): GitArcFailureAction {
  if (intent.action !== "edit") return FAILURE_ACTIONS[intent.action];
  return intent.editStep ? EDIT_STEP_FAILURE_ACTIONS[intent.editStep] : "unknown";
}

/** Files a claim failure names: ignored paths, or every overlapping and drifted path. */
function failurePaths(failure: GitArcFailure | null) {
  if (!failure) return [];
  if (failure.code === "ignoredPaths") return failure.paths;
  if (failure.code !== "siblingClaimCollision" && failure.code !== "planDrift") return [];
  const paths = failure.conflicts.flatMap(({ overlaps }) => overlaps.map(({ requestedPath }) => requestedPath));
  if (failure.code === "planDrift") paths.push(...failure.snapshotPaths);
  return [...new Set(paths)];
}

/** What the primary path list means, from the outcome, the failure and the action. */
function primaryLabel(action: GitArcCommandAction, state: GitArcCardState, failure: GitArcFailure | null, disown: boolean) {
  if (state === "timedOut") {
    if (action === "plan") return "Timed out planning";
    if (action === "planStart" || action === "start" || action === "continue") return "Timed out claiming";
    return action === "restore" ? "Timed out restoring" : "Timed out changing";
  }
  if (state === "failed") {
    if (failure?.code === "ignoredPaths") return action === "plan" || action === "planStart" ? "Failed to plan ignored file" : "Failed to claim ignored file";
    if (failure?.code === "dirtyPaths" && action === "plan") return "Failed to plan changed file";
    if (failure?.code === "planDrift") return "Failed to claim drifted file";
    if (action === "plan") return "Failed to plan";
    if (action === "planStart" || action === "start" || action === "continue") return "Failed to claim";
    return action === "release" ? "Failed to release" : "Failed to restore";
  }
  const completed: Partial<Record<GitArcCommandAction, string>> = { plan: "Planned", release: disown ? "Disowned" : "Released", restore: "Restored", stash: "Stashed", unstash: "Unstashed" };
  return completed[action] ?? "Claimed";
}

/** The files the action itself is about, before any receipt inventory. */
function primaryPaths(intent: GitArcCommandIntent, receipt: GitArcReceipt | null, failure: GitArcFailure | null, selected: readonly string[], ordinarySelected: readonly string[]) {
  if (failure?.code === "ignoredPaths") return failure.paths;
  switch (intent.action) {
    case "plan":
    case "planStart":
      return intent.adoptPaths?.length ? ordinarySelected : receipt?.claimedPaths.length ? receipt.claimedPaths : selected;
    // A release names what it actually let go; the request only names what it asked for.
    case "release": return receipt?.removedClaims?.length ? receipt.removedClaims : selected;
    case "restore": return selected;
    case "stash": return receipt?.stashedPaths ?? [];
    case "unstash": return receipt?.claimedPaths ?? [];
    case "start":
    case "continue": return failurePaths(failure);
    default: return [];
  }
}

export function buildGitArcCard(input: {
  /** Inside a run's command group, arc reads become steps. */
  asRunStep: boolean;
  /** The thread's current plan, which names a start that did not say which plan it started. */
  currentPlan: { checkpointCommit: string; intentName: string } | null;
  editResult: GitArcEditResult | null;
  failureReason: string | null;
  intent: GitArcCommandIntent;
  interruptedBySteer: boolean;
  name: string | null;
  outcome: ThreadCommandExecutionOutcome;
  receipt: GitArcReceipt | null;
  statusFacts: Partial<GitArcStatusPresentation> | null | undefined;
  statusOutput: string | undefined;
  typedFailure: GitArcFailure | null;
}): GitArcCard {
  const { editResult, intent, receipt } = input;
  const { action } = intent;
  const state: GitArcCardState = input.interruptedBySteer ? "interrupted" : phase(input.outcome);
  const failed = state === "failed" || state === "timedOut";

  const failure = input.interruptedBySteer ? null : input.typedFailure
    ?? (failed ? parseGitArcFailureReceipt(input.failureReason ?? "") : null)
    ?? (state === "failed" ? createGitArcOperationRejected(failureAction(intent), input.failureReason?.trim() || "This Git arc action did not complete.") : null);

  const adoptPaths = intent.adoptPaths ?? [];
  const selected = receipt?.selectedPaths ?? intent.paths;
  const ordinarySelected = selected.filter(path => !adoptPaths.includes(path));
  const phaseLabels = labelsFor(intent, adoptPaths.length > 0 && !ordinarySelected.length, adoptPaths.length > 0 && ordinarySelected.length > 0);

  const stackAction = action === "stack" || action === "unstack";
  const plannedRef = failure?.code === "planDrift" ? failure.planRef : intent.ref;
  const startsCurrentPlan = action === "start" && Boolean(input.currentPlan && plannedRef && input.currentPlan.checkpointCommit.startsWith(plannedRef));
  const subjectName = input.name
    ?? (editResult ? `edit session ${editResult.session}` : action === "edit" ? "edit session" : null)
    ?? (stackAction ? receipt?.layer ?? intent.layerTitle : null)
    ?? receipt?.intentName ?? intent.intentName
    ?? (startsCurrentPlan ? input.currentPlan?.intentName : null)
    ?? "git arc";

  // Path groups, in the order the body lists them.
  const claimedPaths = receipt?.claimedPaths ?? [];
  const scopeUpdate = SCOPE_UPDATES.has(action);
  const fullInventory = Boolean(receipt && (receipt.fullScope === true || (receipt.fullScope === undefined && scopeUpdate)));
  const showsUpdate = state === "completed" && scopeUpdate && receipt !== null;
  const ignored = failure?.code === "ignoredPaths";
  const drift = action === "start" && failure?.code === "planDrift" ? failure : null;
  const primaryMarker: ThreadClaimMarker = (state === "failed" && CLAIMING.has(action)) || (state === "completed" && action === "release")
    ? "unclaimed" : action === "plan" ? "planned" : "claimed";
  const adoptedMarker: ThreadClaimMarker = action === "plan" ? "planned" : "claimed";
  const primary = primaryPaths(intent, receipt, failure, selected, ordinarySelected);
  const primaryText = primaryLabel(action, state, failure, Boolean(intent.disown));
  const group = (key: string, label: string, marker: ThreadClaimMarker, paths: readonly string[], extra: Partial<GitArcPathGroup> = {}): GitArcPathGroup =>
    ({ danger: false, key, label, marker, paths, ...extra });
  const updates = showsUpdate ? [
    group("added", action === "plan" ? "Added to plan" : "Claimed", primaryMarker, receipt.additionalClaims ?? []),
    group("removed", action === "plan" ? "Removed from plan" : "Released", "unclaimed", receipt.removedClaims ?? []),
  ] : [];
  const inventory = fullInventory && receipt ? [
    group("planned", "Planned", "planned", receipt.plannedPaths ?? []),
    group("claimed", "Claimed", "claimed", claimedPaths),
    group("adopted", "Adopted", adoptedMarker, receipt.adoptedPaths ?? []),
  ] : [];
  const primaryGroup = group("primary", primaryText, primaryMarker, primary, {
    danger: failed,
    ...(drift?.comparison ? { totals: new Map(drift.comparison.map(({ additions, deletions, path }) => [path, { additions, deletions }])) } : {}),
  });
  const adoptGroup = group("adopt", state === "failed" ? "Failed to adopt" : state === "timedOut" ? "Timed out adopting" : state === "inProgress" ? "Adopting"
    : action === "planStart" ? "Adopted and claimed" : "Adopted into plan", state === "failed" ? "unclaimed" : adoptedMarker, ignored ? [] : adoptPaths, { danger: failed });
  const heldGroup = group("held", "Claimed", "claimed", claimedPaths);
  // A scope update's change is the news; its full inventory only matters when nothing changed.
  const pathGroups = [
    ...updates,
    ...(updates.some(entry => entry.paths.length) ? [] : inventory),
    ...(receipt?.planningDrift ?? []).map(entry => group(`drift:${entry.previousRef}`, "Changed since planning", "dirty", entry.paths)),
    ...(!fullInventory && !showsUpdate ? [primaryGroup, adoptGroup] : []),
    // A receipt that did not say whether it is the full scope still names what the arc holds.
    ...(!fullInventory && receipt?.fullScope === undefined && action !== "plan" && action !== "planStart" ? [heldGroup] : []),
  ].filter(entry => entry.paths.length);

  const status = action === "status" && state === "completed"
    ? input.statusFacts ?? (input.statusOutput === undefined ? null : parseGitArcStatus(input.statusOutput).data ?? null)
    : null;
  const stackedProposals = stackAction ? receipt?.stackedProposals ?? [] : [];
  const counts = ([
    [receipt?.claimedPathCount, "claimed", "claimed"],
    [receipt?.plannedPathCount, "planned", "planned"],
    [receipt?.adoptedPathCount, "adopted", adoptedMarker],
  ] as const).flatMap(([count, noun, marker]) => count === undefined ? [] : [{ label: `${count} ${noun} ${count === 1 ? "file" : "files"}`, marker }]);

  const style: GitArcCardStyle = input.asRunStep && RUN_STEPS.has(action) ? "step" : CARD_STYLES[action];
  // Only preview cards keep a result visible while closed: edited files, or the first file list.
  const editRows = editResult ? createThreadGitArcEditSummaryRows(editResult.files) : [];
  const first = pathGroups[0];
  const preview: ThreadGitArcCollapsedSummaryContent | null = style !== "cardPreview" ? null
    : editRows.length ? { changes: editRows, kind: "files" }
      : first ? { kind: "claims", label: first.label, marker: first.marker, paths: [...first.paths], totalCount: first.paths.length }
        : counts.length ? { kind: "counts", rows: counts } : null;

  const transfer = action === "release" && intent.toSubagent ? intent.toSubagent : null;
  // A plain release or disown is about how many claims it let go, not which plan they belonged to.
  const releasedCount = action === "release" && !transfer && state === "completed" && primary.length ? primary.length : null;
  const adoptFromSubagent = action === "adopt" && Boolean(intent.source?.name || intent.source?.threadId);
  return {
    action,
    state,
    style,
    label: state === "interrupted" ? "Interrupted by your steer" : phaseLabels[state],
    transferTarget: transfer,
    subject: action === "rescind" || action === "status" || action === "scope" || releasedCount !== null ? null : subjectName,
    releasedCount,
    statusCounts: status ? createThreadGitArcStatusCounts(status) : null,
    iconLabel: transfer ? "release claims to subagent" : adoptFromSubagent ? "adopt claims from subagent" : `${action} git arc`,
    failure,
    defaultOpen: Boolean(receipt?.conflictedPaths?.length || editResult?.conflictedPaths.length) || action === "unknown",
    preview,
    pathGroups,
    counts,
    memberRefs: receipt?.memberRefs ?? [],
    stackedProposals,
    stackedProposalCount: stackAction ? receipt?.stackedProposals?.length ?? receipt?.proposals?.length ?? null : null,
    status,
    conflictedPaths: action === "unstash" ? receipt?.conflictedPaths ?? [] : [],
  };
}
