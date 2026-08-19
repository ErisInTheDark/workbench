/*
 * Exports:
 * - default ThreadGitArcItem: render one compact dedicated Git arc lifecycle card with claims, operation details, and failures. Keywords: thread, git, arc, card, lifecycle.
 */
import type { ReactNode } from "react";

import type { WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import type { GitArcReceipt } from "../../../lib/workbench/git/git-arc-receipts";
import type { GitArcCommandIntent, ThreadCommandExecutionOutcome } from "../../../lib/workbench/thread/thread-command-matchers";
import GitArcIcon from "./GitArcIcon";
import ThreadClaimedFileList from "./ThreadClaimedFileList";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadDurationText from "./ThreadDurationText";
import ThreadGitArcMoveList from "./ThreadGitArcMoveList";

const ACTION_LABELS = {
  add: { completed: "Extended", failed: "Failed to extend", inProgress: "Extending" },
  adopt: { completed: "Adopted workspace changes", failed: "Failed to adopt workspace changes", inProgress: "Adopting workspace changes" },
  compare: { completed: "Compared", failed: "Failed to compare", inProgress: "Comparing" },
  continue: { completed: "Continued", failed: "Failed to continue", inProgress: "Continuing" },
  diff: { completed: "Diffed", failed: "Failed to diff", inProgress: "Diffing" },
  mv: { completed: "Moved", failed: "Failed to move", inProgress: "Moving" },
  plan: { completed: "Planned", failed: "Failed to plan", inProgress: "Planning" },
  remove: { completed: "Reduced", failed: "Failed to reduce", inProgress: "Reducing" },
  restore: { completed: "Restored", failed: "Failed to restore", inProgress: "Restoring" },
  start: { completed: "Started", failed: "Failed to start", inProgress: "Starting" },
} as const;

function actionState(outcome: ThreadCommandExecutionOutcome) {
  return outcome === "completed" ? "completed" : outcome === "inProgress" ? "inProgress" : "failed";
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
  const movePreview = commandIntent.action === "mv" && (
    receipt?.mode === "preview"
    || (!receipt && commandIntent.move?.kind === "regex" && !commandIntent.move.confirm)
  );
  const labels = movePreview
    ? { completed: "Previewed", failed: "Failed to preview moves", inProgress: "Previewing moves" }
    : ACTION_LABELS[commandIntent.action];
  const planName = receipt?.intentName ?? commandIntent.intentName ?? "Git arc";
  const ref = receipt?.ref ?? commandIntent.ref;
  const claimedPaths = receipt?.claimedPaths ?? [];
  const selectedPaths = receipt?.selectedPaths ?? commandIntent.paths;
  const moveMappings = commandIntent.action === "mv" ? receipt?.mappings ?? attemptedMoveMappings(commandIntent) : [];
  const primaryPaths = commandIntent.action === "plan"
    ? claimedPaths.length ? claimedPaths : selectedPaths
    : commandIntent.action === "add" || commandIntent.action === "adopt" || commandIntent.action === "remove" || commandIntent.action === "restore"
      ? selectedPaths
      : [];
  const primaryPathLabel = state === "failed"
    ? commandIntent.action === "plan" || commandIntent.action === "add" || commandIntent.action === "adopt"
      ? "Attempted to claim"
      : commandIntent.action === "remove" ? "Attempted to remove" : "Attempted to restore"
    : commandIntent.action === "remove" ? "Removed" : commandIntent.action === "restore" ? "Restored" : "Claimed";
  const showNestedClaims = commandIntent.action !== "plan" && claimedPaths.length > 0;
  const normalizedFailure = failureReason?.trim() || (state === "failed" ? "This Git arc action did not complete." : null);

  return (
    <article className="my-1.5 w-full rounded-[0.45rem] border border-[color-mix(in_srgb,var(--text)_12%,transparent)] bg-[color-mix(in_srgb,var(--text)_2%,transparent)] px-2.5 py-1.5" data-thread-git-arc-card={commandIntent.action}>
      <ThreadDisclosure
        contentClassName="mt-1 border-t border-[color-mix(in_srgb,var(--text)_8%,transparent)]"
        defaultOpen
        leading={<GitArcIcon action={commandIntent.action} />}
        leadingLabel={`${commandIntent.action} Git arc`}
        summary={(
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className={state === "failed" ? "text-[color:var(--danger)]" : "text-text"}>
              {commandIntent.action === "mv" && state === "completed"
                ? movePreview
                  ? `Previewed ${moveMappings.length} ${moveMappings.length === 1 ? "move" : "moves"}`
                  : `Moved ${moveMappings.length} ${moveMappings.length === 1 ? "path" : "paths"}`
                : labels[state]}
            </span>
            <span className="min-w-0 truncate font-medium text-text">{planName}</span>
            {ref ? <span className="font-mono text-[0.86em] text-muted">{ref.slice(0, 8)}</span> : null}
            {durationMs !== null ? <ThreadDurationText durationMs={durationMs} /> : null}
          </span>
        )}
        summaryClassName="text-[0.82em] leading-[1.45] text-muted"
      >
        {commandIntent.action === "mv" ? (
          <ThreadGitArcMoveList
            mappings={moveMappings}
            projectId={projectId}
            projectRootPath={projectRootPath}
            workspaceRoots={workspaceRoots}
          />
        ) : null}
        {operationDetails ? <div>{operationDetails}</div> : null}
        {primaryPaths.length ? (
          <ThreadClaimedFileList
            label={primaryPathLabel}
            paths={primaryPaths}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
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
      {normalizedFailure ? <p className="m-0 mt-1 pl-[2.55rem] text-[0.76em] leading-[1.45] text-[color:var(--danger)]">{normalizedFailure}</p> : null}
    </article>
  );
}
