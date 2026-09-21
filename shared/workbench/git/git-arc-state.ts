/*
 * Exports:
 * - GitArcClaimChanges: literal, normalised additions, removals and explicit adoptions.
 * - GitArcPlanningDrift: previous snapshot and changed retained paths, before refresh.
 * - GitArcScopeState: read-only planned and live scope facts.
 * - GitArcMutationResult: active or resolved publication and acceptance facts.
 * - applyGitClaimChanges: validate exact subtraction and produce a minimal final scope.
 */
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
  const unknown = removals.filter((candidate) => !inherited.includes(candidate));
  if (unknown.length) throw new GitArcRejectionError({ reason: "unclaimedRemoval", paths: unknown }, `Removed paths must exactly match inherited entries: ${unknown.join(", ")}`);
  const contradictory = [...additions, ...adoptions].filter((candidate) => removals.includes(candidate));
  contradictory.push(...adoptions.filter((candidate) => additions.includes(candidate)));
  if (contradictory.length) throw new GitArcRejectionError({ reason: "conflictingClaimOperations", paths: [...new Set(contradictory)] }, `Conflicting claim operations: ${[...new Set(contradictory)].join(", ")}`);
  const candidates = [...new Set([...inherited.filter((candidate) => !removals.includes(candidate)), ...additions, ...adoptions])].sort();
  return candidates.filter((candidate) => !candidates.some((other) => candidate !== other && candidate.startsWith(`${other}/`)));
}
