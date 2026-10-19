/*
 * Exports:
 * - getGitChanges: summarise tracked and untracked project changes for the explorer without writing the index.
 * - getHeadFileContent: read a tracked file from HEAD when available.
 * - listGitVisibleFiles: list tracked and non-ignored untracked paths, optionally narrowed by Git pathspecs.
 * - isGitTrackedFile: report whether Git tracks a project-relative path in its index.
 * - resolveGitDirectory: resolve ordinary and file-backed Git metadata directories.
 * - isLinkedGitWorktree: distinguish shared worktree metadata from independent Git directories.
 * - readRegisteredGitWorktrees: list concrete worktrees registered by one repository, from Git's metadata files.
 * - readGitProjectMetadata: read local origin identity and worktree classification without network access or a subprocess.
 * - readGitConfigValue: read one value from Git config text the way `git config --no-includes --get` does.
 * - initGitRepository: create an empty Git repository in an existing folder.
 * - syncGitInfoExclude: replace one owner's block of exact root-anchored paths in the repository's `info/exclude`, keeping other lines.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ChangeSummary } from "workbench-shared/types";
import { gitProcesses } from "./workbench/git/GitProcessHost";

const ignoredNames = new Set([".git", ".codex", ".vscode", ".workbench", "node_modules", ".next"]);
const notGitRepositoryMessage = "fatal: not a git repository";

function normalizeDiffPath(rawPath: string) {
  let normalized = rawPath.trim();

  const braceRename = normalized.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (braceRename) {
    normalized = `${braceRename[1]}${braceRename[3]}${braceRename[4]}`;
  } else if (normalized.includes(" => ")) {
    normalized = normalized.split(" => ").at(-1)!;
  }

  return normalized.replace(/\\/g, "/");
}

function mergeChange(
  map: Map<string, ChangeSummary>,
  filePath: string,
  additions: number,
  deletions: number,
) {
  const existing = map.get(filePath) ?? { additions: 0, deletions: 0 };
  existing.additions += additions;
  existing.deletions += deletions;
  map.set(filePath, existing);
}

function countLines(contents: string) {
  if (!contents) {
    return 0;
  }

  return contents.split(/\r?\n/).length;
}

async function runGit(rootDir: string, args: string[], signal?: AbortSignal) {
  const { stdout, stderr } = await gitProcesses.run({
    args,
    cwd: rootDir,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    maxBuffer: 4 * 1024 * 1024,
    ...(signal ? { signal } : {}),
  });
  return { stdout: stdout.toString("utf8"), stderr };
}

export async function initGitRepository(rootDir: string) {
  await runGit(rootDir, ["init"]);
}

function exactExcludePattern(relativePath: string) {
  if (/[\r\n]/u.test(relativePath)) throw new Error(`Git exclude paths cannot contain line breaks: ${JSON.stringify(relativePath)}`);
  const escaped = relativePath.replace(/\\/gu, "/").replace(/^\/+/u, "").replace(/[\\*?[\]!#]/gu, "\\$&");
  return `/${escaped.replace(/ +$/u, spaces => "\\ ".repeat(spaces.length))}`;
}

/** Repositories without their own Git directory are left alone; the file is rewritten only when its content changes. */
export async function syncGitInfoExclude(rootDir: string, owner: string, relativePaths: readonly string[]) {
  const gitDirectory = await resolveGitDirectory(rootDir);
  if (!gitDirectory) return;
  const excludePath = path.join(await commonGitDirectory(gitDirectory), "info", "exclude");
  const current = await readOptionalFile(excludePath) ?? "";
  const begin = `# >>> ${owner} (managed by Workbench)`;
  const end = `# <<< ${owner}`;
  const kept: string[] = [];
  const lines = current.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== begin) {
      kept.push(lines[index]!);
      continue;
    }
    const close = lines.indexOf(end, index + 1);
    // An unterminated marker drops only itself, so no user line is ever discarded.
    if (close !== -1) index = close;
  }
  while (kept.length && !kept.at(-1)!.trim()) kept.pop();
  const block = relativePaths.length
    ? [begin, ...[...new Set(relativePaths.map(exactExcludePattern))].sort(), end]
    : [];
  const next = [...kept, ...kept.length && block.length ? [""] : [], ...block].join("\n");
  const content = next ? `${next}\n` : "";
  if (content === current) return;
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  await fs.writeFile(excludePath, content, "utf8");
}

