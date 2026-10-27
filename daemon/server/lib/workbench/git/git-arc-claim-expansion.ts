/*
 * Exports:
 * - listGitArcScopeFiles: Git-visible files beneath each scope right now, with links and junctions as leaf entries.
 * - expandGitArcClaimPaths: turn folder paths into exact claims on the Git-visible files they contain right now.
 */
import GitArcPathSet from "workbench-shared/workbench/git/GitArcPathSet";
import type WorkbenchGitRepository from "./WorkbenchGitRepository";
import WorktreeLinks from "./worktree-links";

function sortedUnique(paths: Iterable<string>) {
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

/**
 * Files strictly beneath each scope, read through Git. A link scope holds nothing, and anything Git reached through a
 * link below a scope collapses to that link, so callers never claim or demand claims on what a link points at.
 */
export async function listGitArcScopeFiles(repository: WorkbenchGitRepository, scopes: readonly string[]) {
  const links = new WorktreeLinks(repository.root);
  const linked = await Promise.all(scopes.map(async (scope) => await links.isLink(scope)));
  const walked = scopes.filter((_scope, index) => !linked[index]);
  const files = walked.length ? await repository.listWorktreePaths(walked) : [];
  const wanted = new GitArcPathSet(walked);
  const under = new Map<string, Set<string>>();
  await Promise.all(files.map(async (file) => {
    for (const scope of wanted.holding(file)) {
      const entry = await links.outermostLink(file, scope.split("/").length) ?? file;
      const contained = under.get(scope);
      if (contained) contained.add(entry);
      else under.set(scope, new Set([entry]));
    }
  }));
  return (scope: string) => sortedUnique(under.get(scope) ?? []);
}

/**
 * A folder is claim shorthand, not a lasting folder claim: live claims name files. Paths that are
 * files, links, missing, or folders without Git-visible files stay exact, so planned new files still work.
 */
export async function expandGitArcClaimPaths(repository: WorkbenchGitRepository, paths: readonly string[]) {
  if (!paths.length) return [];
  const filesUnder = await listGitArcScopeFiles(repository, paths);
  return sortedUnique(paths.flatMap((scope) => {
    const contained = filesUnder(scope);
    return contained.length ? contained : [scope];
  }));
}
