/*
 * Exports:
 * - default ThreadGitArcItem: render shared Git arc lifecycle, status and recovery cards.
 */
import type { ReactNode } from "react";

import {
  createGitArcOperationRejected,
  parseGitArcFailureReceipt,
  type GitArcFailureAction,
} from "workbench-shared/workbench/git/git-arc-failures";
import type { GitArcReceipt } from "workbench-shared/workbench/git/git-arc-receipts";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import type { GitArcCommandAction, GitArcCommandIntent, ThreadCommandExecutionOutcome } from "../../../workbench/thread/thread-command-matchers";
import GitArcIcon from "./GitArcIcon";
import ThreadClaimedFileList from "./ThreadClaimedFileList";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadDurationText from "./ThreadDurationText";
import ThreadGitArcFailure from "./ThreadGitArcFailure";
import ThreadGitArcMoveList from "./ThreadGitArcMoveList";
import ThreadGitArcStatusDetails from "./ThreadGitArcStatusDetails";

const ACTION_LABELS = {
  claims: { completed: "Updated claims", failed: "Failed to update claims", inProgress: "Updating claims", timedOut: "Timed out updating claims" },
  scope: { completed: "Read scope", failed: "Failed to read scope", inProgress: "Reading scope", timedOut: "Timed out reading scope" },
  status: { completed: "Read status", failed: "Failed to read status", inProgress: "Reading status", timedOut: "Timed out reading status" },
  compare: { completed: "Compared", failed: "Failed to compare", inProgress: "Comparing", timedOut: "Timed out comparing" },
  continue: { completed: "Continued", failed: "Failed to continue", inProgress: "Continuing", timedOut: "Timed out continuing" },
  diff: { completed: "Diffed", failed: "Failed to diff", inProgress: "Diffing", timedOut: "Timed out diffing" },
  mv: { completed: "Moved", failed: "Failed to move", inProgress: "Moving", timedOut: "Timed out moving" },
  plan: { completed: "Planned", failed: "Failed to plan", inProgress: "Planning", timedOut: "Timed out planning" },
  planStart: { completed: "Started", failed: "Failed to create and start", inProgress: "Creating and starting", timedOut: "Timed out creating and starting" },
  propose: { completed: "Proposed", failed: "Failed to propose", inProgress: "Proposing", timedOut: "Timed out proposing" },
  release: { completed: "Released", failed: "Failed to release", inProgress: "Releasing", timedOut: "Timed out releasing" },
  rescind: { completed: "Rescinded", failed: "Failed to rescind", inProgress: "Rescinding", timedOut: "Timed out rescinding" },
  restore: { completed: "Restored", failed: "Failed to restore", inProgress: "Restoring", timedOut: "Timed out restoring" },
  start: { completed: "Started", failed: "Failed to start", inProgress: "Starting", timedOut: "Timed out starting" },
  unknown: { completed: "Ran unrecognised action on", failed: "Failed to run action on", inProgress: "Running action on", timedOut: "Timed out running action on" },
} as const;

function actionState (outcome: ThreadCommandExecutionOutcome) {
  return outcome === "completed" ? "completed" : outcome === "inProgress" ? "inProgress" : outcome === "timedOut" ? "timedOut" : "failed";
}

function failureAction (action: GitArcCommandAction): GitArcFailureAction {
  const actions: Record<GitArcCommandAction, GitArcFailureAction> = {
    claims: "arcClaims",
    scope: "arcScope",
    status: "arcStatus",
    compare: "compare",
    continue: "arcContinue",
    diff: "diff",
    mv: "arcMove",
    plan: "planClaims",
    planStart: "planStart",
    propose: "proposalCreate",
    release: "arcRelease",
    rescind: "proposalRescind",
    restore: "restore",
    start: "arcStart",
    unknown: "unknown",
  };
  return actions[action];
}

