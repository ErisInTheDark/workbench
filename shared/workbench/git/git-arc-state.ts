/*
 * Exports:
 * - GitArcClaimChanges: literal, normalised additions, removals and explicit adoptions.
 * - GitArcPlanningDrift: previous snapshot and changed retained paths, before refresh.
 * - GitArcScopeState: read-only planned and live scope facts.
 * - GitArcMutationResult: active or resolved publication and acceptance facts.
 * - applyGitClaimChanges: validate subtraction of exact entries or folders containing them, and produce a minimal final scope.
 */
import GitArcPathSet from "./GitArcPathSet";
import { GitArcRejectionError } from "./git-arc-rejections";

export interface GitArcClaimChanges {
  inherit?: boolean;
  addPaths?: string[];
  removePaths?: string[];
  adoptPaths?: string[];
}

export interface GitArcPlanningDrift {
  previousRef: string;
  paths: string[];
}

export interface GitArcScopeState {
  phase: "plan" | "active" | "stashed" | "resolved";
  checkpointCommit: string;
  intentName: string;
  plannedPaths: string[];
  claimedPaths: string[];
  stashedPaths?: string[];
  adoptedPaths: string[];
  proposals: Array<{ proposalId: string; status: "committed" | "proposed" }>;
  repoRoot: string;
}

export interface GitArcMutationResult {
  checkpointCommit: string;
  checkpointRef: string;
  intentName: string | null;
  kind: "arc" | "noop";
  noOp?: true;
  phase: "active" | "stashed" | "resolved";
  scopePaths: string[];
  addedClaims: string[];
  removedClaims: string[];
  adoptedPaths: string[];
  acceptedProposals: Array<{ proposalId: string; commitSha: string; headSha: string }>;
  unchanged: boolean;
  repoRoot: string;
  skippedIgnoredPaths: string[];
  stashedPaths?: string[];
  conflictedPaths?: string[];
}

export function applyGitClaimChanges(existing: readonly string[], changes: GitArcClaimChanges) {
  const additions = changes.addPaths ?? [];
  const removals = changes.removePaths ?? [];
  const adoptions = changes.adoptPaths ?? [];
  if (removals.length && !changes.inherit) throw new GitArcRejectionError({ reason: "inheritanceRequired" }, "Removing claims requires inheritance.");
  const inherited = changes.inherit ? existing : [];
  // A removed folder drops the file claims it was shorthand for.
  const removed = new GitArcPathSet(removals);
  const inheritedPaths = new GitArcPathSet(inherited);
  const unknown = removals.filter((removal) => !inheritedPaths.has(removal) && !inheritedPaths.contains(removal));
  if (unknown.length) throw new GitArcRejectionError({ reason: "unclaimedRemoval", paths: unknown }, `Removed paths must match inherited entries or folders containing them: ${unknown.join(", ")}`);
  const contradictory = [...additions, ...adoptions].filter((candidate) => removed.has(candidate));
  if (contradictory.length) throw new GitArcRejectionError({ reason: "conflictingClaimOperations", paths: [...new Set(contradictory)] }, `Conflicting claim operations: ${[...new Set(contradictory)].join(", ")}`);
  const candidates = [...new Set([...inherited.filter((candidate) => !removed.covers(candidate)), ...additions, ...adoptions])].sort();
  const scope = new GitArcPathSet(candidates);
  return candidates.filter((candidate) => !scope.within(candidate));
}
