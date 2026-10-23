/*
 * Exports:
 * - RipgrepCandidate: one searchable file with its cwd-relative display path and absolute path.
 * - RipgrepCandidates: sorted candidate files, searched-root count, and per-root warnings.
 * - RipgrepHydrate: optional bulk fetch for lazily loaded roots, such as virtual repository mounts.
 * - RipgrepFileBudgetExceeded: a query enumerated more files than --max-files allows; its message advises how to narrow it.
 * - prefetchRipgrepRoots: hydrate each existing query root, keeping each failed root's warning.
 * - collectRipgrepCandidates: enumerate files for a query within its file budget; gitignore applies even to explicit paths
 *   unless --no-ignore, and walks skip directories under which no file could pass the globs.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import type { RipgrepQuery } from "workbench-shared/workbench/ripgrep/ripgrep-arguments";
import {
  createRipgrepDirectoryPruner,
  createRipgrepPathFilter,
  type RipgrepDirectoryPruner,
} from "workbench-shared/workbench/ripgrep/ripgrep-globs";

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
const LARGEST_NAMED = 3;

/** A query enumerated more files than its --max-files allows; the message is the caller's advice. */
export class RipgrepFileBudgetExceeded extends Error {}

/** Counts files a query enumerates across its roots, filed by top directory so the advice can name what to exclude. */
class FileBudget {
  #seen = 0;
  readonly #byDirectory = new Map<string, number>();

  constructor(private readonly limit: number) {}

  /** Throws once past the limit; `relative` is beneath the root shown as `displayRoot`. */
  count(displayRoot: string, relative: string) {
    if (!this.limit) return;
    this.#seen += 1;
    const slash = relative.indexOf("/");
    if (slash > 0) {
      const top = displayRoot === "." ? relative.slice(0, slash) : `${displayRoot}/${relative.slice(0, slash)}`;
      this.#byDirectory.set(top, (this.#byDirectory.get(top) ?? 0) + 1);
    }
    if (this.#seen > this.limit) throw new RipgrepFileBudgetExceeded(this.#advice());
  }

  #advice() {
    const largest = [...this.#byDirectory].sort((left, right) => right[1] - left[1]).slice(0, LARGEST_NAMED);
    const named = largest.length ? ` Largest so far: ${largest.map(([directory, files]) => `${directory} (${files}+)`).join(", ")}.` : "";
    const exclude = largest[0] ? `, exclude a directory (e.g. -g '!${largest[0][0]}/**')` : "";
    return `wb rg: stopped before searching after enumerating more than ${this.limit} files.${named}`
      + ` Narrow the path${exclude}, or raise --max-files (0 = unlimited).`;
  }
}

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

/** Directory reads in flight at once; a walk is bound by filesystem latency, not CPU. */
const WALK_CONCURRENCY = 16;

/**
 * Lists files beneath `root`, reading up to `WALK_CONCURRENCY` directories at once; callers sort, so visit order is free.
 * Directories the pruner rejects, by cwd-relative display path, are never read; files are filtered after, but every file
 * read counts against the budget, since reading them is the cost.
 */
async function walkDirectory(root: string, options: {
  budget: FileBudget;
  displayRoot: string;
  hidden: boolean;
  maxDepth: number | null;
  prune: RipgrepDirectoryPruner;
  skipNodeModules: boolean;
  warnings: string[];
  signal: AbortSignal;
}) {
  const files: string[] = [];
  const skipped: string[] = [];
  const pending: Array<{ relative: string; depth: number }> = [{ relative: "", depth: 0 }];
  const visit = async ({ relative, depth }: { relative: string; depth: number }) => {
    options.signal.throwIfAborted();
    let entries;
    try {
      entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
    } catch (error) {
      if (!SKIPPED_ACCESS_CODES.has(errorCode(error) ?? "")) throw error;
      skipped.push(`wb rg: ${path.join(root, relative)}: ${errorCode(error)} (directory skipped)`);
      return;
    }
    const childDepth = depth + 1;
    if (options.maxDepth !== null && childDepth > options.maxDepth) return;
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (!options.hidden && entry.name.startsWith(".")) continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === ".git" || (options.skipNodeModules && entry.name === "node_modules")) continue;
        if (options.prune(options.displayRoot === "." ? child : `${options.displayRoot}/${child}`)) continue;
        pending.push({ relative: child, depth: childDepth });
      } else if (entry.isFile()) {
        options.budget.count(options.displayRoot, child);
        files.push(child);
      }
    }
  };
  await new Promise<void>((resolve, reject) => {
    let active = 0;
    let failed = false;
    const pump = () => {
      if (failed) return;
      if (!pending.length && !active) resolve();
      while (active < WALK_CONCURRENCY && pending.length) {
        active += 1;
        visit(pending.pop()!).then(() => {
          active -= 1;
          pump();
        }, (error: unknown) => {
          failed = true;
          reject(error);
        });
      }
    };
    pump();
  });
  options.warnings.push(...skipped.sort());
  return files;
}

