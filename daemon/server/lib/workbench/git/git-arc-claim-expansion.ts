/*
 * Exports:
 * - listGitArcScopeFiles: Git-visible files beneath each scope right now, with links and junctions as leaf entries.
 * - expandGitArcClaimPaths: turn folder paths into exact claims on the Git-visible files they contain right now.
 */
import { lstat } from "node:fs/promises";

import GitArcPathSet from "workbench-shared/workbench/git/GitArcPathSet";
import type WorkbenchGitRepository from "./WorkbenchGitRepository";

function sortedUnique(paths: Iterable<string>) {
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

/** Node reports Windows junctions as symbolic links; Git for Windows walks them as plain directories. */
function linkDetector(repository: WorkbenchGitRepository) {
  const known = new Map<string, Promise<boolean>>();
  return (relative: string) => {
    let isLink = known.get(relative);
    if (!isLink) {
      isLink = lstat(repository.resolvePath(relative)).then((stats) => stats.isSymbolicLink(), () => false);
      known.set(relative, isLink);
    }
    return isLink;
  };
}

/** The outermost link strictly between `scope` and `file`, else the file itself. */
async function leafEntry(file: string, scope: string, isLink: (relative: string) => Promise<boolean>) {
  const segments = file.split("/");
  for (let length = scope.split("/").length + 1; length < segments.length; length += 1) {
    const ancestor = segments.slice(0, length).join("/");
    if (await isLink(ancestor)) return ancestor;
  }
  return file;
}

/**
 * Files strictly beneath each scope, read through Git. A link scope holds nothing, and anything Git reached through a
 * link below a scope collapses to that link, so callers never claim or demand claims on what a link points at.
 */
export async function listGitArcScopeFiles(repository: WorkbenchGitRepository, scopes: readonly string[]) {
  const isLink = linkDetector(repository);
  const linked = await Promise.all(scopes.map(async (scope) => await isLink(scope)));
  const walked = scopes.filter((_scope, index) => !linked[index]);
  const files = walked.length ? await repository.listWorktreePaths(walked) : [];
  const wanted = new GitArcPathSet(walked);
  const under = new Map<string, Set<string>>();
  await Promise.all(files.map(async (file) => {
    for (const scope of wanted.holding(file)) {
      const entry = await leafEntry(file, scope, isLink);
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
