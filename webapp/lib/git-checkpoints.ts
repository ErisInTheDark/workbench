/*
 * Exports:
 * - createGitPlan/addToGitArc/removeFromGitArc: create one scoped plan baseline or update its claimed arc paths. Keywords: git, checkpoint, plan, arc.
 * - compareGitCheckpoint/diffGitCheckpoint: compatibility facade for path-scoped checkpoint inspection. Keywords: git, checkpoint, compare, diff.
 * - createGitCheckpointProposal/readGitCheckpointProposal/commitGitCheckpointProposal: compatibility facade for durable commit proposals. Keywords: git, checkpoint, proposal, commit.
 * - readGitCheckpointDiffArtifact: preserve historical checkpoint diff transcript artifacts. Keywords: git, checkpoint, diff, artifact.
 * - restoreGitCheckpoint/restoreGitCheckpointPaths: preserve full and path-limited checkpoint restore behavior. Keywords: git, checkpoint, restore.
 */
import WorkbenchGitCheckpointController from "./workbench/git/WorkbenchGitCheckpointController";

const controller = new WorkbenchGitCheckpointController();

export const createGitPlan = controller.createPlan.bind(controller);
export const addToGitArc = controller.addToArc.bind(controller);
export const removeFromGitArc = controller.removeFromArc.bind(controller);
export const compareGitCheckpoint = controller.compare.bind(controller);
export const diffGitCheckpoint = controller.diff.bind(controller);
export const createGitCheckpointProposal = controller.createProposal.bind(controller);
export const readGitCheckpointProposal = controller.getProposal.bind(controller);
export const commitGitCheckpointProposal = controller.commitProposal.bind(controller);

export async function readGitCheckpointDiffArtifact({
  diffArtifactId,
  threadId,
}: {
  diffArtifactId: string;
  threadId: string;
}) {
  return await controller.readLegacyDiffArtifact({ artifactId: diffArtifactId, threadId });
}

export async function restoreGitCheckpoint({
  checkpointCommit,
  confirmRestore,
  cwd,
  threadId,
}: {
  checkpointCommit: string;
  confirmRestore: boolean;
  cwd: string;
  threadId: string;
}) {
  return await controller.restore({ checkpointCommit, confirmRestore, cwd, threadId });
}

export async function restoreGitCheckpointPaths({
  checkpointCommit,
  cwd,
  filePaths,
  threadId,
}: {
  checkpointCommit: string;
  cwd: string;
  filePaths: string[];
  threadId: string;
}) {
  return await controller.restore({ checkpointCommit, cwd, paths: filePaths, threadId });
}