export async function resolveGitDirectory(rootDir: string): Promise<string | null> {
  const markerPath = path.join(rootDir, ".git");
  let marker;
  try {
    marker = await fs.lstat(markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let gitDirectory: string;
  if (marker.isDirectory()) gitDirectory = markerPath;
  else {
    if (!marker.isFile()) return null;
    const contents = await fs.readFile(markerPath, "utf8");
    const match = /^gitdir:\s*(.+)\s*$/imu.exec(contents);
    if (!match) throw new Error("Git directory marker is invalid.");
    gitDirectory = path.resolve(rootDir, match[1]!.trim());
  }
  try {
    // Git init creates HEAD before the first commit; the referenced branch need not exist.
    return (await fs.stat(path.join(gitDirectory, "HEAD"))).isFile() ? gitDirectory : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function hasSharedGitDirectory(gitDirectory: string) {
  let commonDirectory: string;
  try {
    commonDirectory = (await fs.readFile(path.join(gitDirectory, "commondir"), "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!commonDirectory) throw new Error("Git common directory marker is empty.");
  const [own, common] = await Promise.all([
    fs.realpath(gitDirectory),
    fs.realpath(path.resolve(gitDirectory, commonDirectory)),
  ]);
  return process.platform === "win32" ? own.toLowerCase() !== common.toLowerCase() : own !== common;
}

async function commonGitDirectory(gitDirectory: string) {
  let relative: string;
  try {
    relative = (await fs.readFile(path.join(gitDirectory, "commondir"), "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return await fs.realpath(gitDirectory);
    throw error;
  }
  if (!relative) throw new Error("Git common directory marker is empty.");
  return await fs.realpath(path.resolve(gitDirectory, relative));
}

async function readOptionalFile(filePath: string) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw error;
  }
}

/**
 * Reads registered worktrees from Git's own metadata files, the same set `git worktree list` prints, without a
 * subprocess. Layouts it cannot read directly (bare or separated main Git directories) fall back to Git itself.
 */
export async function readRegisteredGitWorktrees(rootDir: string, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  const gitDirectory = await resolveGitDirectory(rootDir);
  const shared = gitDirectory ? await commonGitDirectory(gitDirectory) : null;
  const config = shared ? await readOptionalFile(path.join(shared, "config")) : null;
  if (!shared || path.basename(shared).toLowerCase() !== ".git" || config === null
    || readGitConfigValue(config, "core", null, "bare") === "true" || readGitConfigValue(config, "core", null, "worktree") !== null) {
    const { stdout } = await runGit(rootDir, ["worktree", "list", "--porcelain", "-z"], signal);
    return stdout.split("\0")
      .filter(item => item.startsWith("worktree "))
      .map(item => path.resolve(item.slice("worktree ".length)));
  }
  const worktrees = [path.dirname(shared)];
  let names: string[];
  try {
    names = await fs.readdir(path.join(shared, "worktrees"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return worktrees;
    throw error;
  }
  for (const name of names.sort()) {
    const marker = (await readOptionalFile(path.join(shared, "worktrees", name, "gitdir")))?.trim();
    if (marker) worktrees.push(path.dirname(path.resolve(shared, "worktrees", name, marker)));
  }
  return worktrees;
}

/** One value from Git config text with `--no-includes` semantics; the last assignment wins, like `git config --get`. */
export function readGitConfigValue(text: string, section: string, subsection: string | null, key: string) {
  let inSection = false;
  let sectionSeen = false;
  let value: string | null = null;
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index]!.trimStart();
    const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/u.exec(line);
    if (header) {
      const [name, dotted] = header[1]!.split(/\.(.*)/u);
      const headerSubsection = header[2] !== undefined ? header[2].replace(/\\(.)/gu, "$1") : dotted?.toLowerCase() ?? null;
      inSection = name!.toLowerCase() === section.toLowerCase() && headerSubsection === subsection;
      sectionSeen = true;
      line = line.slice(header[0].length).trimStart();
    }
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const assignment = /^([A-Za-z][A-Za-z0-9-]*)\s*(=\s*(.*))?$/u.exec(line);
    // Git itself refuses malformed files rather than guessing; identity derived from one must fail too.
    if (!assignment || !sectionSeen) throw new Error(`Git config is malformed at line ${index + 1}.`);
    let raw = assignment[3] ?? null;
    while (raw !== null && /(^|[^\\])(\\\\)*\\$/u.test(raw) && index + 1 < lines.length) raw = raw.slice(0, -1) + lines[++index]!;
    if (!inSection || assignment[1]!.toLowerCase() !== key.toLowerCase()) continue;
    value = raw === null ? "true" : parseGitConfigText(raw);
  }
  return value;
}

function parseGitConfigText(raw: string) {
  let value = "";
  let quoted = false;
  let pendingSpace = "";
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (character === "\\") {
      const next = raw[++index];
      const escaped = next === "n" ? "\n" : next === "t" ? "\t" : next === "b" ? "\b" : next ?? "";
      value += pendingSpace + escaped;
      pendingSpace = "";
    } else if (character === "\"") {
      value += pendingSpace;
      pendingSpace = "";
      quoted = !quoted;
    } else if (!quoted && (character === "#" || character === ";")) {
      break;
    } else if (!quoted && /\s/u.test(character)) {
      if (value) pendingSpace += character;
    } else {
      value += pendingSpace + character;
      pendingSpace = "";
    }
  }
  return value;
}

export async function isLinkedGitWorktree(rootDir: string) {
  const gitDirectory = await resolveGitDirectory(rootDir);
  return gitDirectory !== null && await hasSharedGitDirectory(gitDirectory);
}

export async function readGitProjectMetadata(rootDir: string, signal?: AbortSignal): Promise<{
  origin: string | null;
  linkedWorktree: boolean;
  commonGitDirectory: string;
} | null> {
  signal?.throwIfAborted();
  const gitDirectory = await resolveGitDirectory(rootDir);
  if (gitDirectory === null) return null;
  const sharedDirectory = await commonGitDirectory(gitDirectory);
  const linkedWorktree = await hasSharedGitDirectory(gitDirectory);
  const config = await readOptionalFile(path.join(sharedDirectory, "config"));
  signal?.throwIfAborted();
  let origin = config === null ? null : readGitConfigValue(config, "remote", "origin", "url")?.trim() ?? null;
  if (origin === null) return { origin: null, linkedWorktree, commonGitDirectory: sharedDirectory };
  if (!origin) throw new Error("Git origin is empty.");
  if (!origin.includes("://") && origin.includes("::")) {
    throw new Error("Git origin uses an unsupported remote helper.");
  }
  const localOrigin = path.isAbsolute(origin) || (!origin.includes("://") && !/^[^/:\s]+:[^:]/u.test(origin));
  if (localOrigin) {
    let location = path.resolve(rootDir, origin);
    try {
      location = await fs.realpath(location);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    origin = pathToFileURL(location).href;
  }
  return { origin, linkedWorktree, commonGitDirectory: sharedDirectory };
}

async function hasHeadCommit(rootDir: string) {
  try {
    await runGit(rootDir, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

function isVisibleGitPath(filePath: string) {
  return filePath && !filePath.split("/").some((segment) => ignoredNames.has(segment));
}

/**
 * Porcelain `git diff` refreshes stat info by taking the real index lock whenever it meets stat-dirty files, and
 * GIT_OPTIONAL_LOCKS does not stop it. So counts come from a non-refreshing diff, which also lists stat-only files,
 * while lock-free `status` supplies the real changed and untracked sets.
 */
export async function getGitChanges(rootDir: string): Promise<Record<string, ChangeSummary>> {
  const changes = new Map<string, ChangeSummary>();
  // Unquoted paths so non-ASCII names match the NUL-separated status set.
  const diffArgs = [
    "-c", "diff.autoRefreshIndex=false", "-c", "core.quotePath=false", "diff", "--numstat",
    ...await hasHeadCommit(rootDir) ? ["HEAD"] : [], "--",
  ];

  let changedPaths: Set<string>;
  const untrackedPaths: string[] = [];
  let numstat: string;
  try {
    const [status, diff] = await Promise.all([
      runGit(rootDir, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]),
      runGit(rootDir, diffArgs),
    ]);
    changedPaths = new Set();
    for (const entry of status.stdout.split("\0")) {
      if (entry.length < 4) continue;
      const filePath = entry.slice(3);
      if (entry.startsWith("?? ")) untrackedPaths.push(filePath);
      else changedPaths.add(filePath);
    }
    numstat = diff.stdout;
  } catch {
    return {};
  }

  for (const line of numstat.split(/\r?\n/)) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const filePath = normalizeDiffPath(parts.slice(2).join("\t"));
    if (!changedPaths.has(filePath) || !isVisibleGitPath(filePath)) continue;
    mergeChange(changes, filePath, Number.parseInt(parts[0], 10) || 0, Number.parseInt(parts[1], 10) || 0);
  }

  for (const filePath of untrackedPaths) {
    if (!isVisibleGitPath(filePath)) continue;
    try {
      const contents = await fs.readFile(path.resolve(rootDir, filePath), "utf8");
      mergeChange(changes, filePath, countLines(contents), 0);
    } catch {
      mergeChange(changes, filePath, 1, 0);
    }
  }

  return Object.fromEntries(changes);
}

export async function getHeadFileContent(rootDir: string, filePath: string): Promise<string | null> {
  if (!(await hasHeadCommit(rootDir))) {
    return null;
  }

  try {
    const { stdout } = await runGit(rootDir, ["show", `HEAD:${filePath.replace(/\\/g, "/")}`]);
    return stdout;
  } catch {
    return null;
  }
}

export async function listGitVisibleFiles(rootDir: string, pathspecs: readonly string[] = [], signal?: AbortSignal) {
  let stdout: string;
  try {
    ({ stdout } = await runGit(rootDir, [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...pathspecs,
    ], signal));
  } catch (error) {
    if (error instanceof Error && error.message.includes(notGitRepositoryMessage)) {
      return [];
    }
    throw error;
  }

  return Array.from(new Set(
    stdout
      .split("\0")
      .map((filePath) => filePath.replace(/\\/gu, "/"))
      .filter(Boolean),
  ));
}

export async function isGitTrackedFile(rootDir: string, filePath: string) {
  try {
    await runGit(rootDir, ["ls-files", "--error-unmatch", "--", filePath.replace(/\\/g, "/")]);
    return true;
  } catch {
    return false;
  }
}