/** Fetches lazily loaded content under one existing root in bulk before it is walked and read. */
export type RipgrepHydrate = (absolutePath: string, signal: AbortSignal) => Promise<void>;

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 300);
}

function queryRoots(query: RipgrepQuery) {
  return query.paths.length ? query.paths : ["."];
}

async function statRoot(absoluteRoot: string) {
  try {
    return await fs.stat(absoluteRoot);
  } catch (error) {
    if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") throw error;
    return null;
  }
}

/**
 * Hydrates each existing query root in order; returns the warning for each root whose prefetch failed. Runs where the
 * hydrate owner lives, before candidates are collected elsewhere.
 */
export async function prefetchRipgrepRoots(query: RipgrepQuery, cwd: string, signal: AbortSignal, hydrate: RipgrepHydrate) {
  const warnings: Record<string, string> = {};
  for (const root of queryRoots(query)) {
    signal.throwIfAborted();
    const absoluteRoot = path.resolve(cwd, root);
    if (!await statRoot(absoluteRoot)) continue;
    try {
      await hydrate(absoluteRoot, signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      // Collection still loads content lazily, only slower.
      warnings[root] = `wb rg: ${root}: repository prefetch failed: ${errorMessage(error)}`;
    }
  }
  return warnings;
}

/**
 * `prefetchWarnings` (from `prefetchRipgrepRoots`) are reported in root order beside collection's own warnings. Throws
 * `RipgrepFileBudgetExceeded` once the query enumerates more than `maxFiles` files.
 */
export async function collectRipgrepCandidates(
  query: RipgrepQuery, cwd: string, signal: AbortSignal, prefetchWarnings: Readonly<Record<string, string>> = {},
): Promise<RipgrepCandidates> {
  const passesFilters = createRipgrepPathFilter(query);
  const prune = createRipgrepDirectoryPruner(query.globs);
  const budget = new FileBudget(query.maxFiles);
  const files = new Map<string, RipgrepCandidate>();
  const warnings: string[] = [];
  let searchedRoots = 0;
  for (const root of queryRoots(query)) {
    signal.throwIfAborted();
    const absoluteRoot = path.resolve(cwd, root);
    const stats = await statRoot(absoluteRoot);
    if (!stats) {
      warnings.push(`wb rg: ${root}: path not found`);
      continue;
    }
    searchedRoots += 1;
    if (prefetchWarnings[root]) warnings.push(prefetchWarnings[root]);
    const isDirectory = stats.isDirectory();
    const directory = isDirectory ? absoluteRoot : path.dirname(absoluteRoot);
    const displayRoot = displayPathFor(cwd, absoluteRoot);
    let walked = false;
    let relatives = query.noIgnore
      ? null
      : await listGitVisibleFiles(directory, isDirectory ? [] : [path.basename(absoluteRoot)], signal);
    if (relatives === null) {
      walked = isDirectory;
      relatives = isDirectory
        ? await walkDirectory(absoluteRoot, {
          budget,
          displayRoot,
          hidden: query.hidden,
          maxDepth: query.maxDepth,
          prune,
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
      // A Git listing is cheap, so only the files it would have searched count.
      if (isDirectory && !walked) budget.count(displayRoot, relative);
      files.set(absolutePath, { displayPath, absolutePath });
    }
  }
  return {
    files: [...files.values()].sort((left, right) => left.displayPath < right.displayPath ? -1 : left.displayPath > right.displayPath ? 1 : 0),
    searchedRoots,
    warnings,
  };
}
