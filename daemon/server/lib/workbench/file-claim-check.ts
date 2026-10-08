/*
 * Exports:
 * - WorkbenchFileClaimCheckResult: agent file-change admission, naming unclaimed paths and paths held by unsealed pending proposals.
 * - describePendingProposalDenial: agent-facing denial for paths held by the caller's unsealed pending proposals.
 */

export interface WorkbenchFileClaimCheckResult {
  allowed: boolean;
  /** Requested paths that no live claim covers. */
  uncoveredPaths: string[];
  /**
   * Claimed requested paths inside the caller's unsealed pending proposals, per proposal. Optional so contracts declared
   * in destructive harness files stay assignable without editing them.
   */
  pendingProposals?: Array<{ paths: string[]; proposalId: string }>;
}

export function describePendingProposalDenial(pendingProposals: WorkbenchFileClaimCheckResult["pendingProposals"] = []) {
  const held = pendingProposals.map(({ paths, proposalId }) => `${proposalId} holds ${paths.join(", ")}`).join("; ");
  return `Pending proposal files are frozen: ${held}. Stack the proposal to build on it, or rescind it, change the files, then propose with amend: <proposal-id> to revive it.`;
}
