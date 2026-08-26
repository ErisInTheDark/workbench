/*
 * Exports:
 * - default ThreadGitArcItem: render one compact dedicated Git arc lifecycle card with claims, operation details, and failures. Keywords: thread, git, arc, card, lifecycle.
 */
import type { ReactNode } from "react";

import type { WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import {
  createGitArcOperationRejected,
  parseGitArcFailureReceipt,
  type GitArcFailureAction,
} from "../../../lib/workbench/git/git-arc-failures";
import type { GitArcReceipt } from "../../../lib/workbench/git/git-arc-receipts";
import type { GitArcAction } from "../../../lib/workbench/git/git-arc-receipts";
import type { GitArcCommandAction, GitArcCommandIntent, ThreadCommandExecutionOutcome } from "../../../lib/workbench/thread/thread-command-matchers";
import GitArcIcon from "./GitArcIcon";
import ThreadClaimedFileList from "./ThreadClaimedFileList";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadDurationText from "./ThreadDurationText";
import ThreadGitArcFailure from "./ThreadGitArcFailure";
import ThreadGitArcMoveList from "./ThreadGitArcMoveList";

const ACTION_LABELS = {
  add: { completed: "Extended", failed: "Failed to extend", inProgress: "Extending", timedOut: "Timed out extending" },
  adopt: { completed: "Adopted workspace changes", failed: "Failed to adopt workspace changes", inProgress: "Adopting workspace changes", timedOut: "Timed out adopting workspace changes" },
  compare: { completed: "Compared", failed: "Failed to compare", inProgress: "Comparing", timedOut: "Timed out comparing" },
  continue: { completed: "Continued", failed: "Failed to continue", inProgress: "Continuing", timedOut: "Timed out continuing" },
  diff: { completed: "Diffed", failed: "Failed to diff", inProgress: "Diffing", timedOut: "Timed out diffing" },
  mv: { completed: "Moved", failed: "Failed to move", inProgress: "Moving", timedOut: "Timed out moving" },
  plan: { completed: "Planned", failed: "Failed to plan", inProgress: "Planning", timedOut: "Timed out planning" },
  planAdd: { completed: "Extended", failed: "Failed to extend plan", inProgress: "Extending plan", timedOut: "Timed out extending plan" },
  planAdopt: { completed: "Adopted changes", failed: "Failed to adopt changes into plan", inProgress: "Adopting changes into plan", timedOut: "Timed out adopting changes into plan" },
  planRemove: { completed: "Reduced", failed: "Failed to reduce plan", inProgress: "Reducing plan", timedOut: "Timed out reducing plan" },
  planStart: { completed: "Started", failed: "Failed to create and start", inProgress: "Creating and starting", timedOut: "Timed out creating and starting" },
  release: { completed: "Released", failed: "Failed to release", inProgress: "Releasing", timedOut: "Timed out releasing" },
  rescind: { completed: "Rescinded", failed: "Failed to rescind", inProgress: "Rescinding", timedOut: "Timed out rescinding" },
  remove: { completed: "Reduced", failed: "Failed to reduce", inProgress: "Reducing", timedOut: "Timed out reducing" },
  restore: { completed: "Restored", failed: "Failed to restore", inProgress: "Restoring", timedOut: "Timed out restoring" },
  start: { completed: "Started", failed: "Failed to start", inProgress: "Starting", timedOut: "Timed out starting" },
} as const;

function iconAction(action: GitArcCommandAction): GitArcAction {
  if (action === "planAdd" || action === "planAdopt" || action === "planRemove") return "plan";
  if (action === "planStart") return "start";
  if (action === "rescind") return "propose";
  return action;
}

function actionState(outcome: ThreadCommandExecutionOutcome) {
  return outcome === "completed" ? "completed" : outcome === "inProgress" ? "inProgress" : outcome === "timedOut" ? "timedOut" : "failed";
}

function failureAction(action: GitArcCommandAction): GitArcFailureAction {
  const actions: Record<GitArcCommandAction, GitArcFailureAction> = {
    add: "arcAdd",
    adopt: "arcAdopt",
    compare: "compare",
    continue: "arcContinue",
    diff: "diff",
    mv: "arcMove",
    plan: "plan",
    planAdd: "planAdd",
    planAdopt: "planAdopt",
    planRemove: "planRemove",
    planStart: "planStart",
    propose: "proposalCreate",
    release: "arcRelease",
    remove: "arcRemove",
    rescind: "proposalRescind",
    restore: "restore",
    start: "arcStart",
  };
  return actions[action];
}

function attemptedMoveMappings(commandIntent: GitArcCommandIntent) {
  const move = commandIntent.move;
  if (!move || move.kind === "regex") return [];
  if (move.kind === "maps") return move.mappings;
  if (move.operands.length === 2) {
    return [{ destination: move.operands[1]!, source: move.operands[0]! }];
  }
  const destination = move.operands.at(-1)!;
  return move.operands.slice(0, -1).map((source) => ({
    destination: `${destination.replace(/[\\/]+$/u, "")}/${source.split(/[\\/]/u).at(-1)}`,
    source,
  }));
}

function failureClaimPaths(failure: ReturnType<typeof parseGitArcFailureReceipt>) {
  if (!failure) return [];
  if (failure.code === "ignoredPaths") return failure.paths;
  if (failure.code !== "siblingClaimCollision" && failure.code !== "planDrift") return [];
  const paths = failure.conflicts.flatMap(({ overlaps }) => overlaps.map(({ requestedPath }) => requestedPath));
  if (failure.code === "planDrift") paths.push(...failure.snapshotPaths);
  return [...new Set(paths)];
}

export default function ThreadGitArcItem({
  commandIntent,
  durationMs,
  failureReason,
  operationDetails,
  outcome,
  projectFilePaths,
  projectId,
  projectRootPath,
  proposalRedirect,
  receipt,
  workspaceRoots,
}: {
  commandIntent: GitArcCommandIntent;
  durationMs: number | null;
  failureReason?: string | null;
  operationDetails?: ReactNode;
  outcome: ThreadCommandExecutionOutcome;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  proposalRedirect?: { onActivate: () => void; proposalId: string; title: string };
  receipt: GitArcReceipt | null;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  if (commandIntent.action === "propose") {
    if (!proposalRedirect) return null;
    return (
      <article className="my-1.5 w-full rounded-[0.45rem] border border-[color-mix(in_srgb,var(--text)_12%,transparent)] bg-[color-mix(in_srgb,var(--text)_2%,transparent)] px-2.5 py-1.5" data-thread-git-arc-card="propose">
        <button
          className="flex w-full min-w-0 items-baseline gap-2 text-left text-[0.82em] leading-[1.45] text-muted hover:text-text"
          onClick={proposalRedirect.onActivate}
          type="button"
        >
          <GitArcIcon action="propose" />
          <span>Proposed</span>
          <span className="min-w-0 truncate font-medium text-text">{proposalRedirect.title.trim() || "Commit proposal"}</span>
          <span className="shrink-0 font-mono text-[0.86em] text-muted">{proposalRedirect.proposalId.slice(0, 8)}</span>
        </button>
      </article>
    );
  }
  const state = actionState(outcome);
  const adoptPaths = commandIntent.adoptPaths ?? [];
  const adoptPathSet = new Set(adoptPaths);
  const movePreview = commandIntent.action === "mv" && (
    receipt?.mode === "preview"
    || (!receipt && commandIntent.move?.kind === "regex" && !commandIntent.move.confirm)
  );
  const planName = receipt?.intentName ?? commandIntent.intentName ?? "git arc";
  const ref = receipt?.ref ?? commandIntent.ref;
  const memberRefs = receipt?.memberRefs ?? [];
  const claimedPaths = receipt?.claimedPaths ?? [];
  const selectedPaths = receipt?.selectedPaths ?? commandIntent.paths;
  const ordinarySelectedPaths = selectedPaths.filter((candidate) => !adoptPathSet.has(candidate));
  const labels = movePreview
    ? { completed: "Previewed", failed: "Failed to preview moves", inProgress: "Previewing moves", timedOut: "Timed out previewing moves" }
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
  const moveMappings = commandIntent.action === "mv" ? receipt?.mappings ?? attemptedMoveMappings(commandIntent) : [];
  const receiptFailure = state === "failed" || state === "timedOut" ? parseGitArcFailureReceipt(failureReason ?? "") : null;
  const failure = receiptFailure ?? (state === "failed"
    ? createGitArcOperationRejected(failureAction(commandIntent.action), failureReason?.trim() || "This Git arc action did not complete.")
    : null);
  const ignoredFailure = failure?.code === "ignoredPaths" ? failure : null;
  const primaryPaths = ignoredFailure
    ? ignoredFailure.paths
    : commandIntent.action === "plan" || commandIntent.action === "planStart"
    ? adoptPaths.length ? ordinarySelectedPaths : claimedPaths.length ? claimedPaths : selectedPaths
    : commandIntent.action === "add" || commandIntent.action === "adopt" || commandIntent.action === "remove"
      || commandIntent.action === "release" || commandIntent.action === "restore"
      || commandIntent.action === "planAdd" || commandIntent.action === "planAdopt" || commandIntent.action === "planRemove"
      ? selectedPaths
      : commandIntent.action === "start" || commandIntent.action === "continue"
        ? failureClaimPaths(failure)
      : [];
  const primaryPathLabel = state === "timedOut"
    ? commandIntent.action === "plan" ? "Timed out planning"
      : commandIntent.action === "planAdopt" || commandIntent.action === "adopt" ? "Timed out adopting"
        : commandIntent.action === "planStart" || commandIntent.action === "start" || commandIntent.action === "continue" || commandIntent.action === "add" ? "Timed out claiming"
          : commandIntent.action === "restore" ? "Timed out restoring" : "Timed out changing"
    : state === "failed"
    ? ignoredFailure
      ? commandIntent.action === "plan" || commandIntent.action === "planAdd"
        || commandIntent.action === "planAdopt" || commandIntent.action === "planStart"
        ? "Failed to plan ignored file"
        : "Failed to claim ignored file"
      : failure?.code === "dirtyPaths" && commandIntent.action === "plan"
      ? "Failed to plan changed file"
      : failure?.code === "planDrift"
        ? "Failed to claim drifted file"
        : commandIntent.action === "plan"
      ? "Failed to plan"
      : commandIntent.action === "planAdd"
        ? "Failed to add to plan"
        : commandIntent.action === "planRemove"
          ? "Failed to remove from plan"
          : commandIntent.action === "planAdopt"
            ? "Failed to adopt"
            : commandIntent.action === "planStart"
              ? "Failed to claim"
              : commandIntent.action === "start" || commandIntent.action === "continue"
                ? "Failed to claim"
              : commandIntent.action === "adopt"
                ? "Failed to adopt"
                : commandIntent.action === "add"
                  ? "Failed to claim"
                  : commandIntent.action === "remove" ? "Failed to remove"
                    : commandIntent.action === "release" ? "Failed to release" : "Failed to restore"
    : commandIntent.action === "plan"
      ? "Planned"
      : commandIntent.action === "planAdd"
        ? "Added to plan"
        : commandIntent.action === "planRemove"
          ? "Removed from plan"
          : commandIntent.action === "planAdopt"
            ? "Adopted into plan"
            : commandIntent.action === "remove"
              ? "Removed"
              : commandIntent.action === "release"
                ? commandIntent.disown ? "Disowned" : "Released"
              : commandIntent.action === "restore" ? "Restored" : "Claimed";
  const primaryPathMarker = commandIntent.action === "plan"
    || commandIntent.action === "planAdd"
    || commandIntent.action === "planAdopt"
    || commandIntent.action === "planRemove"
    ? "planned"
    : "claimed";
  const showNestedClaims = commandIntent.action !== "plan" && commandIntent.action !== "planStart" && claimedPaths.length > 0;

  return (
    <article className="my-1.5 w-full rounded-[0.45rem] border border-[color-mix(in_srgb,var(--text)_12%,transparent)] bg-[color-mix(in_srgb,var(--text)_2%,transparent)] px-2.5 py-1.5" data-thread-git-arc-card={commandIntent.action}>
      <ThreadDisclosure
        contentClassName={state === "inProgress" ? "mt-1" : "mt-1 border-t border-[color-mix(in_srgb,var(--text)_8%,transparent)]"}
        defaultOpen={commandIntent.action !== "compare" && commandIntent.action !== "diff"}
        leading={<GitArcIcon action={iconAction(commandIntent.action)} />}
        leadingLabel={`${commandIntent.action} git arc`}
        summary={(
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className={state === "failed" || state === "timedOut" ? "text-[color:var(--danger)]" : "text-text"}>
              {commandIntent.action === "mv" && state === "completed"
                ? movePreview
                  ? `Previewed ${moveMappings.length} ${moveMappings.length === 1 ? "move" : "moves"}`
                  : `Moved ${moveMappings.length} ${moveMappings.length === 1 ? "path" : "paths"}`
                : labels[state]}
            </span>
            {commandIntent.action === "rescind" ? null : <span className="min-w-0 truncate font-medium text-text">{planName}</span>}
            {commandIntent.action === "rescind" && commandIntent.proposalId ? (
              <span className="font-mono text-[0.86em] text-muted">{commandIntent.proposalId.slice(0, 8)}</span>
            ) : null}
            {ref ? <span className="font-mono text-[0.86em] text-muted">{ref.slice(0, 8)}</span> : null}
            {memberRefs.length > 1 ? <span className="text-[0.86em] text-muted">{memberRefs.length} roots</span> : null}
            {durationMs !== null ? <ThreadDurationText durationMs={durationMs} /> : null}
          </span>
        )}
        summaryClassName="text-[0.82em] leading-[1.45] text-muted"
      >
        {commandIntent.action === "mv" && !ignoredFailure ? (
          <ThreadGitArcMoveList
            mappings={moveMappings}
            projectId={projectId}
            projectRootPath={projectRootPath}
            workspaceRoots={workspaceRoots}
          />
        ) : null}
        {operationDetails && !ignoredFailure ? <div>{operationDetails}</div> : null}
        {memberRefs.length > 1 ? (
          <div className="space-y-0.5 py-1 pl-6 text-[0.78em] text-muted" data-thread-git-arc-members="true">
            {memberRefs.map((member) => (
              <div className="flex min-w-0 items-baseline gap-2" key={`${member.rootId}:${member.ref}`}>
                <span className="min-w-0 flex-1 truncate">{member.rootId}</span>
                <span className="font-mono">{member.ref.slice(0, 8)}</span>
              </div>
            ))}
          </div>
        ) : null}
        {primaryPaths.length ? (
          <ThreadClaimedFileList
            label={primaryPathLabel}
            marker={primaryPathMarker}
            paths={primaryPaths}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            tone={state === "failed" || state === "timedOut" ? "danger" : "default"}
            workspaceRoots={workspaceRoots}
          />
        ) : null}
        {adoptPaths.length && !ignoredFailure ? (
          <ThreadClaimedFileList
            label={state === "failed" ? "Failed to adopt" : state === "timedOut" ? "Timed out adopting" : state === "inProgress" ? "Adopting" : commandIntent.action === "planStart" ? "Adopted and claimed" : "Adopted into plan"}
            marker={commandIntent.action === "plan" ? "planned" : "claimed"}
            paths={adoptPaths}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            tone={state === "failed" || state === "timedOut" ? "danger" : "default"}
            workspaceRoots={workspaceRoots}
          />
        ) : null}
        {showNestedClaims ? (
          <ThreadDisclosure
            className="border-t border-[color-mix(in_srgb,var(--text)_8%,transparent)] py-1.5"
            contentClassName="pl-1"
            summary={`${claimedPaths.length} claimed ${claimedPaths.length === 1 ? "file" : "files"}`}
            summaryClassName="text-[0.78em] leading-[1.45] text-muted"
          >
            <ThreadClaimedFileList
              paths={claimedPaths}
              projectFilePaths={projectFilePaths}
              projectId={projectId}
              projectRootPath={projectRootPath}
              workspaceRoots={workspaceRoots}
            />
          </ThreadDisclosure>
        ) : null}
      </ThreadDisclosure>
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