function attemptedMoveMappings (commandIntent: GitArcCommandIntent) {
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

function failureClaimPaths (failure: ReturnType<typeof parseGitArcFailureReceipt>) {
  if (!failure) return [];
  if (failure.code === "ignoredPaths") return failure.paths;
  if (failure.code !== "siblingClaimCollision" && failure.code !== "planDrift") return [];
  const paths = failure.conflicts.flatMap(({ overlaps }) => overlaps.map(({ requestedPath }) => requestedPath));
  if (failure.code === "planDrift") paths.push(...failure.snapshotPaths);
  return [...new Set(paths)];
}

export default function ThreadGitArcItem ({
  commandIntent,
  durationMs,
  durationPresentation = "default",
  failureReason,
  operationDetails,
  outcome,
  projectFilePaths,
  projectId,
  projectRootPath,
  receipt,
  statusOutput,
  workspaceRoots,
}: {
  commandIntent: GitArcCommandIntent;
  durationMs: number | null;
  durationPresentation?: "default" | "waited";
  failureReason?: string | null;
  operationDetails?: ReactNode;
  outcome: ThreadCommandExecutionOutcome;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  receipt: GitArcReceipt | null;
  statusOutput?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
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
  const scopeUpdate = commandIntent.action === "plan" || commandIntent.action === "planStart" || commandIntent.action === "claims" || commandIntent.action === "start";
  const fullInventory = Boolean(receipt && (receipt.fullScope === true || (receipt.fullScope === undefined && scopeUpdate)));
  const showUpdateChanges = state === "completed" && scopeUpdate && receipt !== null;
  const inventory = fullInventory && receipt ? [
    { label: "Planned", marker: "planned" as const, paths: receipt.plannedPaths ?? [] },
    { label: "Claimed", marker: "claimed" as const, paths: claimedPaths },
    { label: "Adopted", marker: "claimed" as const, paths: receipt.adoptedPaths ?? [] },
  ] : [];
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
      : commandIntent.action === "release" || commandIntent.action === "restore"
        ? selectedPaths
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
          : commandIntent.action === "restore" ? "Restored" : "Claimed";
  const primaryPathMarker = commandIntent.action === "plan" ? "planned" : "claimed";
  const showNestedClaims = receipt?.fullScope === undefined && commandIntent.action !== "plan" && commandIntent.action !== "planStart" && claimedPaths.length > 0;
  const inventoryLists = inventory.filter((entry) => entry.paths.length).map((entry) => (
    <ThreadClaimedFileList
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

  return (
    <article className="my-1.5 w-full rounded-[0.45rem] border border-[color-mix(in_srgb,var(--text)_12%,transparent)] bg-[color-mix(in_srgb,var(--text)_2%,transparent)] [--fg-bg:color-mix(in_srgb,var(--text)_2%,var(--app-bg-solid))] px-2.5 py-1.5" data-thread-git-arc-card={commandIntent.action}>
      <ThreadDisclosure
        contentClassName={state === "inProgress" ? "mt-1" : "mt-1 border-t border-[color-mix(in_srgb,var(--text)_8%,transparent)]"}
        defaultOpen={commandIntent.action !== "compare" && commandIntent.action !== "diff"}
        leading={<GitArcIcon action={commandIntent.action} size={16} />}
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
            {commandIntent.action === "rescind" || commandIntent.action === "status" ? null : <span className="min-w-0 truncate font-medium text-text">{planName}</span>}
            {commandIntent.action === "rescind" && commandIntent.proposalId ? (
              <span className="font-mono text-[0.86em] text-fg/muted">{commandIntent.proposalId.slice(0, 8)}</span>
            ) : null}
            {ref ? <span className="font-mono text-[0.86em] text-fg/muted">{ref.slice(0, 8)}</span> : null}
            {memberRefs.length > 1 ? <span className="text-[0.86em] text-fg/muted">{memberRefs.length} roots</span> : null}
            {receipt?.phase ? <span>{receipt.phase}</span> : null}
            {receipt?.claimedPathCount !== undefined ? <span>{receipt.claimedPathCount} claimed</span> : null}
            {receipt?.plannedPathCount !== undefined ? <span>{receipt.plannedPathCount} planned</span> : null}
            {receipt?.adoptedPathCount !== undefined && receipt.adoptedPathCount > 0 ? <span>{receipt.adoptedPathCount} adopted</span> : null}
            {receipt?.unchanged ? <span>unchanged</span> : null}
            {durationMs !== null ? durationPresentation === "waited" ? (
              <span className="text-fg/muted" data-thread-git-arc-duration="waited">
                (waited <ThreadDurationText className="inline" durationMs={durationMs} />)
              </span>
            ) : <ThreadDurationText durationMs={durationMs} /> : null}
          </span>
        )}
        summaryClassName="text-[0.82em] leading-[1.45] text-fg/muted"
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
        {commandIntent.action === "status" && state === "completed" && statusOutput !== undefined ? (
          <ThreadGitArcStatusDetails output={statusOutput} projectFilePaths={projectFilePaths} projectId={projectId} projectRootPath={projectRootPath} workspaceRoots={workspaceRoots} />
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
          { label: commandIntent.action === "plan" ? "Removed from plan" : "Released", marker: undefined, paths: receipt.removedClaims ?? [] },
        ] as const).filter((entry) => entry.paths.length).map((entry) => (
          <ThreadClaimedFileList
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
              label="Changed since planning"
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
        {!fullInventory && !showUpdateChanges && adoptPaths.length && !ignoredFailure ? (
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
        {!fullInventory && showNestedClaims ? (
          <ThreadDisclosure
            className="border-t border-[color-mix(in_srgb,var(--text)_8%,transparent)] py-1.5"
            contentClassName="pl-1"
            summary={`${claimedPaths.length} claimed ${claimedPaths.length === 1 ? "file" : "files"}`}
            summaryClassName="text-[0.78em] leading-[1.45] text-fg/muted"
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
