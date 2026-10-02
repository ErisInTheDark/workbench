/*
 * Exports:
 * - RipgrepCandidate: one searchable file with its cwd-relative display path and absolute path.
 * - RipgrepCandidates: sorted candidate files, searched-root count, and per-root warnings.
 * - collectRipgrepCandidates: enumerate files for a query; gitignore applies even to explicit paths unless --no-ignore.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import type { RipgrepQuery } from "./ripgrep-arguments";
import { createRipgrepPathFilter } from "./ripgrep-globs";

export interface RipgrepCandidate {
  displayPath: string;
  absolutePath: string;
}

export interface RipgrepCandidates {
  files: RipgrepCandidate[];
  searchedRoots: number;
  warnings: string[];
}

const SKIPPED_ACCESS_CODES = new Set(["EACCES", "EPERM", "EBUSY"]);

function errorCode(error: unknown) {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function displayPathFor(cwd: string, absolutePath: string) {
  const relative = path.relative(cwd, absolutePath);
  const display = path.isAbsolute(relative) ? absolutePath : relative;
  return display.replace(/\\/gu, "/") || ".";
}

/** Lists git-visible files under `directory`, relative to it; null when the directory is outside any repository. */
function listGitVisibleFiles(directory: string, pathspecs: readonly string[], signal: AbortSignal) {
  return new Promise<string[] | null>((resolve, reject) => {
    execFile("git", [
      "--literal-pathspecs", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...pathspecs,
    ], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      maxBuffer: 512 * 1024 * 1024,
      signal,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve([...new Set(stdout.split("\0").filter(Boolean))]);
        return;
      }
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      if (/not a git repository/iu.test(stderr)) {
        resolve(null);
        return;
      }
      reject(new Error(`git ls-files failed in ${directory}: ${(stderr || error.message).trim().slice(0, 500)}`));
    });
  });
}

async function walkDirectory(root: string, options: {
  hidden: boolean;
  maxDepth: number | null;
  skipNodeModules: boolean;
  warnings: string[];
  signal: AbortSignal;
}) {
  const files: string[] = [];
  const pending: Array<{ relative: string; depth: number }> = [{ relative: "", depth: 0 }];
  while (pending.length) {
    options.signal.throwIfAborted();
    const { relative, depth } = pending.pop()!;
    let entries;
    try {
      entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
    } catch (error) {
      if (!SKIPPED_ACCESS_CODES.has(errorCode(error) ?? "")) throw error;
      options.warnings.push(`wb rg: ${path.join(root, relative)}: ${errorCode(error)} (directory skipped)`);
      continue;
    }
    const childDepth = depth + 1;
    if (options.maxDepth !== null && childDepth > options.maxDepth) continue;
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (!options.hidden && entry.name.startsWith(".")) continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === ".git" || (options.skipNodeModules && entry.name === "node_modules")) continue;
        pending.push({ relative: child, depth: childDepth });
      } else if (entry.isFile()) {
        files.push(child);
      }
    }
  }
  return files;
}

export async function collectRipgrepCandidates(query: RipgrepQuery, cwd: string, signal: AbortSignal): Promise<RipgrepCandidates> {
  const roots = query.paths.length ? query.paths : ["."];
  const passesFilters = createRipgrepPathFilter(query);
  const files = new Map<string, RipgrepCandidate>();
  const warnings: string[] = [];
  let searchedRoots = 0;
  for (const root of roots) {
    signal.throwIfAborted();
    const absoluteRoot = path.resolve(cwd, root);
    let stats;
    try {
      stats = await fs.stat(absoluteRoot);
    } catch (error) {
      if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") throw error;
      warnings.push(`wb rg: ${root}: path not found`);
      continue;
    }
    searchedRoots += 1;
    const isDirectory = stats.isDirectory();
    const directory = isDirectory ? absoluteRoot : path.dirname(absoluteRoot);
    let relatives = query.noIgnore
      ? null
      : await listGitVisibleFiles(directory, isDirectory ? [] : [path.basename(absoluteRoot)], signal);
    if (relatives === null) {
      relatives = isDirectory
        ? await walkDirectory(absoluteRoot, {
          hidden: query.hidden,
          maxDepth: query.maxDepth,
          skipNodeModules: !query.noIgnore,
          warnings,
          signal,
        })
        : [path.basename(absoluteRoot)];
    } else if (!relatives.length) {
      warnings.push(isDirectory
        ? `wb rg: ${root}: no git-visible files (gitignored or empty); pass --no-ignore to search it`
        : `wb rg: ${root}: skipped because it is gitignored; pass --no-ignore to search it`);
    }
    for (const relative of relatives) {
      // Explicitly named files bypass glob and type filters, as in rg.
      if (isDirectory && query.maxDepth !== null && relative.split("/").length > query.maxDepth) continue;
      const absolutePath = path.join(directory, relative);
      const displayPath = displayPathFor(cwd, absolutePath);
      if (isDirectory && !passesFilters(displayPath)) continue;
      files.set(absolutePath, { displayPath, absolutePath });
    }
  }
  return {
    files: [...files.values()].sort((left, right) => left.displayPath < right.displayPath ? -1 : left.displayPath > right.displayPath ? 1 : 0),
    searchedRoots,
    warnings,
  };
}
