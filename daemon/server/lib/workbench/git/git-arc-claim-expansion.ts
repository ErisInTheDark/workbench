/*
 * Exports:
 * - expandGitArcClaimPaths: turn folder paths into exact claims on the Git-visible files they contain right now.
 */
import GitArcPathSet from "workbench-shared/workbench/git/GitArcPathSet";
import type WorkbenchGitRepository from "./WorkbenchGitRepository";

function sortedUnique(paths: Iterable<string>) {
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

/** Files strictly beneath each scope, in `files` order, from one pass over each file's ancestors. */
function filesUnderScopes(files: readonly string[], scopes: readonly string[]) {
  const wanted = new GitArcPathSet(scopes);
  const under = new Map<string, string[]>();
  for (const file of files) {
    for (const scope of wanted.holding(file)) {
      const contained = under.get(scope);
      if (contained) contained.push(file);
      else under.set(scope, [file]);
    }
  }
  return (scope: string) => under.get(scope) ?? [];
}

/**
 * A folder is claim shorthand, not a lasting folder claim: live claims name files. Paths that are
 * files, missing, or folders without Git-visible files stay exact, so planned new files still work.
 */
export async function expandGitArcClaimPaths(repository: WorkbenchGitRepository, paths: readonly string[]) {
  if (!paths.length) return [];
  const filesUnder = filesUnderScopes(await repository.listWorktreePaths(paths), paths);
  return sortedUnique(paths.flatMap((scope) => {
    const contained = filesUnder(scope);
    return contained.length ? contained : [scope];
  }));
}
