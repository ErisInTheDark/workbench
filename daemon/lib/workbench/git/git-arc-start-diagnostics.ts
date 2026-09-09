/*
 * Keywords: git, activation, drift, collision, recovery.
 * Exports:
 * - default createGitArcStartDiagnosticError: build a bounded causal arc-start failure from plan, Git, claim, and worktree truth. Keywords: git, arc, start, diagnostics, commits, claims, dirt.
 * - GitArcStartDiagnosticError/GitArcStartDiagnosticDetails: preserve structured plan drift facts for transport and integrated rendering. Keywords: git, arc, start, drift, error.
 * - GitArcCollisionPresentation/formatGitArcCollisionLines: share markdown-like collision presentation between controller preflight and orchestrator race failures. Keywords: git, arc, collision, markdown, diagnostics.
 */
import {
  findGitArcCollisions,
  getGitArcLiveClaimPaths,
  type GitArcCollision,
  type GitArcRegistryEntry,
} from "./GitArcRegistry";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import type { GitArcHarness } from "workbench-shared/workbench/git/git-arc-storage";

const MAX_COMMITS = 8;
const MAX_PATHS = 20;
const MAX_COLLISIONS = 8;

export interface GitArcCollisionPresentation {
  collision: GitArcCollision;
  lifecycle?: string;
  title?: string;
}

interface GitArcStartDiagnosticInput {
  adoptedPaths: string[];
  currentHead: string | null;
  currentTree: string;
  harness: GitArcHarness;
  planBaseCommit: string | null;
  planCheckpointCommit: string;
  planPaths: string[];
  registryEntries: GitArcRegistryEntry[];
  repository: WorkbenchGitRepository;
  snapshotDrift: string[];
  threadId: string;
}

export interface GitArcStartDiagnosticDetails {
  commitChanges: Array<{ changedPaths: string[]; commit: string; subject: string }>;
  collisions: GitArcCollision[];
  dirtyUnclaimedPaths: string[];
  headMovement: "fast-forward" | "incompatible" | "same";
  planCheckpointCommit: string;
  snapshotDrift: string[];
}

export class GitArcStartDiagnosticError extends Error {
  constructor(message: string, readonly details: GitArcStartDiagnosticDetails) {
    super(message);
    this.name = "GitArcStartDiagnosticError";
  }
}

function boundedText(value: string, length = 160) {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").trim().slice(0, length);
}

function code(value: string, length = 160) {
  return `\`${boundedText(value, length).replace(/`/gu, "'")}\``;
}

function appendBoundedPaths(lines: string[], paths: readonly string[], indent: string) {
  paths.slice(0, MAX_PATHS).forEach((filePath) => lines.push(`${indent}- ${code(filePath)}`));
  if (paths.length > MAX_PATHS) lines.push(`${indent}- ... ${paths.length - MAX_PATHS} more`);
}

function liveArc(entry: GitArcRegistryEntry) {
  if (entry.phase === "plan" && entry.retainedArc) return entry.retainedArc;
  return entry;
}

export function formatGitArcCollisionLines(presentations: readonly GitArcCollisionPresentation[]) {
  if (!presentations.length) return ["- none"];
  const lines: string[] = [];
  presentations.slice(0, MAX_COLLISIONS).forEach(({ collision, lifecycle, title }) => {
    const owner = liveArc(collision.entry);
    const identity = `${collision.entry.harness}/${collision.entry.threadId}`;
    const intent = boundedText(owner.intentName);
    const ownerTitle = boundedText(title?.trim() ?? "");
    const label = ownerTitle && ownerTitle !== intent ? `${ownerTitle} (intent: ${intent})` : intent;
    const lifecycleText = lifecycle ? ` [${boundedText(lifecycle, 80)}]` : "";
    lines.push(`- ${code(identity)} ${boundedText(label)}${lifecycleText} (${code(owner.checkpointCommit.slice(0, 8))})`);
    collision.overlaps.slice(0, MAX_PATHS).forEach(({ claimedPath, requestedPath }) => {
      lines.push(`  - claims ${code(claimedPath)} through planned path ${code(requestedPath)}`);
    });
    if (collision.overlaps.length > MAX_PATHS) lines.push(`  - ... ${collision.overlaps.length - MAX_PATHS} more overlaps`);
  });
  if (presentations.length > MAX_COLLISIONS) lines.push(`- ... ${presentations.length - MAX_COLLISIONS} more claiming arcs`);
  return lines;
}

