/*
 * Exports:
 * - WorkbenchFileClaimCheckResult: agent file-change admission, naming unclaimed paths, paths held by unsealed pending proposals,
 *   and a workflow mode that denies the change.
 * - describePendingProposalDenial: agent-facing denial for paths held by the caller's unsealed pending proposals.
 */

export interface WorkbenchFileClaimCheckResult {
  allowed: boolean;
  /** Requested paths that no live claim covers. */
  uncoveredPaths: string[];
  /** Requested Git-visible paths a live claim covers; gitignored and scratch paths are neither claimed nor uncovered. */
  claimedPaths?: string[];
  /**
   * Claimed requested paths inside the caller's unsealed pending proposals, per proposal. Optional so contracts declared
   * in destructive harness files stay assignable without editing them.
   */
  pendingProposals?: Array<{ paths: string[]; proposalId: string }>;
  /** Why the caller's current workflow mode denies the change; takes precedence over claim denials. */
  modeDenial?: string;
}

export function describePendingProposalDenial(pendingProposals: WorkbenchFileClaimCheckResult["pendingProposals"] = []) {
  const held = pendingProposals.map(({ paths, proposalId }) => `${proposalId} holds ${paths.join(", ")}`).join("; ");
  return `Pending proposal files are frozen: ${held}. Stack the proposal to build on it, or rescind it, change the files, then propose with amend: <proposal-id> to revive it.`;
}
