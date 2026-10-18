/*
 * Exports:
 * - default freshCommitProposal: the fresh-commit form of a content amend proposal, over its live base and paths with its fresh message.
 */
import { GitArcRejectionError } from "workbench-shared/workbench/git/git-arc-rejections";
import type { ProposalMetadata } from "workbench-shared/workbench/git/git-arc-storage";
import type { StoredProposal } from "./GitCheckpointStore";
import type WorkbenchGitRepository from "./WorkbenchGitRepository";

/** `sourceTree` supplies live path content; it defaults to the proposal's own tree. */
export default async function freshCommitProposal(
  repository: WorkbenchGitRepository,
  proposal: Pick<StoredProposal, "metadata" | "tree">,
  sourceTree = proposal.tree,
): Promise<{ metadata: ProposalMetadata; tree: string }> {
  // Recorded totals measured the amend; the proposal commit writer records fresh ones.
  const { changes: _amendTotals, freshCommitMessage, ...metadata } = proposal.metadata;
  if (metadata.messageOnly) {
    throw new GitArcRejectionError({ reason: "messageAmendCannotCommitFresh" }, "Message-only amendment proposals cannot be committed fresh.");
  }
  if (!freshCommitMessage) {
    throw new GitArcRejectionError({ reason: "missingFreshCommitChoice" }, "This amend proposal does not include a fresh commit choice.");
  }
  return {
    metadata: {
      ...metadata,
      amendTargetSha: null,
      baseCommit: metadata.liveBaseCommit,
      description: freshCommitMessage.description,
      mode: "commit",
      paths: metadata.livePaths,
      title: freshCommitMessage.title,
    },
    tree: await repository.writeTreeWithPathsFromSource(metadata.liveBaseCommit, sourceTree, metadata.livePaths),
  };
}