function pathIsCoveredBy(candidate: string, scopePath: string) {
  return candidate === scopePath || candidate.startsWith(`${scopePath}/`);
}

export default async function createGitArcStartDiagnosticError(input: GitArcStartDiagnosticInput) {
  const {
    adoptedPaths,
    currentHead,
    currentTree,
    harness,
    planBaseCommit,
    planCheckpointCommit,
    planPaths,
    registryEntries,
    repository,
    snapshotDrift,
    threadId,
  } = input;
  const collisions = findGitArcCollisions(registryEntries, { harness, threadId }, planPaths);
  const movement = await repository.classifyHeadMovement(planBaseCommit, snapshotDrift, planCheckpointCommit, currentHead);
  const committedDrift = movement.kind === "fast-forward" ? movement.changedPaths : [];
  const commitChanges = movement.kind === "fast-forward"
    ? await repository.listFirstParentCommitPathChanges(planBaseCommit, currentHead, committedDrift)
    : [];
  const dirtyPaths = await repository.listChangedPaths(currentHead, currentTree, planPaths);
  const liveClaimedPaths = registryEntries.flatMap((entry) => getGitArcLiveClaimPaths(entry));
  const dirtyUnclaimed = dirtyPaths.filter((dirtyPath) => (
    snapshotDrift.includes(dirtyPath)
    && !liveClaimedPaths.some((claimedPath) => pathIsCoveredBy(dirtyPath, claimedPath) || pathIsCoveredBy(claimedPath, dirtyPath))
  ));

  const hasDrift = snapshotDrift.length > 0 || movement.kind === "incompatible";
  const lines = [
    collisions.length ? "Arc start blocked by sibling claims." : "Arc start blocked because the stored plan no longer matches the current workspace.",
    "",
    "New commits affecting planned files:",
  ];
  if (movement.kind === "incompatible") {
    lines.push(`- HEAD moved incompatibly from ${code(planBaseCommit?.slice(0, 8) ?? "unborn")} to ${code(currentHead?.slice(0, 8) ?? "unborn")}`);
  } else if (!commitChanges.length) {
    lines.push("- none");
  } else {
    commitChanges.slice(0, MAX_COMMITS).forEach(({ changedPaths, commit, subject }) => {
      lines.push(`- ${code(commit.slice(0, 8))} ${boundedText(subject) || "(no subject)"}`);
      appendBoundedPaths(lines, changedPaths, "  ");
    });
    if (commitChanges.length > MAX_COMMITS) lines.push(`- ... ${commitChanges.length - MAX_COMMITS} more affecting commits`);
  }
  lines.push("", "Planned paths claimed by other arcs:");
  lines.push(...formatGitArcCollisionLines(collisions.map((collision) => ({ collision }))));
  lines.push("", "Dirty unclaimed planned files:");
  if (!dirtyUnclaimed.length) {
    lines.push("- none");
  } else {
    dirtyUnclaimed.slice(0, MAX_PATHS).forEach((filePath) => {
      const alreadyAdopted = adoptedPaths.some((adoptedPath) => pathIsCoveredBy(filePath, adoptedPath));
      lines.push(`- ${code(filePath)}${alreadyAdopted ? " (already adopted by this plan)" : ""}`);
    });
    if (dirtyUnclaimed.length > MAX_PATHS) lines.push(`- ... ${dirtyUnclaimed.length - MAX_PATHS} more`);
  }
  const diagnosticPaths = snapshotDrift.slice(0, MAX_PATHS).map((filePath) => boundedText(filePath));
  if (hasDrift && !collisions.length) lines.push(
    "",
    "Only intentional dirty unclaimed paths can be adopted. Committed paths remain ordinary scope.",
    `Inspect git_arc_diff ${JSON.stringify({ paths: diagnosticPaths, ref: planCheckpointCommit })}.`,
    "Keep approval if still applicable. Refresh and activate with git_plan_start using inherit: true.",
  );
  if (collisions.length) lines.push("Call git_arc_wait. Do not republish while sibling claims intersect. Waiting rechecks the original baseline after claims clear.");
  if (!collisions.length && snapshotDrift.length > MAX_PATHS) {
    lines.push(`${snapshotDrift.length - MAX_PATHS} more affected paths were omitted. Run the scoped diff again for those paths if needed.`);
  }
  return new GitArcStartDiagnosticError(lines.join("\n"), {
    commitChanges,
    collisions,
    dirtyUnclaimedPaths: dirtyUnclaimed,
    headMovement: movement.kind,
    planCheckpointCommit,
    snapshotDrift: diagnosticPaths,
  });
}
