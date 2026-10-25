/*
 * Exports:
 * - defaultMachineGitBase: data-root folder holding machine Git dirs.
 * - machineGitEnvironment: GIT_DIR/GIT_WORK_TREE plus no line ending conversion for an exact registered machine worktree root, else none.
 * - isMachineGitWorktree: whether a root is a registered machine worktree.
 * - ensureMachineGitWorktree: create (once) and register a machine worktree's internal Git dir with an empty root commit.
 * - readMachineKnownPaths: repository paths any arc has requested on a machine worktree.
 * - recordMachineKnownPaths: remember requested paths so snapshots include them once they exist, though untracked.
 * - listMachineGitWorktreeRoots: filesystem roots that already have machine Git dirs under a base.
 * Machine worktrees are filesystem roots whose Git state lives under the data root, never on the machine itself.
 * Registration is per daemon generation: arc project resolution re-ensures roots before any Git work reaches them,
 * and an unregistered root simply reads as "not a git repository".
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import resolveWorkbenchDataRoot from "workbench-shared/workbench-data-root";

import { comparablePath as comparable } from "../../comparable-path";
import { gitProcesses } from "./GitProcessHost";

const KNOWN_PATHS_FILE = "workbench-known-paths";
const registered = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

const MACHINE_IDENTITY = {
  GIT_AUTHOR_NAME: "Workbench", GIT_AUTHOR_EMAIL: "workbench@localhost",
  GIT_COMMITTER_NAME: "Workbench", GIT_COMMITTER_EMAIL: "workbench@localhost",
};

function isFilesystemRoot(root: string) {
  const resolved = path.resolve(root);
  return path.parse(resolved).root === resolved;
}

/** Drive roots use their letter, the posix root `root`; anything else (tests) a stable path hash. */
function slug(root: string) {
  const resolved = path.resolve(root);
  if (isFilesystemRoot(resolved)) return /^[a-z]:/iu.test(resolved) ? resolved[0]!.toLowerCase() : "root";
  return `dir-${createHash("sha256").update(comparable(resolved)).digest("hex").slice(0, 16)}`;
}

function rootForSlug(name: string) {
  if (name === "root") return process.platform === "win32" ? null : "/";
  return process.platform === "win32" && /^[a-z]$/u.test(name) ? `${name.toUpperCase()}:\\` : null;
}

async function exists(target: string) {
  try {
    await fs.stat(target);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export function defaultMachineGitBase() {
  return path.join(resolveWorkbenchDataRoot(), "daemon", "machine-git");
}

export function machineGitEnvironment(root: string): Record<string, string> {
  const gitDir = registered.get(comparable(root));
  // Machine files are stored byte-exact; Git for Windows' system-wide autocrlf would otherwise rewrite them on restore.
  return gitDir ? {
    GIT_DIR: gitDir, GIT_WORK_TREE: path.resolve(root),
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.autocrlf", GIT_CONFIG_VALUE_0: "false",
  } : {};
}

export function isMachineGitWorktree(root: string) {
  return registered.has(comparable(root));
}

async function git(args: string[], cwd: string, env: Record<string, string>, input?: string) {
  return await gitProcesses.runText({ args, cwd, env: { ...process.env, ...env }, ...(input !== undefined ? { input } : {}) });
}

/** Builds the Git dir beside its final location, then renames it in, so a concurrent ensure never sees half a repository. */
async function initialise(worktree: string, gitDir: string) {
  const base = path.dirname(gitDir);
  await fs.mkdir(base, { recursive: true });
  const staging = path.join(base, `.init-${randomUUID()}.git`);
  try {
    await git(["init", "--bare", "--quiet", staging], base, {});
    const env = { GIT_DIR: staging };
    await git(["config", "core.bare", "false"], base, env);
    await git(["config", "core.worktree", worktree.replace(/\\/gu, "/")], base, env);
    // The user's global ignore rules target their repositories; on the machine they would hide claimable files.
    await git(["config", "core.excludesFile", path.join(gitDir, "info", "exclude").replace(/\\/gu, "/")], base, env);
    if (process.platform === "win32") await git(["config", "core.longpaths", "true"], base, env);
    const emptyTree = (await git(["mktree"], base, env, "")).trim();
    const root = (await git(["commit-tree", emptyTree, "-m", "machine baseline"], base, { ...env, ...MACHINE_IDENTITY })).trim();
    await git(["update-ref", "HEAD", root], base, env);
    try {
      await fs.rename(staging, gitDir);
    } catch (error) {
      if (!await exists(path.join(gitDir, "HEAD"))) throw error;
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

export async function ensureMachineGitWorktree(root: string, base = defaultMachineGitBase()) {
  const worktree = path.resolve(root);
  const key = comparable(worktree);
  const known = registered.get(key);
  if (known) return known;
  let ensured = pending.get(key);
  if (!ensured) {
    ensured = (async () => {
      if (await exists(path.join(worktree, ".git"))) throw new Error(`${worktree} is already a Git repository; it cannot back machine Git arcs.`);
      const gitDir = path.join(base, `${slug(worktree)}.git`);
      if (!await exists(path.join(gitDir, "HEAD"))) await initialise(worktree, gitDir);
      registered.set(key, gitDir);
      return gitDir;
    })().finally(() => pending.delete(key));
    pending.set(key, ensured);
  }
  return await ensured;
}

function knownPathsFile(root: string) {
  const gitDir = registered.get(comparable(root));
  return gitDir ? path.join(gitDir, "info", KNOWN_PATHS_FILE) : null;
}

/** Repository paths any arc has requested on a machine worktree; untracked ones still belong in snapshots. */
export async function readMachineKnownPaths(root: string) {
  const file = knownPathsFile(root);
  if (!file) return [];
  try {
    return (await fs.readFile(file, "utf8")).split("\0").filter(Boolean);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export async function recordMachineKnownPaths(root: string, paths: readonly string[]) {
  const file = knownPathsFile(root);
  if (!file || !paths.length) return;
  const known = new Set(await readMachineKnownPaths(root));
  const before = known.size;
  for (const candidate of paths) known.add(candidate);
  if (known.size === before) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const staging = `${file}.${randomUUID()}`;
  await fs.writeFile(staging, [...known].sort((left, right) => left.localeCompare(right)).join("\0"), "utf8");
  await fs.rename(staging, file);
}

export async function listMachineGitWorktreeRoots(base = defaultMachineGitBase()) {
  let names: string[];
  try {
    names = await fs.readdir(base);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return names.flatMap((name) => {
    const match = /^(.+)\.git$/u.exec(name);
    const root = match ? rootForSlug(match[1]!) : null;
    return root ? [root] : [];
  });
}
