/*
 * Exports:
 * - absorbMachineBaseline: record requested paths as known, then fast-forward a machine worktree's HEAD over the disk
 *   content of requested paths no arc scopes.
 * A machine repository only knows files arcs have touched, so its HEAD is "the machine as last seen". Before scope is
 * published or acquired, unowned requested paths take their current disk content as baseline: claiming an existing
 * file then diffs only the agent's edit, and outside changes never masquerade as unclaimed dirt. Paths any arc scopes
 * (live claims, guards, retained arcs, saved stashes) and adopted paths are never absorbed, so no proposal or owned
 * work moves with HEAD.
 */
import GitArcPathSet from "workbench-shared/workbench/git/GitArcPathSet";

import type { GitArcRegistryEntry } from "./GitArcRegistry";
import { recordMachineKnownPaths } from "./machine-git-worktrees";
import type WorkbenchGitRepository from "./WorkbenchGitRepository";

const BASELINE_MESSAGE = "machine baseline";

function scopedPaths(entry: GitArcRegistryEntry) {
  const stashed = entry.savedStash?.paths ?? [];
  if (entry.phase === "resolved") return stashed;
  const owned = entry.phase === "plan" ? entry.retainedArc?.claimedPaths ?? [] : entry.claimedPaths;
  return [...owned, ...entry.activeClaimedPaths ?? [], ...stashed];
}

/** Returns the absorbed repository paths; HEAD moves only when at least one differed. */
export async function absorbMachineBaseline(
  repository: WorkbenchGitRepository,
  entries: readonly GitArcRegistryEntry[],
  request: { paths: readonly string[]; adoptPaths: readonly string[] },
) {
  if (!repository.machine || !request.paths.length) return [];
  await recordMachineKnownPaths(repository.root, [...request.paths, ...request.adoptPaths]);
  const head = await repository.headOrNull();
  const owned = new GitArcPathSet(entries.flatMap(scopedPaths));
  const adopted = new GitArcPathSet(request.adoptPaths);
  const changed = await repository.listWorktreeChangedPaths(head, [...request.paths]);
  const absorbed = changed.filter(candidate => !owned.covers(candidate) && !adopted.covers(candidate));
  if (!absorbed.length) return [];
  const tree = await repository.writeScopedWorktreeTree(absorbed, head);
  const commit = await repository.createCommitFromTree(tree, head, `${BASELINE_MESSAGE}\n`);
  await repository.updateRefs([{ ref: await repository.symbolicHead() ?? "HEAD", newValue: commit, oldValue: head }]);
  // The real index only serves as a stat cache and staged-deletion source; keep it equal to HEAD for absorbed paths.
  await repository.resetMixedPaths(commit, absorbed);
  return absorbed;
}
