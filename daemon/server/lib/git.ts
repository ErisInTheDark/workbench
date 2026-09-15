/*
 * Exports:
 * - getGitChanges: summarise tracked and untracked project changes for the explorer.
 * - getHeadFileContent: read a tracked file from HEAD when available.
 * - listGitVisibleFiles: list tracked and non-ignored untracked paths, optionally narrowed by Git pathspecs.
 * - isGitTrackedFile: report whether Git tracks a project-relative path in its index.
 * - resolveGitDirectory: resolve ordinary and file-backed Git metadata directories.
 * - isLinkedGitWorktree: distinguish shared worktree metadata from independent Git directories.
 * - readGitProjectMetadata: read local origin identity and worktree classification without network access.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import type { ChangeSummary } from "workbench-shared/types";

const execFileAsync = promisify(execFile);
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
  return execFileAsync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    signal,
  });
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
  if (marker.isDirectory()) return markerPath;
  if (!marker.isFile()) return null;
  const contents = await fs.readFile(markerPath, "utf8");
  const match = /^gitdir:\s*(.+)\s*$/imu.exec(contents);
  if (!match) throw new Error("Git directory marker is invalid.");
  return path.resolve(rootDir, match[1]!.trim());
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

export async function isLinkedGitWorktree(rootDir: string) {
  const gitDirectory = await resolveGitDirectory(rootDir);
  return gitDirectory !== null && await hasSharedGitDirectory(gitDirectory);
}

export async function readGitProjectMetadata(rootDir: string, signal?: AbortSignal): Promise<{
  origin: string | null;
  linkedWorktree: boolean;
} | null> {
  signal?.throwIfAborted();
  const gitDirectory = await resolveGitDirectory(rootDir);
  if (gitDirectory === null) return null;
  if (await hasSharedGitDirectory(gitDirectory)) return { origin: null, linkedWorktree: true };
  const configPath = path.join(gitDirectory, "config");
  let origin: string;
  try {
    origin = (await runGit(rootDir, ["config", "--file", configPath, "--no-includes", "--get", "remote.origin.url"], signal)).stdout.trim();
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    if (String(failure.code) === "1" && !failure.stderr?.trim()) return { origin: null, linkedWorktree: false };
    throw error;
  }
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
  return { origin, linkedWorktree: false };
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

export async function getGitChanges(rootDir: string): Promise<Record<string, ChangeSummary>> {
  const changes = new Map<string, ChangeSummary>();
  const diffArgs = (await hasHeadCommit(rootDir))
    ? ["diff", "--numstat", "HEAD", "--"]
    : ["diff", "--numstat", "--"];

  try {
    const { stdout } = await runGit(rootDir, diffArgs);

    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }

      const parts = line.split("\t");
      if (parts.length < 3) {
        continue;
      }

      const additions = Number.parseInt(parts[0], 10) || 0;
      const deletions = Number.parseInt(parts[1], 10) || 0;
      const filePath = normalizeDiffPath(parts.slice(2).join("\t"));

      if (!isVisibleGitPath(filePath)) {
        continue;
      }

      mergeChange(changes, filePath, additions, deletions);
    }
  } catch {
    return {};
  }

  try {
    const { stdout } = await runGit(rootDir, ["ls-files", "--others", "--exclude-standard", "--"]);

    for (const line of stdout.split(/\r?\n/)) {
      const filePath = line.trim().replace(/\\/g, "/");
      if (!isVisibleGitPath(filePath)) {
        continue;
      }

      const absolutePath = path.resolve(rootDir, filePath);

      try {
        const contents = await fs.readFile(absolutePath, "utf8");
        mergeChange(changes, filePath, countLines(contents), 0);
      } catch {
        mergeChange(changes, filePath, 1, 0);
      }
    }
  } catch {
    return Object.fromEntries(changes);
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
