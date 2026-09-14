/*
 * Exports:
 * - collectGitArcDrift: share scoped content counts, ancestry classification and intersecting commits.
 */
import type { GitArcDriftComparison } from "workbench-shared/workbench/git/git-arc-failures";
import type WorkbenchGitRepository from "./WorkbenchGitRepository";

export async function collectGitArcDrift({
  repository, head, tree, baseline, baseHead, paths, commitPaths = paths, netCommittedOnly = false,
}: {
  repository: WorkbenchGitRepository;
  head: string | null;
  tree: string;
  baseline: string;
  baseHead: string | null;
  paths: string[];
  commitPaths?: string[];
  netCommittedOnly?: boolean;
}) {
  const changes = paths.length ? await repository.buildFileChanges(baseline, tree, paths) : [];
  const comparison: GitArcDriftComparison = changes.map(change => ({
    additions: change.additions, deletions: change.deletions, path: change.path,
    binary: /^GIT binary patch$/mu.test(change.diff), kind: change.kind.type,
  }));
  const movement = await repository.classifyHeadMovement(baseHead, commitPaths, baseline, head);
  const commits = movement.kind === "fast-forward"
    ? await repository.listFirstParentCommitPathChanges(baseHead, head, netCommittedOnly ? movement.changedPaths : commitPaths)
    : [];
  return { comparison, commits, headMovement: movement.kind };
}
