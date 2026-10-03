/*
 * Exports:
 * - expandGitArcClaimPaths: turn folder paths into exact claims on the Git-visible files they contain right now.
 * - expandGitArcMoveClaimPaths: claim both sides of path moves, deriving folder destinations from their source files.
 */
import type WorkbenchGitRepository from "./WorkbenchGitRepository";

function sortedUnique(paths: Iterable<string>) {
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

function filesUnder(files: readonly string[], scope: string) {
  const prefix = `${scope}/`;
  return files.filter((file) => file.startsWith(prefix));
}

/**
 * A folder is claim shorthand, not a lasting folder claim: live claims name files. Paths that are
 * files, missing, or folders without Git-visible files stay exact, so planned new files still work.
 */
export async function expandGitArcClaimPaths(repository: WorkbenchGitRepository, paths: readonly string[]) {
  if (!paths.length) return [];
  const files = await repository.listWorktreePaths(paths);
  return sortedUnique(paths.flatMap((scope) => {
    const contained = filesUnder(files, scope);
    return contained.length ? contained : [scope];
  }));
}

/** Moves are claimed before they run, so a folder destination has no files yet to list. */
export async function expandGitArcMoveClaimPaths(
  repository: WorkbenchGitRepository,
  mappings: readonly { destination: string; source: string }[],
) {
  if (!mappings.length) return [];
  const files = await repository.listWorktreePaths(mappings.map(({ source }) => source));
  return sortedUnique(mappings.flatMap(({ destination, source }) => {
    const contained = filesUnder(files, source);
    if (!contained.length) return [source, destination];
    return contained.flatMap((file) => [file, `${destination}${file.slice(source.length)}`]);
  }));
}
